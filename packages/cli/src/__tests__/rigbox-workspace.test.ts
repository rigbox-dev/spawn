import type { SpawnRecord } from "../history";

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMockManifest, mockClackPrompts } from "./test-helpers";

const clack = mockClackPrompts();

const { confirmAndDelete } = await import("../commands/delete.js");
const { buildRigboxPairingUrl, createWorkspace } = await import("../rigbox/rigbox.js");

function makeFakeRig(dir: string): string {
  const argsLog = join(dir, "rig-args.log");
  const rigPath = join(dir, "rig");
  writeFileSync(
    rigPath,
    [
      "#!/bin/sh",
      'printf "%s\\n" "$*" >> "$RIG_ARGS_LOG"',
      'if [ "$1" = "--version" ]; then',
      '  echo "rigbox 0.6.8"',
      "  exit 0",
      "fi",
      'if [ "$1" = "workspace" ] && [ "$2" = "spawn" ]; then',
      '  echo \'{"event":"created","id":"ws_spawn","status":"created"}\'',
      '  echo \'{"event":"ready","id":"ws_spawn","name":"spawned-pi","ssh_user":"rig","ssh_host":"spawned.rigbox.test"}\'',
      "  exit 0",
      "fi",
      'if [ "$1" = "workspace" ] && [ "$2" = "rm" ]; then',
      '  echo \'{"event":"removed","workspace":"rig-delete-id","workspace_id":"rig-delete-id"}\'',
      "  exit 0",
      "fi",
      'echo \'{"event":"error","code":"unexpected","message":"unexpected fake rig command"}\'',
      "exit 1",
      "",
    ].join("\n"),
  );
  chmodSync(rigPath, 0o755);
  return argsLog;
}

function writeHistory(dir: string, records: SpawnRecord[]): void {
  writeFileSync(
    join(dir, "history.json"),
    JSON.stringify(
      {
        version: 1,
        records,
      },
      null,
      2,
    ),
  );
}

describe("rigbox workspace integration", () => {
  let tmp: string;
  let argsLog: string;
  let originalHome: string | undefined;
  let originalPath: string | undefined;
  let originalSpawnHome: string | undefined;
  let originalRigArgsLog: string | undefined;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "spawn-rigbox-"));
    argsLog = makeFakeRig(tmp);
    originalHome = process.env.HOME;
    originalPath = process.env.PATH;
    originalSpawnHome = process.env.SPAWN_HOME;
    originalRigArgsLog = process.env.RIG_ARGS_LOG;
    process.env.HOME = tmp;
    process.env.PATH = `${tmp}:${originalPath ?? ""}`;
    process.env.RIG_ARGS_LOG = argsLog;
    const spawnHome = join(tmp, "spawn-home");
    mkdirSync(spawnHome, {
      recursive: true,
    });
    process.env.SPAWN_HOME = spawnHome;
    clack.confirm.mockReset();
    clack.confirm.mockResolvedValue(true);
  });

  afterEach(() => {
    if (originalPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    if (originalSpawnHome === undefined) {
      delete process.env.SPAWN_HOME;
    } else {
      process.env.SPAWN_HOME = originalSpawnHome;
    }
    if (originalRigArgsLog === undefined) {
      delete process.env.RIG_ARGS_LOG;
    } else {
      process.env.RIG_ARGS_LOG = originalRigArgsLog;
    }
    rmSync(tmp, {
      recursive: true,
      force: true,
    });
  });

  it("passes tier vCPU into rig workspace spawn", async () => {
    const connection = await createWorkspace("spawned-pi", "pi", "pi");

    expect(connection.server_id).toBe("ws_spawn");
    const args = readFileSync(argsLog, "utf-8");
    expect(args).toContain("workspace spawn -n spawned-pi --catalog pi --ram 2048 --vcpu 2 --disk 4096 --output json");
  });

  it("deletes rigbox workspaces through the shared delete dispatcher", async () => {
    const record: SpawnRecord = {
      id: "rigbox-delete-record",
      agent: "pi",
      cloud: "rigbox",
      timestamp: new Date().toISOString(),
      connection: {
        ip: "spawned.rigbox.test",
        user: "rig",
        server_id: "rig-delete-id",
        server_name: "rig-delete-name",
        cloud: "rigbox",
      },
    };
    writeHistory(process.env.SPAWN_HOME!, [
      record,
    ]);

    const deleted = await confirmAndDelete(record, createMockManifest());

    expect(deleted).toBe(true);
    const args = readFileSync(argsLog, "utf-8");
    expect(args).toContain("workspace rm -n rig-delete-id --force --output json");
    const history = JSON.parse(readFileSync(join(process.env.SPAWN_HOME!, "history.json"), "utf-8"));
    expect(history.records[0].connection.deleted).toBe(true);
  });

  it("builds T3 Code pairing URLs with fragment tokens", () => {
    expect(buildRigboxPairingUrl("t3code-demo.rigbox.dev", "PAIR123")).toBe(
      "https://t3code-demo.rigbox.dev/pair#token=PAIR123",
    );
  });
});
