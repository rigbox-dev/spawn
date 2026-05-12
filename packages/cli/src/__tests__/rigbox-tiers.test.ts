import { describe, expect, test } from "bun:test";
import { RigError } from "../rigbox/rig-runner";
import { highestAllowedTier, resolveTier, SPAWN_TIERS } from "../rigbox/tiers";
import { tryCatch } from "../shared/result";

describe("resolveTier", () => {
  // No-op warn sink. Individual tests that assert on warning content pass
  // their own collector.
  const sink = () => {};

  test("returns the agent's recommended tier when the plan allows it", () => {
    const tier = resolveTier("pi", "free", undefined, sink);
    expect(tier.id).toBe("starter");
    expect(tier.ramMb).toBe(2048);
    expect(tier.diskMb).toBe(4096);
  });

  test("pro user gets the recommended pro tier without warnings", () => {
    const warnings: string[] = [];
    const tier = resolveTier("t3code", "pro", undefined, (m) => warnings.push(m));
    expect(tier.id).toBe("agent");
    expect(warnings).toHaveLength(0);
  });

  test("free user spawning a pro-tier agent falls back to starter with one warning", () => {
    const warnings: string[] = [];
    const tier = resolveTier("t3code", "free", undefined, (m) => warnings.push(m));
    expect(tier.id).toBe("starter");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("'agent' tier");
    expect(warnings[0]).toContain("free plan");
    expect(warnings[0]).toContain("rigbox.dev/billing");
  });

  test("unknown agents default to starter", () => {
    const tier = resolveTier("future-agent-9000", "free", undefined, sink);
    expect(tier.id).toBe("starter");
  });

  test("--size override on pro user is honored", () => {
    const tier = resolveTier("pi", "pro", "heavy", sink);
    expect(tier.id).toBe("heavy");
    expect(tier.ramMb).toBe(8192);
    expect(tier.diskMb).toBe(8192);
  });

  test("--size override that exceeds the plan throws RigError with upgrade hint", () => {
    const r = tryCatch(() => resolveTier("pi", "free", "agent", sink));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBeInstanceOf(RigError);
      if (r.error instanceof RigError) {
        expect(r.error.code).toBe("validation");
        expect(r.error.message).toContain("requires the Pro plan");
        expect(r.error.message).toContain("rigbox.dev/billing");
      }
    }
  });

  test("unknown --size value throws RigError listing the valid tiers", () => {
    const r = tryCatch(() => resolveTier("pi", "free", "xlarge", sink));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBeInstanceOf(RigError);
      if (r.error instanceof RigError) {
        expect(r.error.message).toContain("Unknown --size 'xlarge'");
        expect(r.error.message).toContain("nano");
        expect(r.error.message).toContain("heavy");
      }
    }
  });

  test("highestAllowedTier returns starter for free and heavy for pro", () => {
    expect(highestAllowedTier("free").id).toBe("starter");
    expect(highestAllowedTier("pro").id).toBe("heavy");
  });
});

describe("SPAWN_TIERS registry", () => {
  test("all tiers have a 4 GB or greater disk floor", () => {
    for (const tier of Object.values(SPAWN_TIERS)) {
      expect(tier.diskMb).toBeGreaterThanOrEqual(4096);
    }
  });

  test("free tiers stay at or below the FREE_MAX_RAM_PER_VM_MB ceiling", () => {
    // FREE_MAX_RAM_PER_VM_MB = 2048 in server/rig-data-store/src/models.rs.
    for (const tier of Object.values(SPAWN_TIERS)) {
      if (tier.minPlan === "free") {
        expect(tier.ramMb).toBeLessThanOrEqual(2048);
      }
    }
  });

  test("pro tiers stay at or below the PRO_MAX_RAM_PER_VM_MB ceiling", () => {
    // PRO_MAX_RAM_PER_VM_MB = 8192 in server/rig-data-store/src/models.rs.
    for (const tier of Object.values(SPAWN_TIERS)) {
      expect(tier.ramMb).toBeLessThanOrEqual(8192);
    }
  });
});
