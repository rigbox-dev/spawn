// rig-runner.ts — Subprocess + NDJSON helpers around the `rig` CLI.
//
// All rigbox API interaction in spawn flows through this module. We
// invoke `rig` with `--output json` and parse NDJSON lines from stdout.
// Each line is validated against a valibot schema; unknown lines fail
// closed (treated as a contract violation).

import * as v from "valibot";
import { tryCatch } from "../shared/result.js";

// ── Login events ──────────────────────────────────────────────

const SessionCreated = v.looseObject({
  event: v.literal("session_created"),
  code: v.string(),
});
const BrowserUrl = v.looseObject({
  event: v.literal("browser_url"),
  url: v.string(),
});
const Polling = v.looseObject({
  event: v.literal("polling"),
  elapsed_ms: v.number(),
});
const Approved = v.looseObject({
  event: v.literal("approved"),
  user_email: v.string(),
});
const Saved = v.looseObject({
  event: v.literal("saved"),
  path: v.string(),
});

/** Login NDJSON event stream from `rig login --output json`. */
export const LoginEventSchema = v.variant("event", [
  SessionCreated,
  BrowserUrl,
  Polling,
  Approved,
  Saved,
]);
export type LoginEvent = v.InferOutput<typeof LoginEventSchema>;

// ── Spawn events ──────────────────────────────────────────────

const Creating = v.looseObject({
  event: v.literal("creating"),
  name: v.string(),
});
const Created = v.looseObject({
  event: v.literal("created"),
  id: v.string(),
  status: v.string(),
});
const Starting = v.looseObject({
  event: v.literal("starting"),
});
const VmStatus = v.looseObject({
  event: v.literal("vm_status"),
  status: v.string(),
});
const AppsInstalling = v.looseObject({
  event: v.literal("apps_installing"),
  expected: v.number(),
});
const AppStatus = v.looseObject({
  event: v.literal("app_status"),
  app: v.string(),
  status: v.string(),
});
const Ready = v.looseObject({
  event: v.literal("ready"),
  id: v.string(),
  name: v.string(),
  ssh_user: v.string(),
  ssh_host: v.string(),
});
// Emitted by `rig spawn` (rigbox-cli v0.4.3+) when a user-supplied
// `--ram`/`--disk` falls below the catalog+template floor and rig
// bumps it up. Carrying the from/to/reason lets spawn (and other
// NDJSON consumers) surface the bump without treating it as an
// unexpected contract violation.
const FloorBumped = v.looseObject({
  event: v.literal("floor_bumped"),
  resource: v.string(),
  from_mb: v.number(),
  to_mb: v.number(),
  reason: v.string(),
});

/** Spawn NDJSON event stream from `rig spawn --output json`. */
export const SpawnEventSchema = v.variant("event", [
  Creating,
  Created,
  Starting,
  VmStatus,
  AppsInstalling,
  AppStatus,
  FloorBumped,
  Ready,
]);
export type SpawnEvent = v.InferOutput<typeof SpawnEventSchema>;

// ── Single-event response schemas ─────────────────────────────

/** `rig whoami --output json` — single line, two shapes.
 *
 * `subscription` is optional during the rollout: older rig CLIs and
 * older servers won't emit it, in which case spawn defaults to "free"
 * at the rigbox.ts boundary (conservative; never silently up-tier). */
export const WhoamiSchema = v.union([
  v.looseObject({
    authed: v.literal(true),
    user_email: v.string(),
    user_id: v.string(),
    source: v.string(),
    subscription: v.optional(
      v.union([
        v.literal("free"),
        v.literal("pro"),
      ]),
    ),
  }),
  v.looseObject({
    authed: v.literal(false),
    source: v.string(),
  }),
]);
export type Whoami = v.InferOutput<typeof WhoamiSchema>;

/** `rig limits --output json` — single event with the user's effective
 * resource limits (DB-column and TOML overrides already resolved by the
 * server) plus current usage. Spawn's tier resolver consumes this to
 * gate by *actual* per-user capacity rather than subscription→constant. */
export const LimitsSchema = v.looseObject({
  event: v.literal("limits"),
  plan: v.string(),
  custom: v.boolean(),
  limits: v.looseObject({
    max_vms: v.number(),
    max_ram_per_vm_mb: v.number(),
    max_ram_total_mb: v.number(),
    max_disk_total_mb: v.number(),
    max_vcpu_per_vm: v.number(),
    max_running_vcpus: v.number(),
  }),
  usage: v.looseObject({
    workspace_count: v.number(),
    running_vcpus: v.number(),
    total_disk_mb: v.number(),
    total_ram_mb: v.number(),
  }),
});
export type Limits = v.InferOutput<typeof LimitsSchema>;

/** `rig env set/unset --output json` — single line. */
export const EnvSetSchema = v.looseObject({
  event: v.literal("set"),
  workspace: v.string(),
  keys: v.array(v.string()),
});
export const EnvUnsetSchema = v.looseObject({
  event: v.literal("unset"),
  workspace: v.string(),
  keys: v.array(v.string()),
});

/** `rig ai mode --output json` — single line. */
export const AiModeSchema = v.looseObject({
  event: v.literal("mode"),
  workspace: v.string(),
  mode: v.string(),
});

/** `rig rm --output json` — single line. */
export const RmSchema = v.looseObject({
  event: v.literal("removed"),
  workspace: v.string(),
  workspace_id: v.string(),
});

/** `rig ssh-info --output json` — single NDJSON event. */
export const SshInfoSchema = v.looseObject({
  event: v.literal("ssh_info"),
  workspace: v.string(),
  workspace_id: v.string(),
  status: v.string(),
  user: v.string(),
  host: v.string(),
  port: v.number(),
  ssh_target: v.string(),
});
export type SshInfo = v.InferOutput<typeof SshInfoSchema>;

// ── Error event ────────────────────────────────────────────────

export const ErrorEventSchema = v.looseObject({
  event: v.literal("error"),
  code: v.string(),
  message: v.string(),
});
export type ErrorEvent = v.InferOutput<typeof ErrorEventSchema>;

// ── Unified parser ────────────────────────────────────────────

export type ParsedEvent =
  | {
      kind: "login";
      data: LoginEvent;
    }
  | {
      kind: "spawn";
      data: SpawnEvent;
    }
  | {
      kind: "error";
      data: ErrorEvent;
    }
  | {
      kind: "unknown";
      raw: unknown;
    };

/** Parse a single NDJSON line into a tagged event. Falls through to
 * `unknown` when no schema matches — the caller decides whether to
 * treat that as a fatal contract violation (the default in streamRig)
 * or pass through silently. */
export function parseEvent(line: string): ParsedEvent {
  const r = tryCatch(() => JSON.parse(line));
  if (!r.ok) {
    return {
      kind: "unknown",
      raw: line,
    };
  }
  const raw = r.data;

  // Try error event first — it can appear in any stream.
  const errParsed = v.safeParse(ErrorEventSchema, raw);
  if (errParsed.success) {
    return {
      kind: "error",
      data: errParsed.output,
    };
  }

  const loginParsed = v.safeParse(LoginEventSchema, raw);
  if (loginParsed.success) {
    return {
      kind: "login",
      data: loginParsed.output,
    };
  }

  const spawnParsed = v.safeParse(SpawnEventSchema, raw);
  if (spawnParsed.success) {
    return {
      kind: "spawn",
      data: spawnParsed.output,
    };
  }

  return {
    kind: "unknown",
    raw,
  };
}

// ── Version detection ─────────────────────────────────────────

export interface Semver {
  major: number;
  minor: number;
  patch: number;
}

/** Minimum rig version this spawn release requires. Bumped any time
 * spawn starts using a new rig surface. */
export const RIG_MIN_VERSION: Semver = {
  major: 0,
  minor: 6,
  patch: 0,
};

/** Parse `rig --version` output. Accepts `rigbox X.Y.Z` and
 * `rigbox-cli X.Y.Z` shapes (clap default prepends the package name). */
export function parseSemver(out: string): Semver | null {
  const match = out.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match || !match[1] || !match[2] || !match[3]) {
    return null;
  }
  return {
    major: Number.parseInt(match[1], 10),
    minor: Number.parseInt(match[2], 10),
    patch: Number.parseInt(match[3], 10),
  };
}

/** Return >0 if a > b, <0 if a < b, 0 if equal. */
export function compareSemver(a: Semver, b: Semver): number {
  if (a.major !== b.major) {
    return a.major - b.major;
  }
  if (a.minor !== b.minor) {
    return a.minor - b.minor;
  }
  return a.patch - b.patch;
}

export class RigVersionError extends Error {
  constructor(
    public readonly found: Semver | null,
    public readonly required: Semver,
  ) {
    const foundStr = found ? `${found.major}.${found.minor}.${found.patch}` : "unknown";
    const reqStr = `${required.major}.${required.minor}.${required.patch}`;
    super(
      `spawn-rigbox needs rig >= ${reqStr} (found ${foundStr}).\n` +
        "Upgrade: curl -fsSL https://rigbox.dev/install.sh | sh",
    );
    this.name = "RigVersionError";
  }
}

/** Run `rig --version` and throw if older than RIG_MIN_VERSION.
 * Cached after first call within the same process. */
let _versionChecked = false;
export async function checkRigVersion(rigPath = "rig"): Promise<void> {
  if (_versionChecked) {
    return;
  }
  const spawnResult = tryCatch(() =>
    Bun.spawnSync(
      [
        rigPath,
        "--version",
      ],
      {
        stdio: [
          "ignore",
          "pipe",
          "pipe",
        ],
      },
    ),
  );

  if (!spawnResult.ok) {
    throw new RigVersionError(null, RIG_MIN_VERSION);
  }

  const proc = spawnResult.data;
  const out = new TextDecoder().decode(proc.stdout);
  const found = parseSemver(out);
  if (!found || compareSemver(found, RIG_MIN_VERSION) < 0) {
    throw new RigVersionError(found, RIG_MIN_VERSION);
  }
  _versionChecked = true;
}

/** Test helper to reset the cache. Production code never calls this. */
export function _resetVersionCheckCache(): void {
  _versionChecked = false;
}

// ── Subprocess wrapper ────────────────────────────────────────

export interface StreamRigOptions {
  /** Override the rig binary path. Default: "rig" (PATH lookup). */
  rigPath?: string;
  /** Extra env vars merged with process.env. */
  env?: Record<string, string>;
}

export class RigError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly exitCode: number,
  ) {
    super(message);
    this.name = "RigError";
  }
}

function makeRigError(code: string, message: string, exitCode: number): RigError {
  return new RigError(code, message, exitCode);
}

/** Spawn `rig <args> --output json` and yield parsed events. Throws a
 * `RigError` with a `code` field on non-zero exit. Exit code 2 always
 * maps to `auth_expired`. */
export async function* streamRig(args: string[], options: StreamRigOptions = {}): AsyncIterable<ParsedEvent> {
  const rigPath = options.rigPath ?? "rig";
  const fullArgs = [
    ...args,
    "--output",
    "json",
  ];
  const proc: Bun.Subprocess<"inherit", "pipe", "inherit"> = Bun.spawn(
    [
      rigPath,
      ...fullArgs,
    ],
    {
      stdio: [
        "inherit",
        "pipe",
        "inherit",
      ],
      env: {
        ...process.env,
        ...options.env,
      },
    },
  );

  let lastError: ErrorEvent | null = null;
  let unparseable: unknown = null;
  for await (const ev of parseLines(proc.stdout)) {
    if (ev.kind === "error") {
      lastError = ev.data;
    } else if (ev.kind === "unknown") {
      unparseable = ev.raw;
    }
    yield ev;
  }

  const exitCode = await proc.exited;

  if (unparseable !== null) {
    throw makeRigError(
      "internal",
      `Unexpected output from rig: ${JSON.stringify(unparseable).slice(0, 256)}`,
      exitCode,
    );
  }

  if (exitCode === 2) {
    throw makeRigError(
      lastError?.code ?? "auth_expired",
      lastError?.message ?? "Your rigbox login expired. Run `rig login` and try again.",
      2,
    );
  }

  if (exitCode !== 0) {
    if (lastError) {
      throw makeRigError(lastError.code, lastError.message, exitCode);
    }
    throw makeRigError("internal", `rig exited with code ${exitCode}`, exitCode);
  }
}

// ── Line reader ───────────────────────────────────────────────

/** Read a `ReadableStream<Uint8Array>` line-by-line, yielding each line
 * as a parsed event. Empty lines are skipped. Handles partial lines
 * across stream chunks. */
export async function* parseLines(stream: ReadableStream<Uint8Array>): AsyncIterable<ParsedEvent> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let done = false;
  while (!done) {
    const result = await reader.read();
    done = result.done;
    if (!done && result.value) {
      buf += decoder.decode(result.value, {
        stream: true,
      });
      let nl = buf.indexOf("\n");
      while (nl >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line.length > 0) {
          yield parseEvent(line);
        }
        nl = buf.indexOf("\n");
      }
    }
  }
  reader.releaseLock();
  const tail = buf.trim();
  if (tail.length > 0) {
    yield parseEvent(tail);
  }
}

// ── Single-event helper ───────────────────────────────────────

/** Convenience wrapper for single-event commands (whoami, env set, ai
 * mode, rm, ssh-info). Runs the command, collects the last non-error
 * NDJSON line, validates it against the supplied schema, and returns
 * the parsed payload. Errors from rig (non-zero exit) propagate as
 * RigError unchanged. */
export async function runRig<TSchema extends v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>>>(
  args: string[],
  schema: TSchema,
  options: StreamRigOptions = {},
): Promise<v.InferOutput<TSchema>> {
  const rigPath = options.rigPath ?? "rig";
  const fullArgs = [
    ...args,
    "--output",
    "json",
  ];
  const proc: Bun.Subprocess<"inherit", "pipe", "inherit"> = Bun.spawn(
    [
      rigPath,
      ...fullArgs,
    ],
    {
      stdio: [
        "inherit",
        "pipe",
        "inherit",
      ],
      env: {
        ...process.env,
        ...options.env,
      },
    },
  );

  let lastNonError: unknown = null;
  let lastError: ErrorEvent | null = null;

  for await (const ev of parseLines(proc.stdout)) {
    const parsed = v.safeParse(ErrorEventSchema, ev.kind === "unknown" ? ev.raw : ev.data);
    if (parsed.success) {
      lastError = parsed.output;
    } else if (ev.kind !== "error") {
      lastNonError = ev.kind === "unknown" ? ev.raw : ev.data;
    }
  }

  const exitCode = await proc.exited;

  if (exitCode === 2) {
    throw makeRigError(
      lastError?.code ?? "auth_expired",
      lastError?.message ?? "Your rigbox login expired. Run `rig login` and try again.",
      2,
    );
  }

  if (exitCode !== 0) {
    if (lastError) {
      throw makeRigError(lastError.code, lastError.message, exitCode);
    }
    throw makeRigError("internal", `rig exited with code ${exitCode}`, exitCode);
  }

  if (lastNonError === null) {
    throw makeRigError("internal", `rig ${args.join(" ")} produced no output events`, 0);
  }

  const parsedSchema = v.safeParse(schema, lastNonError);
  if (!parsedSchema.success) {
    throw makeRigError(
      "internal",
      `rig ${args.join(" ")} returned an unexpected shape: ${JSON.stringify(lastNonError).slice(0, 256)}`,
      0,
    );
  }

  return parsedSchema.output;
}
