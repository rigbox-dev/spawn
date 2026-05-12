import type { ParsedEvent } from "../rigbox/rig-runner";

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as v from "valibot";
import {
  _resetVersionCheckCache,
  checkRigVersion,
  compareSemver,
  ErrorEventSchema,
  LimitsSchema,
  LoginEventSchema,
  parseEvent,
  parseLines,
  parseSemver,
  RIG_MIN_VERSION,
  RigVersionError,
  runRig,
  SpawnEventSchema,
  streamRig,
  WhoamiSchema,
} from "../rigbox/rig-runner";
import { asyncTryCatch } from "../shared/result.js";

describe("RigEvent schemas", () => {
  test("LoginEvent parses session_created", () => {
    const parsed = v.parse(LoginEventSchema, {
      event: "session_created",
      code: "abc",
    });
    expect(parsed.event).toBe("session_created");
  });

  test("LoginEvent parses browser_url", () => {
    const parsed = v.parse(LoginEventSchema, {
      event: "browser_url",
      url: "https://x",
    });
    if (parsed.event === "browser_url") {
      expect(parsed.url).toBe("https://x");
    } else {
      throw new Error("expected browser_url variant");
    }
  });

  test("LoginEvent parses approved with user_email", () => {
    const parsed = v.parse(LoginEventSchema, {
      event: "approved",
      user_email: "j@x",
    });
    if (parsed.event === "approved") {
      expect(parsed.user_email).toBe("j@x");
    } else {
      throw new Error("expected approved variant");
    }
  });

  test("SpawnEvent parses ready with all fields", () => {
    const parsed = v.parse(SpawnEventSchema, {
      event: "ready",
      id: "ws-abc",
      name: "my-ws",
      ssh_user: "my-ws-abc",
      ssh_host: "eu-west-1.rigbox.dev",
    });
    if (parsed.event === "ready") {
      expect(parsed.ssh_host).toBe("eu-west-1.rigbox.dev");
    } else {
      throw new Error("expected ready variant");
    }
  });

  test("WhoamiSchema parses authed: true without subscription (older server)", () => {
    const parsed = v.parse(WhoamiSchema, {
      authed: true,
      user_email: "j@x",
      user_id: "u_1",
      source: "xdg_config",
    });
    expect(parsed.authed).toBe(true);
    if (parsed.authed) {
      expect(parsed.subscription).toBeUndefined();
    }
  });

  test("WhoamiSchema parses authed: true with subscription: 'free'", () => {
    const parsed = v.parse(WhoamiSchema, {
      authed: true,
      user_email: "j@x",
      user_id: "u_1",
      source: "xdg_config",
      subscription: "free",
    });
    if (parsed.authed) {
      expect(parsed.subscription).toBe("free");
    } else {
      throw new Error("expected authed variant");
    }
  });

  test("WhoamiSchema parses authed: true with subscription: 'pro'", () => {
    const parsed = v.parse(WhoamiSchema, {
      authed: true,
      user_email: "j@x",
      user_id: "u_1",
      source: "xdg_config",
      subscription: "pro",
    });
    if (parsed.authed) {
      expect(parsed.subscription).toBe("pro");
    } else {
      throw new Error("expected authed variant");
    }
  });

  test("WhoamiSchema parses authed: false", () => {
    const parsed = v.parse(WhoamiSchema, {
      authed: false,
      source: "none",
    });
    expect(parsed.authed).toBe(false);
  });

  test("LimitsSchema parses the canonical /v1/users/me/limits payload", () => {
    const parsed = v.parse(LimitsSchema, {
      event: "limits",
      plan: "free",
      custom: false,
      limits: {
        max_vms: 3,
        max_ram_per_vm_mb: 2048,
        max_ram_total_mb: 2048,
        max_disk_total_mb: 10240,
        max_vcpu_per_vm: 2,
        max_running_vcpus: 4,
      },
      usage: {
        workspace_count: 1,
        running_vcpus: 1,
        total_disk_mb: 4096,
        total_ram_mb: 2048,
      },
    });
    expect(parsed.plan).toBe("free");
    expect(parsed.limits.max_ram_per_vm_mb).toBe(2048);
    expect(parsed.usage.workspace_count).toBe(1);
  });

  test("LimitsSchema tolerates extra forward-compatible fields (looseObject)", () => {
    // Future server may add fields like max_credits, max_concurrent_ssh, etc.
    // Spawn should keep working without a schema bump.
    const parsed = v.parse(LimitsSchema, {
      event: "limits",
      plan: "pro_managed",
      custom: true,
      experimental_field: "ignore-me",
      limits: {
        max_vms: 5,
        max_ram_per_vm_mb: 16384,
        max_ram_total_mb: 16384,
        max_disk_total_mb: 30720,
        max_vcpu_per_vm: 4,
        max_running_vcpus: 8,
        another_future_limit: 9999,
      },
      usage: {
        workspace_count: 2,
        running_vcpus: 2,
        total_disk_mb: 8192,
        total_ram_mb: 4096,
      },
    });
    expect(parsed.custom).toBe(true);
    expect(parsed.limits.max_ram_per_vm_mb).toBe(16384);
  });

  test("ErrorEventSchema parses canonical shape", () => {
    const parsed = v.parse(ErrorEventSchema, {
      event: "error",
      code: "auth_expired",
      message: "token rejected",
    });
    expect(parsed.code).toBe("auth_expired");
  });

  test("parseEvent dispatches by tag", () => {
    const login = parseEvent('{"event":"approved","user_email":"j@x"}');
    expect(login.kind).toBe("login");

    const error = parseEvent('{"event":"error","code":"network","message":"oops"}');
    expect(error.kind).toBe("error");

    const spawn = parseEvent('{"event":"creating","name":"my-ws"}');
    expect(spawn.kind).toBe("spawn");
  });
});

describe("checkRigVersion semver helpers", () => {
  test("parseSemver extracts version from `rig --version` output", () => {
    expect(parseSemver("rigbox 0.4.0\n")).toEqual({
      major: 0,
      minor: 4,
      patch: 0,
    });
    expect(parseSemver("rigbox-cli 1.10.3")).toEqual({
      major: 1,
      minor: 10,
      patch: 3,
    });
  });

  test("parseSemver returns null on garbage", () => {
    expect(parseSemver("")).toBeNull();
    expect(parseSemver("not a version")).toBeNull();
  });

  test("compareSemver orders correctly", () => {
    const a = parseSemver("rigbox 0.4.0")!;
    const b = parseSemver("rigbox 0.3.5")!;
    expect(compareSemver(a, b)).toBeGreaterThan(0);
    expect(compareSemver(b, a)).toBeLessThan(0);
    expect(compareSemver(a, a)).toBe(0);
  });

  test("compareSemver handles patch differences", () => {
    const a = parseSemver("rigbox 0.4.10")!;
    const b = parseSemver("rigbox 0.4.2")!;
    expect(compareSemver(a, b)).toBeGreaterThan(0);
  });

  test("RIG_MIN_VERSION is 0.4.0", () => {
    expect(RIG_MIN_VERSION).toEqual({
      major: 0,
      minor: 4,
      patch: 0,
    });
  });
});

describe("checkRigVersion", () => {
  test("throws RigVersionError when rig binary is missing", async () => {
    _resetVersionCheckCache();
    const r = await asyncTryCatch(() => checkRigVersion("/nonexistent/rig-binary-xyz"));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBeInstanceOf(RigVersionError);
    }
  });
});

describe("parseLines", () => {
  test("yields one event per line", async () => {
    const lines = [
      '{"event":"creating","name":"my-ws"}',
      '{"event":"ready","id":"ws-1","name":"my-ws","ssh_user":"u","ssh_host":"h"}',
    ];
    const stream = lineStream(lines.join("\n"));
    const events: ParsedEvent[] = [];
    for await (const ev of parseLines(stream)) {
      events.push(ev);
    }
    expect(events.length).toBe(2);
    expect(events[0]?.kind).toBe("spawn");
    expect(events[1]?.kind).toBe("spawn");
  });

  test('yields {kind: "unknown"} for unparseable lines', async () => {
    const stream = lineStream("not json\n");
    const events: ParsedEvent[] = [];
    for await (const ev of parseLines(stream)) {
      events.push(ev);
    }
    expect(events.length).toBe(1);
    expect(events[0]?.kind).toBe("unknown");
  });

  test("skips empty lines", async () => {
    const stream = lineStream('{"event":"creating","name":"a"}\n\n{"event":"creating","name":"b"}\n');
    const events: ParsedEvent[] = [];
    for await (const ev of parseLines(stream)) {
      events.push(ev);
    }
    expect(events.length).toBe(2);
  });

  test("handles split lines across chunks", async () => {
    const stream = chunkedStream([
      '{"event":"creat',
      'ing","name":"my-ws"}\n{"event":"ready","id":"ws",',
      '"name":"my-ws","ssh_user":"u","ssh_host":"h"}\n',
    ]);
    const events: ParsedEvent[] = [];
    for await (const ev of parseLines(stream)) {
      events.push(ev);
    }
    expect(events.length).toBe(2);
  });
});

const fakeRig = join(import.meta.dir, "../../../..", "fixtures/rig/fake-rig.sh");

describe("streamRig with fake-rig", () => {
  test("yields events from login-success scenario", async () => {
    const events: ParsedEvent[] = [];
    for await (const ev of streamRig(
      [
        "login",
      ],
      {
        rigPath: fakeRig,
        env: {
          FAKE_RIG_SCENARIO: "login-success",
        },
      },
    )) {
      events.push(ev);
    }
    expect(events.length).toBe(5);
    expect(events[0]?.kind).toBe("login");
    expect(events[3]?.kind).toBe("login");
    if (events[3]?.kind === "login" && events[3].data.event === "approved") {
      expect(events[3].data.user_email).toBe("j@example.com");
    }
  });

  test("throws on auth_expired exit code 2", async () => {
    const run = async () => {
      const events: ParsedEvent[] = [];
      for await (const ev of streamRig(
        [
          "whoami",
        ],
        {
          rigPath: fakeRig,
          env: {
            FAKE_RIG_SCENARIO: "auth-expired",
          },
        },
      )) {
        events.push(ev);
      }
    };
    await expect(run()).rejects.toMatchObject({
      code: "auth_expired",
    });
  });

  test("throws on vm_failed error event with exit 1", async () => {
    const run = async () => {
      const events: ParsedEvent[] = [];
      for await (const ev of streamRig(
        [
          "spawn",
          "my-ws",
        ],
        {
          rigPath: fakeRig,
          env: {
            FAKE_RIG_SCENARIO: "spawn-vm-failed",
          },
        },
      )) {
        events.push(ev);
      }
    };
    await expect(run()).rejects.toMatchObject({
      code: "vm_failed",
    });
  });

  test("rejects unparseable lines as contract violations", async () => {
    const tmpScript = "/tmp/fake-rig-garbage.sh";
    await Bun.write(tmpScript, "#!/usr/bin/env bash\necho 'not json'\nexit 0\n");
    await Bun.spawn([
      "chmod",
      "+x",
      tmpScript,
    ]).exited;
    const run = async () => {
      for await (const _ of streamRig(
        [
          "whoami",
        ],
        {
          rigPath: tmpScript,
        },
      )) {
        /* nothing */
      }
    };
    await expect(run()).rejects.toThrow(/Unexpected output from rig/);
  });
});

describe("runRig single-event helper", () => {
  test("returns parsed whoami-authed payload", async () => {
    const result = await runRig(
      [
        "whoami",
      ],
      WhoamiSchema,
      {
        rigPath: fakeRig,
        env: {
          FAKE_RIG_SCENARIO: "whoami-authed",
        },
      },
    );
    expect(result.authed).toBe(true);
    if (result.authed) {
      expect(result.user_email).toBe("j@example.com");
    }
  });

  test("returns parsed whoami-unauthed payload", async () => {
    const result = await runRig(
      [
        "whoami",
      ],
      WhoamiSchema,
      {
        rigPath: fakeRig,
        env: {
          FAKE_RIG_SCENARIO: "whoami-unauthed",
        },
      },
    );
    expect(result.authed).toBe(false);
  });

  test("throws RigError when rig exits non-zero", async () => {
    await expect(
      runRig(
        [
          "whoami",
        ],
        WhoamiSchema,
        {
          rigPath: fakeRig,
          env: {
            FAKE_RIG_SCENARIO: "auth-expired",
          },
        },
      ),
    ).rejects.toMatchObject({
      code: "auth_expired",
    });
  });
});

describe("rig 0.4.0 fixture parsing", () => {
  const fixturesDir = join(import.meta.dir, "../../../..", "fixtures/rig");

  test("login-success.ndjson parses cleanly through parseEvent", () => {
    const text = readFileSync(join(fixturesDir, "login-success.ndjson"), "utf8");
    const events = text
      .trim()
      .split("\n")
      .map((l) => parseEvent(l));
    expect(events.every((e) => e.kind === "login")).toBe(true);
  });

  test("spawn-with-catalog.ndjson parses cleanly through parseEvent", () => {
    const text = readFileSync(join(fixturesDir, "spawn-with-catalog.ndjson"), "utf8");
    const events = text
      .trim()
      .split("\n")
      .map((l) => parseEvent(l));
    expect(events.every((e) => e.kind === "spawn")).toBe(true);
  });

  test("error-vm-failed.ndjson final event is an error", () => {
    const text = readFileSync(join(fixturesDir, "error-vm-failed.ndjson"), "utf8");
    const events = text
      .trim()
      .split("\n")
      .map((l) => parseEvent(l));
    expect(events[events.length - 1]?.kind).toBe("error");
  });

  test("whoami-authed.json validates", () => {
    const raw = readFileSync(join(fixturesDir, "whoami-authed.json"), "utf8");
    const parsed = v.parse(WhoamiSchema, JSON.parse(raw));
    expect(parsed.authed).toBe(true);
  });

  test("whoami-unauthed.json validates", () => {
    const raw = readFileSync(join(fixturesDir, "whoami-unauthed.json"), "utf8");
    const parsed = v.parse(WhoamiSchema, JSON.parse(raw));
    expect(parsed.authed).toBe(false);
  });
});

// Test helpers — build a ReadableStream<Uint8Array> from string sources.
function lineStream(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

function chunkedStream(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) {
        controller.enqueue(enc.encode(c));
      }
      controller.close();
    },
  });
}
