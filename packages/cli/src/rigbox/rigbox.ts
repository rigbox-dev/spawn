// rigbox/rigbox.ts — Rigbox cloud provider: API client + workspace lifecycle + SSH runner.
//
// Rigbox is a managed Firecracker host (https://rigbox.dev). The cloud
// orchestrator side here only needs to:
//
//   1. Authenticate the spawn user via `rig login`. Checks `rig whoami`
//      first; if already authed, returns immediately. Otherwise drives
//      the NDJSON browser login event stream from `rig login` and renders
//      events into spawn's UI. rig persists the API key.
//
//   2. `POST /v1/workspaces { catalog_ids: ["<recipe>"] }` to provision
//      a Firecracker VM with the agent's install baked in, then poll
//      `GET /v1/workspaces/{id}` until status=running.
//
//   3. Inject the user's OpenRouter API key into the workspace env via
//      `POST /v1/workspaces/{id}/env` so the agent's profile.d shim
//      picks it up. `--managed` swaps this for
//      `PUT /v1/workspaces/{id}/ai-config { mode: "managed" }`.
//
//   4. Drive SSH region-direct: `<workspace>-<id-suffix>@<region>.rigbox.dev`
//      (override via RIGBOX_SSH_HOST).

import type { VMConnection } from "../history.js";

import { existsSync } from "node:fs";
import { join } from "node:path";
import { parseJsonWith } from "@openrouter/spawn-shared";
import * as v from "valibot";
import { getUserHome } from "../shared/paths.js";
import { asyncTryCatch } from "../shared/result.js";
import { SSH_BASE_OPTS, SSH_INTERACTIVE_OPTS, spawnInteractive, validateRemotePath } from "../shared/ssh.js";
import { ensureSshKeys, getSshKeyOpts } from "../shared/ssh-keys.js";
import {
  getServerNameFromEnv,
  logInfo,
  logStep,
  logStepDone,
  logWarn,
  promptSpawnNameShared,
  sanitizeTermValue,
  shellQuote,
} from "../shared/ui.js";
import { checkRigVersion, runRig, streamRig, WhoamiSchema } from "./rig-runner.js";

// ── Configurable knobs ──────────────────────────────────────────────

const RIGBOX_API_URL = process.env.RIGBOX_API_URL || "https://api.rigbox.dev/v1";

// Region-direct SSH host. Override with RIGBOX_SSH_HOST when running
// against a different region.
const RIGBOX_SSH_HOST = process.env.RIGBOX_SSH_HOST || "eu-west-1.rigbox.dev";

const CREATE_POLL_INTERVAL_MS = 2000;
const CREATE_POLL_TIMEOUT_MS = 5 * 60 * 1000; // 5 min

// ── Module state ────────────────────────────────────────────────────

interface RigboxState {
  workspaceId: string;
  workspaceName: string;
  /** Region-direct SSH host (e.g. `eu-west-1.rigbox.dev`). */
  sshHost: string;
  /** True when the user passed --managed (vs the default forwarded-key flow). */
  managedMode: boolean;
}

const _state: RigboxState = {
  workspaceId: "",
  workspaceName: "",
  sshHost: RIGBOX_SSH_HOST,
  managedMode: false,
};

// ── Response schemas ─────────────────────────────────────────────────

const WorkspaceSchema = v.object({
  id: v.string(),
  name: v.string(),
  status: v.string(),
  ip_address: v.optional(v.nullable(v.string())),
});

const WorkspaceResponseSchema = v.object({
  vm: WorkspaceSchema,
});

const WorkspaceListSchema = v.object({
  vms: v.array(WorkspaceSchema),
});

/** Subset of /v1/apps fields spawn uses for install-readiness polling.
 * `status` transitions installing → active when the catalog install
 * script exits 0, or → error if it fails. */
const AppRowSchema = v.looseObject({
  id: v.string(),
  name: v.string(),
  status: v.string(),
});

const AppListSchema = v.object({
  apps: v.array(AppRowSchema),
});

/** Subset of /v1/app-catalog item fields spawn cares about — `looseObject`
 * keeps every other field the API returns from being a validation error
 * as the schema evolves. */
const CatalogItemSchema = v.looseObject({
  id: v.string(),
  min_ram_mb: v.number(),
  min_disk_mb: v.number(),
});

const CatalogResponseSchema = v.object({
  items: v.array(CatalogItemSchema),
});

/** Headroom added on top of each recipe's declared minima — matches the
 * server's validate_catalog_ids reserve so the workspace boots the base
 * image's own services without bumping into the limit. */
const SIZE_HEADROOM_MB = 256;

type WorkspaceResponse = v.InferOutput<typeof WorkspaceResponseSchema>;
type WorkspaceList = v.InferOutput<typeof WorkspaceListSchema>;

// ── Helpers ─────────────────────────────────────────────────────────

function authHeaders(): Record<string, string> {
  // TODO(Task 8+9): apiCall/apiCallVoid are replaced by runRig/streamRig;
  // delete authHeaders once createWorkspace, env, and AI-mode are migrated.
  throw new Error(
    "authHeaders() is no longer valid — direct API calls are being replaced by `rig` CLI delegation. " +
      "This is a Task 8/9 migration marker.",
  );
}

async function apiCall<S extends v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>>>(
  method: string,
  path: string,
  schema: S,
  body?: unknown,
): Promise<v.InferOutput<S>> {
  const url = `${RIGBOX_API_URL}${path}`;
  const opts: RequestInit = {
    method,
    headers: authHeaders(),
  };
  if (body !== undefined) {
    opts.body = JSON.stringify(body);
  }
  const resp = await fetch(url, opts);
  const textResult = await asyncTryCatch(() => resp.text());
  const text = textResult.ok ? textResult.data : "";
  if (!resp.ok) {
    throw new Error(`Rigbox API ${method} ${path} → ${resp.status}: ${text.slice(0, 256)}`);
  }
  const parsed = parseJsonWith(text, schema);
  if (parsed === null) {
    throw new Error(`Rigbox API ${method} ${path} returned an unexpected payload shape: ${text.slice(0, 256)}`);
  }
  return parsed;
}

/** apiCall variant for endpoints that don't return a body (e.g. POST /env, DELETE). */
async function apiCallVoid(method: string, path: string, body?: unknown): Promise<void> {
  const url = `${RIGBOX_API_URL}${path}`;
  const opts: RequestInit = {
    method,
    headers: authHeaders(),
  };
  if (body !== undefined) {
    opts.body = JSON.stringify(body);
  }
  const resp = await fetch(url, opts);
  if (!resp.ok) {
    const textResult = await asyncTryCatch(() => resp.text());
    const text = textResult.ok ? textResult.data : "";
    throw new Error(`Rigbox API ${method} ${path} → ${resp.status}: ${text.slice(0, 256)}`);
  }
}

/**
 * Build the canonical SSH username for a Rigbox workspace. Format:
 * `<normalized-name>-<id-suffix>` where `<id-suffix>` is the workspace
 * ID with the `ws-` prefix stripped.
 */
function buildSshUser(workspaceName: string, workspaceId: string): string {
  const suffix = workspaceId.startsWith("ws-") ? workspaceId.slice(3) : workspaceId;
  const normalized =
    workspaceName
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-+|-+$/g, "") || "workspace";
  return suffix ? `${normalized}-${suffix}` : normalized;
}

// ── Rig CLI auto-install ────────────────────────────────────────────

const RIG_INSTALL_URL = "https://rigbox.dev/install.sh";

/** Resolve the path to a usable `rig` binary, or null if unavailable. */
function getRigCmd(): string | null {
  const which = Bun.spawnSync(
    [
      "sh",
      "-c",
      "command -v rig",
    ],
    {
      stdio: [
        "ignore",
        "pipe",
        "ignore",
      ],
    },
  );
  if (which.exitCode === 0) {
    const out = new TextDecoder().decode(which.stdout).trim();
    if (out.length > 0) {
      return out;
    }
  }
  const candidates = [
    join(getUserHome(), ".local", "bin", "rig"),
    "/usr/local/bin/rig",
    "/opt/homebrew/bin/rig",
  ];
  for (const c of candidates) {
    if (existsSync(c)) {
      return c;
    }
  }
  return null;
}

export async function ensureRigCli(): Promise<void> {
  if (getRigCmd()) {
    return;
  }
  if (process.env.SPAWN_NON_INTERACTIVE === "1") {
    throw new Error(
      "rig CLI not found. spawn-rigbox requires `rig`. " + "Install: curl -fsSL https://rigbox.dev/install.sh | sh",
    );
  }
  logStep("Installing rig CLI...");
  const proc = Bun.spawn(
    [
      "sh",
      "-c",
      `curl -fsSL --proto '=https' ${RIG_INSTALL_URL} | sh`,
    ],
    {
      stdio: [
        "ignore",
        "inherit",
        "inherit",
      ],
    },
  );
  if ((await proc.exited) !== 0) {
    throw new Error("rig CLI install failed");
  }
  const localBin = join(getUserHome(), ".local", "bin");
  if (!process.env.PATH?.split(":").includes(localBin)) {
    process.env.PATH = `${localBin}:${process.env.PATH ?? ""}`;
  }
  if (!getRigCmd()) {
    throw new Error(`rig CLI installed but not on PATH. Add: export PATH="${localBin}:$PATH"`);
  }
}

export async function authenticate(): Promise<void> {
  // Name first — same UX as today, so the orchestrator advances.
  await promptSpawnNameShared("Rigbox workspace");

  await ensureRigCli();
  await checkRigVersion();

  // Detect current auth state.
  const whoami = await runRig(
    [
      "whoami",
    ],
    WhoamiSchema,
  ).catch(() => null);
  if (whoami?.authed) {
    logInfo(`Logged in as ${whoami.user_email}`);
    return;
  }

  // Drive interactive browser login. Spawn renders each event in its
  // own UI; rig persists the key.
  for await (const ev of streamRig([
    "login",
  ])) {
    if (ev.kind === "login") {
      switch (ev.data.event) {
        case "browser_url":
          logStep("Open this URL in your browser to log in to Rigbox:");
          logInfo(`  ${ev.data.url}`);
          logStep("Waiting for browser approval...");
          break;
        case "approved":
          logStepDone();
          logInfo(`Logged in as ${ev.data.user_email}`);
          break;
        case "saved":
        case "session_created":
        case "polling":
          // Silent in human mode; the spinner state is implicit.
          break;
      }
    }
    // error events propagate through streamRig's exit handling.
  }
}

// ── Workspace lifecycle ─────────────────────────────────────────────

interface CreateWorkspaceRequest {
  name: string;
  image?: string;
  catalog_ids?: string[];
  ram_mb?: number;
  disk_size_mb?: number;
}

/**
 * Resolve the workspace RAM/disk needed for a catalog recipe.
 *
 * Rigbox catalog items declare `min_ram_mb` / `min_disk_mb` on the
 * `/v1/app-catalog` payload. We add a 256 MB / 256 MB headroom and pass
 * the result as `ram_mb` / `disk_size_mb` in the create request — the
 * server validates `ram_mb >= sum(min_ram_mb) + headroom` and 400s if
 * we undersize. Letting the server pick a default would land at
 * DEFAULT_RAM_MB (1 GB), which OOM-kills Node-based AI installers
 * inside the first_boot oneshot.
 */
async function resolveCatalogResourceNeeds(recipeId: string): Promise<
  | {
      ramMb: number;
      diskMb: number;
    }
  | undefined
> {
  const result = await asyncTryCatch(() => apiCall("GET", "/app-catalog", CatalogResponseSchema));
  if (!result.ok) {
    // Catalog lookup is best-effort: a stale spawn build talking to a
    // newer server, or a transient 5xx, shouldn't block provisioning.
    // The server's validate_catalog_ids will still 400 if we end up
    // undersized, surfacing the failure with a clearer message.
    // asyncTryCatch tags failures as `unknown`; coerce via a guard rather
    // than an `as` cast so biome's no-explicit-cast rule passes.
    const errMsg = result.error instanceof Error ? result.error.message : String(result.error);
    logInfo(`Could not fetch /app-catalog to size workspace: ${errMsg}`);
    return undefined;
  }
  const item = result.data.items.find((it) => it.id === recipeId);
  if (!item) {
    return undefined;
  }
  return {
    ramMb: item.min_ram_mb + SIZE_HEADROOM_MB,
    diskMb: item.min_disk_mb + SIZE_HEADROOM_MB,
  };
}

/**
 * Create a Rigbox workspace pre-baked with the named catalog recipe.
 *
 * `recipeId` is the resolved Rigbox catalog ID for the spawn agent
 * (see `agents.ts` for the mapping). If the agent has no recipe, pass
 * undefined and the workspace boots as a bare base-coder VM — spawn's
 * normal install path then runs over SSH.
 */
export async function createWorkspace(name: string, recipeId: string | undefined): Promise<VMConnection> {
  const body: CreateWorkspaceRequest = {
    name,
    image: "base",
  };
  if (recipeId) {
    body.catalog_ids = [
      recipeId,
    ];
    const sizes = await resolveCatalogResourceNeeds(recipeId);
    if (sizes) {
      body.ram_mb = sizes.ramMb;
      body.disk_size_mb = sizes.diskMb;
    }
  }

  logStep(`Provisioning Rigbox workspace "${name}"...`);
  const created: WorkspaceResponse = await apiCall("POST", "/workspaces", WorkspaceResponseSchema, body);
  _state.workspaceId = created.vm.id;
  _state.workspaceName = created.vm.name;

  // POST /v1/workspaces creates the row in `provisioned` state but
  // does not actually boot the Firecracker VM — that requires the
  // explicit /start call. Without this the workspace sits idle and
  // pollUntilRunning hits the timeout.
  await apiCallVoid("POST", `/workspaces/${created.vm.id}/start`);

  await pollUntilRunning(created.vm.id);

  // VM `running` only means systemd reached multi-user.target; the
  // catalog install (claude.ai/install.sh | bash, etc.) may still be
  // running inside the first_boot oneshot. Block on Rigbox's
  // authoritative per-app install signal before handing the
  // connection to the orchestrator — otherwise the agent gets
  // launched against a workspace where its binary isn't on disk yet.
  const expectedApps = body.catalog_ids?.length ?? 0;
  if (expectedApps > 0) {
    logStep("Waiting for catalog app install to complete...");
    await pollUntilAppsReady(created.vm.id, expectedApps);
  }

  logStepDone();
  logInfo(`Workspace ${name} is running`);

  return makeConnection();
}

async function pollUntilRunning(workspaceId: string): Promise<void> {
  const deadline = Date.now() + CREATE_POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const resp: WorkspaceResponse = await apiCall("GET", `/workspaces/${workspaceId}`, WorkspaceResponseSchema);
    const status = resp.vm.status;
    if (status === "running") {
      return;
    }
    if (status === "failed" || status === "error") {
      throw new Error(`Rigbox workspace failed to boot (status: ${status})`);
    }
    await sleep(CREATE_POLL_INTERVAL_MS);
  }
  throw new Error("Rigbox workspace did not reach 'running' within 5 minutes");
}

/**
 * Wait for every requested catalog app to finish installing.
 *
 * `vm.status === "running"` only means systemd is up — the catalog
 * install script may still be downloading and unpacking binaries in
 * the `rigbox-first-boot.service` oneshot. The authoritative ready
 * signal lives on each app row's `status`, set by Rigbox's install
 * pipeline:
 *
 *   installing → active   on successful catalog install
 *   installing → error    if the install script exits non-zero
 *
 * Polling this here means spawn never launches the agent before its
 * binary is actually on disk and configured.
 */
async function pollUntilAppsReady(workspaceId: string, expectedCount: number): Promise<void> {
  if (expectedCount === 0) {
    return;
  }

  const deadline = Date.now() + CREATE_POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const resp = await apiCall("GET", `/apps?workspace_id=${workspaceId}`, AppListSchema);
    const apps = resp.apps;

    const errored = apps.find((a) => a.status === "error");
    if (errored) {
      throw new Error(`Rigbox catalog app "${errored.name}" failed to install (status: error)`);
    }

    if (apps.length >= expectedCount && apps.every((a) => a.status === "active")) {
      return;
    }

    await sleep(CREATE_POLL_INTERVAL_MS);
  }
  throw new Error("Rigbox catalog apps did not all reach 'active' within 5 minutes");
}

/**
 * Shell out to the rig CLI with the given argv. Arguments are passed as
 * separate argv items (never interpolated into a shell string) so values
 * containing shell metacharacters can't be reinterpreted. On nonzero
 * exit, throws with rig's stderr prefix so the user sees the real cause.
 */
async function runRigCommand(args: string[]): Promise<void> {
  const rig = getRigCmd();
  if (!rig) {
    throw new Error("rig CLI not found — install with: curl -fsSL https://rigbox.dev/install.sh | sh");
  }
  const proc = Bun.spawn(
    [
      rig,
      ...args,
    ],
    {
      stdio: [
        "ignore",
        "pipe",
        "pipe",
      ],
    },
  );
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const stderrText = await new Response(proc.stderr).text();
    throw new Error(`Rigbox config update failed: ${stderrText.slice(0, 256)}`);
  }
}

/**
 * Forward the user's OpenRouter API key into the workspace env. Called
 * after createServer in the default (non-managed) flow. The catalog
 * recipe's /etc/profile.d/<agent>-routing.sh translates this into the
 * agent's expected env shape (ANTHROPIC_*, OPENAI_*, KILO_*, native).
 *
 * Forwarding a key is just BYOK with OPENROUTER_BASE_URL +
 * OPENROUTER_API_KEY set, plus `rig ai mode byok` to flip the
 * server-side workspace mode. Two sequential CLI calls; if the env-set
 * fails we never touch the mode.
 */
export async function setForwardedOpenRouterKey(openRouterKey: string): Promise<void> {
  if (!_state.workspaceId) {
    throw new Error("Workspace not yet created");
  }
  await runRigCommand([
    "env",
    "set",
    `OPENROUTER_API_KEY=${openRouterKey}`,
    "OPENROUTER_BASE_URL=https://openrouter.ai/api/v1",
    "-w",
    _state.workspaceId,
  ]);
  await runRigCommand([
    "ai",
    "mode",
    "byok",
    "-w",
    _state.workspaceId,
  ]);
}

/**
 * Switch the workspace's AI config to Rigbox's managed proxy.
 *
 * Delegates to `rig ai mode managed` so the CLI owns the ai-config
 * contract; spawn just records the mode locally for downstream branches
 * (e.g. env-injection ordering in main.ts).
 */
export async function enableManagedProxy(): Promise<void> {
  if (!_state.workspaceId) {
    throw new Error("Workspace not yet created");
  }
  await runRigCommand([
    "ai",
    "mode",
    "managed",
    "-w",
    _state.workspaceId,
  ]);
  _state.managedMode = true;
}

export function setManagedMode(managed: boolean): void {
  _state.managedMode = managed;
}

export function isManagedMode(): boolean {
  return _state.managedMode;
}

/** Delete the workspace (called by `spawn delete`). */
export async function destroyWorkspace(name?: string): Promise<void> {
  const targetName = name || _state.workspaceName;
  if (!targetName) {
    throw new Error("destroyWorkspace: no workspace name in state");
  }

  // Resolve name → id if we don't already have it cached.
  let id = _state.workspaceId;
  if (!id) {
    const listed: WorkspaceList = await apiCall("GET", "/workspaces", WorkspaceListSchema);
    const match = listed.vms.find((w) => w.name === targetName || w.id === targetName);
    if (!match) {
      throw new Error(`Workspace "${targetName}" not found`);
    }
    id = match.id;
  }
  await apiCallVoid("DELETE", `/workspaces/${id}`);
  logStepDone();
  logInfo(`Workspace ${targetName} deleted`);
}

// ── Connection + SSH ────────────────────────────────────────────────

function makeConnection(): VMConnection {
  // Username is `<normalized-name>-<id-suffix>`, host is the region
  // hostname. VMConnection treats `ip` as a generic string field —
  // using the hostname is fine; ssh resolves it.
  return {
    ip: _state.sshHost,
    user: buildSshUser(_state.workspaceName, _state.workspaceId),
    server_id: _state.workspaceId,
    server_name: _state.workspaceName,
    cloud: "rigbox",
  };
}

export function getVmConnection(): VMConnection {
  return makeConnection();
}

export async function getServerName(): Promise<string> {
  // Prefer the in-memory name set during createServer; for `spawn delete`
  // and similar reconnect flows the orchestrator calls this before
  // createServer, so fall back to the env var / kebab name spawn uses
  // elsewhere ($RIGBOX_NAME -> $SPAWN_NAME_KEBAB -> default).
  if (_state.workspaceName) {
    return _state.workspaceName;
  }
  return getServerNameFromEnv("RIGBOX_NAME");
}

export function getConnectionInfo(): {
  host: string;
  user: string;
} {
  return {
    host: _state.sshHost,
    user: buildSshUser(_state.workspaceName, _state.workspaceId),
  };
}

function sshTarget(): string {
  return `${buildSshUser(_state.workspaceName, _state.workspaceId)}@${_state.sshHost}`;
}

function isInteractiveCmd(cmd: string): boolean {
  // Heuristic: the agent's launchCmd lands here as a bash invocation.
  // We always treat it as interactive in our model — spawn passes the
  // agent's launch as the command for interactiveSession().
  return cmd.trim().length > 0;
}

/** Run a non-interactive command on the workspace via SSH. */
export async function runServer(cmd: string, timeoutSecs?: number): Promise<void> {
  if (!cmd || /\0/.test(cmd)) {
    throw new Error("Invalid command: must be non-empty and must not contain null bytes");
  }
  const target = sshTarget();
  const keyOpts = getSshKeyOpts(await ensureSshKeys());
  // SSH_BASE_OPTS (no `-t`) for non-interactive command exec — forcing
  // a pseudo-terminal here pollutes stdout with control sequences and
  // breaks the runner's expectation of plain-text output.
  const args = [
    "ssh",
    ...SSH_BASE_OPTS,
    ...keyOpts,
    target,
    `bash -lc ${shellQuote(cmd)}`,
  ];
  const proc = Bun.spawn(args, {
    stdio: [
      "ignore",
      "inherit",
      "inherit",
    ],
  });
  const timer = timeoutSecs ? setTimeout(() => proc.kill(), timeoutSecs * 1000) : undefined;
  const exitCode = await proc.exited;
  if (timer) {
    clearTimeout(timer);
  }
  if (exitCode !== 0) {
    throw new Error(`ssh command exited ${exitCode}: ${cmd.slice(0, 120)}`);
  }
}

export async function uploadFile(localPath: string, remotePath: string): Promise<void> {
  const safe = validateRemotePath(remotePath);
  const target = `${sshTarget()}:${safe}`;
  const keyOpts = getSshKeyOpts(await ensureSshKeys());
  // scp must use SSH_BASE_OPTS: SSH_INTERACTIVE_OPTS includes `-t`
  // (force-tty) which scp interprets as its internal "target mode"
  // flag, then complains about an "ambiguous target."
  const args = [
    "scp",
    "-q",
    ...keyOpts,
    ...SSH_BASE_OPTS,
    localPath,
    target,
  ];
  const proc = Bun.spawn(args, {
    stdio: [
      "ignore",
      "inherit",
      "inherit",
    ],
  });
  if ((await proc.exited) !== 0) {
    throw new Error(`scp upload failed: ${localPath}`);
  }
}

export async function downloadFile(remotePath: string, localPath: string): Promise<void> {
  const safe = validateRemotePath(remotePath);
  const source = `${sshTarget()}:${safe}`;
  const keyOpts = getSshKeyOpts(await ensureSshKeys());
  // SSH_BASE_OPTS for scp — see uploadFile for the `-t` rationale.
  const args = [
    "scp",
    "-q",
    ...keyOpts,
    ...SSH_BASE_OPTS,
    source,
    localPath,
  ];
  const proc = Bun.spawn(args, {
    stdio: [
      "ignore",
      "inherit",
      "inherit",
    ],
  });
  if ((await proc.exited) !== 0) {
    throw new Error(`scp download failed: ${remotePath}`);
  }
}

export async function interactiveSession(cmd: string, spawnFn?: (args: string[]) => number): Promise<number> {
  if (!isInteractiveCmd(cmd)) {
    throw new Error("interactiveSession: command must be non-empty");
  }
  const target = sshTarget();
  const term = sanitizeTermValue(process.env.TERM || "xterm-256color");
  const fullCmd = `export TERM='${term}' LANG='C.UTF-8' LC_ALL='C.UTF-8' && exec bash -l -c ${shellQuote(cmd)}`;
  const keyOpts = getSshKeyOpts(await ensureSshKeys());
  const args = [
    "ssh",
    ...SSH_INTERACTIVE_OPTS,
    ...keyOpts,
    target,
    fullCmd,
  ];

  const exitCode = spawnFn ? spawnFn(args) : spawnInteractive(args);

  process.stderr.write("\n");
  logWarn(`Session ended. Rigbox workspace "${_state.workspaceName}" is still running.`);
  logWarn(`  Delete with: spawn delete -c rigbox --name ${_state.workspaceName}`);
  return exitCode;
}

// ── Misc helpers ────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
