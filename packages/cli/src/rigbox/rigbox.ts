// rigbox/rigbox.ts — Rigbox cloud provider: API client + workspace lifecycle + SSH runner.
//
// Rigbox is a managed Firecracker host (https://rigbox.dev). The cloud
// orchestrator side here only needs to:
//
//   1. Authenticate the spawn user against the Rigbox API. Four-step
//      resolution: RIG_API_KEY env → existing rig CLI login →
//      ~/.config/spawn/rigbox.json → browser-based device-code flow
//      against `POST /auth/cli-session`.
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

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseJsonWith } from "@openrouter/spawn-shared";
import * as v from "valibot";
import { getUserHome } from "../shared/paths.js";
import { asyncTryCatch, tryCatch } from "../shared/result.js";
import { SSH_BASE_OPTS, SSH_INTERACTIVE_OPTS, spawnInteractive, validateRemotePath } from "../shared/ssh.js";
import { ensureSshKeys, getSshKeyOpts } from "../shared/ssh-keys.js";
import {
  getServerNameFromEnv,
  logInfo,
  logStep,
  logStepDone,
  logWarn,
  openBrowser,
  promptSpawnNameShared,
  sanitizeTermValue,
  shellQuote,
} from "../shared/ui.js";

// ── Configurable knobs ──────────────────────────────────────────────

const RIGBOX_API_URL = process.env.RIGBOX_API_URL || "https://api.rigbox.dev/v1";
const RIGBOX_CONFIG_DIR = join(getUserHome(), ".config", "spawn");
const RIGBOX_CONFIG_PATH = join(RIGBOX_CONFIG_DIR, "rigbox.json");
const RIG_CONFIG_PATH = join(getUserHome(), ".config", "rigbox", "config.toml");

// Region-direct SSH host. Override with RIGBOX_SSH_HOST when running
// against a different region.
const RIGBOX_SSH_HOST = process.env.RIGBOX_SSH_HOST || "eu-west-1.rigbox.dev";

const CREATE_POLL_INTERVAL_MS = 2000;
const CREATE_POLL_TIMEOUT_MS = 5 * 60 * 1000; // 5 min
const LOGIN_POLL_INTERVAL_MS = 2000;
const LOGIN_POLL_TIMEOUT_MS = 5 * 60 * 1000;

// ── Module state ────────────────────────────────────────────────────

interface RigboxState {
  apiKey: string;
  workspaceId: string;
  workspaceName: string;
  /** Region-direct SSH host (e.g. `eu-west-1.rigbox.dev`). */
  sshHost: string;
  /** Dashboard host used for the login URL — derived from API host. */
  dashboardHost: string;
  /** True when the user passed --managed (vs the default forwarded-key flow). */
  managedMode: boolean;
}

const _state: RigboxState = {
  apiKey: "",
  workspaceId: "",
  workspaceName: "",
  sshHost: RIGBOX_SSH_HOST,
  dashboardHost: "rigbox.dev",
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

const CliSessionPollSchema = v.object({
  status: v.string(),
  api_key: v.optional(v.string()),
});

const SpawnRigboxConfigSchema = v.object({
  api_key: v.optional(v.string()),
});

type WorkspaceResponse = v.InferOutput<typeof WorkspaceResponseSchema>;
type WorkspaceList = v.InferOutput<typeof WorkspaceListSchema>;
type CliSessionPoll = v.InferOutput<typeof CliSessionPollSchema>;

// ── Helpers ─────────────────────────────────────────────────────────

function authHeaders(): Record<string, string> {
  if (!_state.apiKey) {
    throw new Error("Rigbox API key not set — authenticate() must run before any API call.");
  }
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${_state.apiKey}`,
  };
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
 * Strip the `api.` prefix from the API host to get the dashboard host.
 * Used to construct the login URL (`https://<dashboard>/login?cli_session=…`).
 * Distinct from the SSH host which is region-prefixed (e.g.
 * `eu-west-1.rigbox.dev`) and configured via RIGBOX_SSH_HOST.
 */
function deriveDashboardHost(apiUrl: string): string {
  const host =
    apiUrl
      .replace(/^https?:\/\//, "")
      .split("/")[0]
      ?.trim() ?? "";
  if (host.startsWith("api.")) {
    const stripped = host.slice(4);
    return stripped.length > 0 ? stripped : "rigbox.dev";
  }
  return host || "rigbox.dev";
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

// ── Auth: 4-step key resolution ─────────────────────────────────────

function readEnvKey(): string | null {
  const fromEnv = (process.env.RIG_API_KEY || process.env.RIGBOX_API_KEY || "").trim();
  return fromEnv || null;
}

function readRigCliKey(): string | null {
  // rigbox-cli persists at ~/.config/rigbox/config.toml — minimal TOML
  // parser: we only need `api_key = "..."`. Avoid a TOML dep for one field.
  if (!existsSync(RIG_CONFIG_PATH)) {
    return null;
  }
  const text = readFileSync(RIG_CONFIG_PATH, "utf8");
  const match = text.match(/^\s*api_key\s*=\s*"([^"]+)"\s*$/m);
  return match?.[1]?.trim() || null;
}

function readSpawnRigboxKey(): string | null {
  if (!existsSync(RIGBOX_CONFIG_PATH)) {
    return null;
  }
  const raw = readFileSync(RIGBOX_CONFIG_PATH, "utf8");
  const parsed = parseJsonWith(raw, SpawnRigboxConfigSchema);
  if (parsed === null) {
    return null;
  }
  const key = parsed.api_key?.trim();
  return key && key.length > 0 ? key : null;
}

function persistSpawnRigboxKey(apiKey: string): void {
  mkdirSync(RIGBOX_CONFIG_DIR, {
    recursive: true,
  });
  writeFileSync(
    RIGBOX_CONFIG_PATH,
    JSON.stringify(
      {
        api_key: apiKey,
      },
      null,
      2,
    ),
    {
      mode: 0o600,
    },
  );
}

function generateSessionCode(): string {
  // 32-char base36 — matches the format the dashboard expects.
  const alphabet = "0123456789abcdefghijklmnopqrstuvwxyz";
  let out = "";
  for (let i = 0; i < 32; i++) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return out;
}

// ── Rig CLI auto-install ────────────────────────────────────────────

const RIG_INSTALL_URL = "https://rigbox.dev/install.sh";

/** Resolve the path to a usable `rig` binary, or null if unavailable. */
function getRigCmd(): string | null {
  // Prefer PATH lookup (covers user-managed installs anywhere).
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
  // Common install locations the install.sh defaults to.
  const candidates = [
    join(getUserHome(), ".local", "bin", "rig"),
    "/usr/local/bin/rig",
    "/opt/homebrew/bin/rig",
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

/**
 * Install the rig CLI if it isn't already on the user's machine.
 *
 * Best-effort: failures are logged but don't abort the spawn flow,
 * since the rigbox cloud module talks to the Rigbox API directly and
 * doesn't strictly require rig. The install gives users an entry point
 * to manage workspaces beyond the single spawn invocation
 * (`rig logs`, `rig stop`, `rig ssh-info`, etc.).
 */
export async function ensureRigCli(): Promise<void> {
  const existing = getRigCmd();
  if (existing) {
    const versionResult = Bun.spawnSync(
      [
        existing,
        "--version",
      ],
      {
        stdio: [
          "ignore",
          "pipe",
          "ignore",
        ],
      },
    );
    const version = new TextDecoder().decode(versionResult.stdout).trim().split("\n")[0];
    if (version) {
      logInfo(`rig CLI already installed: ${version}`);
    } else {
      logInfo("rig CLI already installed");
    }
    return;
  }

  if (process.env.SPAWN_NON_INTERACTIVE === "1") {
    logInfo(
      "Skipping rig CLI install (non-interactive mode). " +
        "Install later: curl -fsSL https://rigbox.dev/install.sh | sh",
    );
    return;
  }

  logStep("Installing rig CLI for richer workspace management...");
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
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    logWarn(
      "rig CLI install did not complete cleanly. " +
        "spawn-rigbox will keep working — rig is optional. " +
        "Try manually: curl -fsSL https://rigbox.dev/install.sh | sh",
    );
    return;
  }

  // Add ~/.local/bin to PATH for the rest of this spawn invocation so
  // `rig --version` lookups + downstream subprocess execs find it.
  const localBin = join(getUserHome(), ".local", "bin");
  if (!process.env.PATH?.split(":").includes(localBin)) {
    process.env.PATH = `${localBin}:${process.env.PATH ?? ""}`;
  }

  if (getRigCmd()) {
    logInfo("rig CLI installed");
  } else {
    logWarn(`rig CLI installed but not yet on PATH. Add it manually: export PATH="${localBin}:$PATH"`);
  }
}

async function deviceCodeFlow(): Promise<string> {
  const code = generateSessionCode();
  // POST /auth/cli-session is unauthenticated.
  const createResp = await fetch(`${RIGBOX_API_URL}/auth/cli-session`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      code,
    }),
  });
  if (!createResp.ok) {
    throw new Error(`Rigbox cli-session create failed: ${createResp.status}`);
  }

  const loginUrl = `https://${_state.dashboardHost}/login?cli_session=${code}`;

  logStep("Open this URL in your browser to log in to Rigbox:");
  logInfo(`  ${loginUrl}`);
  if (process.env.SPAWN_NON_INTERACTIVE !== "1") {
    // best-effort; if the browser handler fails we still print the URL.
    const _ignored = tryCatch(() => {
      openBrowser(loginUrl);
    });
    void _ignored;
  }
  logStep("Waiting for browser approval...");

  const deadline = Date.now() + LOGIN_POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(LOGIN_POLL_INTERVAL_MS);
    const poll = await fetch(`${RIGBOX_API_URL}/auth/cli-session/${code}`);
    if (poll.status === 404) {
      throw new Error("Rigbox login session expired. Run again.");
    }
    if (!poll.ok) {
      continue; // transient — keep polling
    }
    const textResult = await asyncTryCatch(() => poll.text());
    if (!textResult.ok) {
      continue;
    }
    const body: CliSessionPoll | null = parseJsonWith(textResult.data, CliSessionPollSchema);
    if (body === null) {
      continue;
    }
    if (body.status === "approved" && body.api_key) {
      logStepDone();
      logInfo("Rigbox login approved");
      return body.api_key;
    }
  }
  throw new Error("Rigbox login timed out after 5 minutes");
}

export async function authenticate(): Promise<void> {
  _state.dashboardHost = deriveDashboardHost(RIGBOX_API_URL);

  // Prompt for / derive the workspace name first — spawn's
  // runOrchestration reads SPAWN_NAME_KEBAB when calling createServer,
  // so the name must be populated before the orchestrator advances.
  // Non-interactive runs auto-generate via defaultSpawnName().
  await promptSpawnNameShared("Rigbox workspace");

  // 1. Env override (headless / CI).
  const envKey = readEnvKey();
  if (envKey) {
    _state.apiKey = envKey;
    logInfo("Using Rigbox API key from RIG_API_KEY env var");
    return;
  }

  // 2. Reuse an existing `rig login` (~/.config/rigbox/config.toml).
  const rigKey = readRigCliKey();
  if (rigKey) {
    _state.apiKey = rigKey;
    logInfo("Reusing Rigbox login from rig CLI config");
    return;
  }

  // 3. Reuse a prior spawn-rigbox device-code login.
  const spawnKey = readSpawnRigboxKey();
  if (spawnKey) {
    _state.apiKey = spawnKey;
    logInfo("Reusing prior Rigbox login from ~/.config/spawn/rigbox.json");
    return;
  }

  // 4. Device-code flow.
  const apiKey = await deviceCodeFlow();
  _state.apiKey = apiKey;
  persistSpawnRigboxKey(apiKey);

  // Once the user has authed against Rigbox, get rig CLI installed so
  // they can manage the workspace beyond this single spawn invocation.
  // Best-effort — failures here don't abort the flow.
  await ensureRigCli();
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
 * Forward the user's OpenRouter API key into the workspace env. Called
 * after createServer in the default (non-managed) flow. The catalog
 * recipe's /etc/profile.d/<agent>-routing.sh translates this into the
 * agent's expected env shape (ANTHROPIC_*, OPENAI_*, KILO_*, native).
 */
export async function setForwardedOpenRouterKey(openRouterKey: string): Promise<void> {
  if (!_state.workspaceId) {
    throw new Error("Workspace not yet created");
  }
  await apiCallVoid("POST", `/workspaces/${_state.workspaceId}/env`, {
    env_vars: {
      OPENROUTER_API_KEY: openRouterKey,
    },
  });
}

/** Switch the workspace's AI config to Rigbox's managed proxy. */
export async function enableManagedProxy(): Promise<void> {
  if (!_state.workspaceId) {
    throw new Error("Workspace not yet created");
  }
  _state.managedMode = true;
  await apiCallVoid("PUT", `/workspaces/${_state.workspaceId}/ai-config`, {
    mode: "managed",
  });
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
