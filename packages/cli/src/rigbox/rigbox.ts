// rigbox/rigbox.ts — Rigbox cloud provider: rig CLI delegation + SSH runner.
//
// Rigbox is a managed workspace host (https://rigbox.dev). The cloud
// orchestrator side here only needs to:
//
//   1. Authenticate the spawn user via `rig login`. Checks `rig whoami`
//      first; if already authed, returns immediately. Otherwise drives
//      the NDJSON browser login event stream from `rig login` and renders
//      events into spawn's UI. rig persists the API key.
//
//   2. `rig spawn <name> --catalog <recipe> --output json` to provision
//      a workspace. Reads SpawnEvents from the stream; the `ready`
//      event carries ssh_user and ssh_host.
//
//   3. Inject the user's OpenRouter API key via `rig env set` and flip
//      the workspace AI mode via `rig ai mode byok`. `--managed` swaps
//      this for `rig ai mode managed`.
//
//   4. Drive SSH using ssh_user and ssh_host from the ready event.

import type { VMConnection } from "../history.js";
import type { Limits } from "./rig-runner.js";
import type { Subscription, TierCapacity } from "./tiers.js";

import { existsSync } from "node:fs";
import { join } from "node:path";
import { getUserHome } from "../shared/paths.js";
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
import {
  AiModeSchema,
  checkRigVersion,
  EnvSetSchema,
  LimitsSchema,
  RmSchema,
  runRig,
  streamRig,
  WhoamiSchema,
} from "./rig-runner.js";
import { capacityFromLimits, fallbackCapacityFromSubscription, resolveTier } from "./tiers.js";

// ── Module state ────────────────────────────────────────────────────

interface RigboxState {
  workspaceId: string;
  workspaceName: string;
  sshUser: string;
  sshHost: string;
  /** True when the user passed --managed (vs the default forwarded-key flow). */
  managedMode: boolean;
  /** Rigbox plan tier captured at authenticate-time; used for upgrade-hint copy. */
  subscription: Subscription;
  /** Effective limits + usage from `rig limits`. Null when the call failed
   * (older rig CLI, transient error); resolver falls back to subscription
   * defaults in that case. */
  limits: Limits["limits"] | null;
  usage: Limits["usage"] | null;
}

const _state: RigboxState = {
  workspaceId: "",
  workspaceName: "",
  sshUser: "",
  sshHost: "",
  managedMode: false,
  subscription: "free",
  limits: null,
  usage: null,
};

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
    // Older rig CLIs and older servers don't emit `subscription`; default to
    // "free" so tier resolution never silently up-tiers an unknown user.
    _state.subscription = whoami.subscription ?? "free";
    await fetchAndStashLimits();
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

  // Capture the now-authed subscription so the post-login createWorkspace
  // call uses the correct tier ceiling. Swallow failures and default to
  // "free" — the worst case is a Pro user temporarily sized as free,
  // which is the conservative side of the trade-off.
  const postLogin = await runRig(
    [
      "whoami",
    ],
    WhoamiSchema,
  ).catch(() => null);
  if (postLogin?.authed) {
    _state.subscription = postLogin.subscription ?? "free";
  }
  await fetchAndStashLimits();
}

/**
 * Best-effort fetch of `rig limits` to populate `_state.limits/usage`.
 * On failure (older rig CLI without the `limits` command, transient
 * network error) we leave them null and the resolver falls back to
 * subscription-keyed defaults — the previous behavior. Never throws.
 */
async function fetchAndStashLimits(): Promise<void> {
  const result = await runRig(
    [
      "limits",
    ],
    LimitsSchema,
  ).catch(() => null);
  if (result) {
    _state.limits = result.limits;
    _state.usage = result.usage;
  }
}

// ── Workspace lifecycle ─────────────────────────────────────────────

/**
 * Create a Rigbox workspace pre-baked with the named catalog recipe.
 *
 * `recipeId` is the resolved Rigbox catalog ID for the spawn agent
 * (see `agents.ts` for the mapping). If the agent has no recipe, pass
 * undefined and the workspace boots as a bare base-coder VM — spawn's
 * normal install path then runs over SSH.
 *
 * Delegates to `rig spawn --output json` and reads SpawnEvents from the
 * stream. The `ready` event carries ssh_user and ssh_host; those populate
 * _state so makeConnection() can build the VMConnection without knowing
 * the workspace ID format.
 */
export async function createWorkspace(
  name: string,
  recipeId: string | undefined,
  agentName: string,
  sizeOverride?: string,
): Promise<VMConnection> {
  // Capacity comes from `rig limits` when available, so any per-user
  // override (DB column or TOML) raises the ceiling automatically.
  // Falls back to subscription-keyed defaults when limits aren't
  // available (older rig CLI / transient failure).
  const capacity: TierCapacity =
    _state.limits && _state.usage
      ? capacityFromLimits(_state.limits, _state.usage)
      : fallbackCapacityFromSubscription(_state.subscription);
  const tier = resolveTier(agentName, capacity, _state.subscription, sizeOverride, (msg) => logInfo(msg));

  const args = [
    "workspace",
    "spawn",
    name,
  ];
  if (recipeId) {
    args.push("--catalog", recipeId);
    // --auto-size and --wait-for-apps default-on when --catalog is set,
    // so we don't need to pass them explicitly.
  }
  // Tier sizing overrides rig's catalog-minimum default and gives the
  // workspace steady-state headroom from the start.
  args.push("--ram", String(tier.ramMb), "--disk", String(tier.diskMb));

  logStep(
    `Provisioning Rigbox workspace "${name}" on the ${tier.id} tier ` +
      `(${tier.ramMb} MB RAM, ${tier.diskMb} MB disk)...`,
  );

  let readyId: string | null = null;
  let readyName: string | null = null;
  let sshUser: string | null = null;
  let sshHost: string | null = null;

  for await (const ev of streamRig(args)) {
    if (ev.kind !== "spawn") {
      continue;
    }
    switch (ev.data.event) {
      case "creating":
        // Logged at the top — silent here.
        break;
      case "created":
        logInfo(`Workspace created: ${ev.data.id}`);
        break;
      case "starting":
        logStep("Starting VM...");
        break;
      case "vm_status":
        logInfo(`VM: ${ev.data.status}`);
        break;
      case "apps_installing":
        logStep(`Installing ${ev.data.expected} catalog app(s)...`);
        break;
      case "app_status":
        logInfo(`  ${ev.data.app}: ${ev.data.status}`);
        break;
      case "floor_bumped":
        // rig CLI bumped our --ram or --disk up to clear a
        // catalog+template floor. Surface it so the user sees the
        // mismatch between the tier sizing we asked for and what
        // they actually got — useful signal for tier registry updates.
        logWarn(`${ev.data.resource} bumped from ${ev.data.from_mb}MB to ${ev.data.to_mb}MB (${ev.data.reason})`);
        break;
      case "ready":
        readyId = ev.data.id;
        readyName = ev.data.name;
        sshUser = ev.data.ssh_user;
        sshHost = ev.data.ssh_host;
        break;
    }
  }

  if (!readyId || !readyName || !sshUser || !sshHost) {
    throw new Error("rig spawn completed without a ready event");
  }

  _state.workspaceId = readyId;
  _state.workspaceName = readyName;
  _state.sshUser = sshUser;
  _state.sshHost = sshHost;

  logStepDone();
  logInfo(`Workspace ${readyName} is running`);

  return makeConnection();
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
  await runRig(
    [
      "workspace",
      "env",
      "set",
      `OPENROUTER_API_KEY=${openRouterKey}`,
      "OPENROUTER_BASE_URL=https://openrouter.ai/api/v1",
      "-w",
      _state.workspaceId,
    ],
    EnvSetSchema,
  );
  await runRig(
    [
      "workspace",
      "ai",
      "mode",
      "byok",
      "-w",
      _state.workspaceId,
    ],
    AiModeSchema,
  );
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
  await runRig(
    [
      "workspace",
      "ai",
      "mode",
      "managed",
      "-w",
      _state.workspaceId,
    ],
    AiModeSchema,
  );
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
  const target = name || _state.workspaceName;
  if (!target) {
    throw new Error("destroyWorkspace: no workspace name in state");
  }
  await runRig(
    [
      "workspace",
      "rm",
      target,
      "--force",
    ],
    RmSchema,
  );
  logStepDone();
  logInfo(`Workspace ${target} deleted`);
}

// ── Connection + SSH ────────────────────────────────────────────────

function makeConnection(): VMConnection {
  // ssh_user and ssh_host come from the rig spawn ready event.
  // VMConnection treats `ip` as a generic string field — using the
  // hostname is fine; ssh resolves it.
  return {
    ip: _state.sshHost,
    user: _state.sshUser,
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
    user: _state.sshUser,
  };
}

function sshTarget(): string {
  return `${_state.sshUser}@${_state.sshHost}`;
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
