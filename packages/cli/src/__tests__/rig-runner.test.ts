import { describe, expect, test } from "bun:test";
import * as v from "valibot";
import {
  _resetVersionCheckCache,
  checkRigVersion,
  compareSemver,
  ErrorEventSchema,
  LoginEventSchema,
  parseEvent,
  parseSemver,
  RIG_MIN_VERSION,
  RigVersionError,
  SpawnEventSchema,
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

  test("WhoamiSchema parses authed: true", () => {
    const parsed = v.parse(WhoamiSchema, {
      authed: true,
      user_email: "j@x",
      user_id: "u_1",
      source: "xdg_config",
    });
    expect(parsed.authed).toBe(true);
  });

  test("WhoamiSchema parses authed: false", () => {
    const parsed = v.parse(WhoamiSchema, {
      authed: false,
      source: "none",
    });
    expect(parsed.authed).toBe(false);
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
