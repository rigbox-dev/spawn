import type { TierCapacity } from "../rigbox/tiers";

import { describe, expect, test } from "bun:test";
import { RigError } from "../rigbox/rig-runner";
import {
  capacityFromLimits,
  fallbackCapacityFromSubscription,
  highestAllowedTier,
  resolveTier,
  SPAWN_TIERS,
} from "../rigbox/tiers";
import { tryCatch } from "../shared/result";

// Helpers ────────────────────────────────────────────────────────────

const sink = () => {};

// Plan-default capacities matching the server's FREE/PRO ceilings.
const FREE_DEFAULT_CAPACITY: TierCapacity = fallbackCapacityFromSubscription("free");
const PRO_DEFAULT_CAPACITY: TierCapacity = fallbackCapacityFromSubscription("pro");

// Override scenarios — what the new resolver is for.
const FREE_WITH_RAM_OVERRIDE_4GB: TierCapacity = {
  maxRamPerVmMb: 4096,
  remainingDiskMb: 10240,
  remainingVmSlots: 3,
};

const PRO_NEAR_DISK_CAPACITY: TierCapacity = {
  maxRamPerVmMb: 8192,
  remainingDiskMb: 4096, // exactly enough for starter/agent's 4 GB disk, not heavy's 8 GB
  remainingVmSlots: 3,
};

// 3 GB per-VM RAM ceiling — between starter (2 GB) and agent (4 GB),
// so the resolver should down-tier any "agent" recommendation.
const FREE_RAM_WEDGE_3GB: TierCapacity = {
  maxRamPerVmMb: 3072,
  remainingDiskMb: 10240,
  remainingVmSlots: 3,
};

const FREE_ZERO_SLOTS: TierCapacity = {
  maxRamPerVmMb: 2048,
  remainingDiskMb: 10240,
  remainingVmSlots: 0,
};

const FREE_DISK_EXHAUSTED: TierCapacity = {
  maxRamPerVmMb: 2048,
  remainingDiskMb: 1024, // less than every tier's 4 GB disk floor
  remainingVmSlots: 1,
};

// Tests ──────────────────────────────────────────────────────────────

describe("resolveTier — happy paths", () => {
  test("free default: pi → starter, no warnings", () => {
    const warnings: string[] = [];
    const tier = resolveTier("pi", FREE_DEFAULT_CAPACITY, "free", undefined, (m) => warnings.push(m));
    expect(tier.id).toBe("starter");
    expect(warnings).toHaveLength(0);
  });

  test("pro default: t3code → agent, no warnings", () => {
    const warnings: string[] = [];
    const tier = resolveTier("t3code", PRO_DEFAULT_CAPACITY, "pro", undefined, (m) => warnings.push(m));
    expect(tier.id).toBe("agent");
    expect(warnings).toHaveLength(0);
  });

  test("unknown agent defaults to starter", () => {
    const tier = resolveTier("future-agent-9000", FREE_DEFAULT_CAPACITY, "free", undefined, sink);
    expect(tier.id).toBe("starter");
  });
});

describe("resolveTier — per-user overrides (the whole point of this change)", () => {
  test("free user with 4 GB-per-VM override gets the agent tier with no warning", () => {
    // This is the bug the limits-aware resolver fixes: ops grants a
    // beta tester max_ram_per_vm_mb = 4096 on the free plan; today's
    // subscription-keyed resolver would still cap at starter.
    const warnings: string[] = [];
    const tier = resolveTier("t3code", FREE_WITH_RAM_OVERRIDE_4GB, "free", undefined, (m) => warnings.push(m));
    expect(tier.id).toBe("agent");
    expect(warnings).toHaveLength(0);
  });

  test("free user with override can also opt up to agent via --size", () => {
    const tier = resolveTier("pi", FREE_WITH_RAM_OVERRIDE_4GB, "free", "agent", sink);
    expect(tier.id).toBe("agent");
  });
});

describe("resolveTier — capacity-driven fallback", () => {
  test("free user with 3 GB-per-VM cap sees t3code (recommends agent) → starter with RAM-cap warning", () => {
    // RAM wedge sits between starter (2 GB) and agent (4 GB); agent
    // doesn't fit, starter does. The warning copy must name the real
    // cap (3072 MB) — not the plan name.
    const warnings: string[] = [];
    const tier = resolveTier("t3code", FREE_RAM_WEDGE_3GB, "free", undefined, (m) => warnings.push(m));
    expect(tier.id).toBe("starter");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("agent");
    expect(warnings[0]).toContain("3072"); // the actual cap
    expect(warnings[0]).toContain("rigbox.dev/billing");
  });

  test("pro user with exactly the agent disk fit still gets the recommended tier (starter for pi)", () => {
    const warnings: string[] = [];
    const tier = resolveTier("pi", PRO_NEAR_DISK_CAPACITY, "pro", undefined, (m) => warnings.push(m));
    expect(tier.id).toBe("starter");
    expect(warnings).toHaveLength(0);
  });
});

describe("resolveTier — override rejection with actionable error", () => {
  test("--size agent on free default capacity throws with per-VM RAM reason", () => {
    const r = tryCatch(() => resolveTier("pi", FREE_DEFAULT_CAPACITY, "free", "agent", sink));
    expect(r.ok).toBe(false);
    if (!r.ok && r.error instanceof RigError) {
      expect(r.error.code).toBe("validation");
      expect(r.error.message).toContain("'agent'");
      expect(r.error.message).toContain("2048"); // the user's actual cap
      expect(r.error.message).toContain("4096"); // the tier's ask
      expect(r.error.message).toContain("rigbox.dev/billing");
    }
  });

  test("--size heavy on pro-near-disk-capacity throws with disk-budget reason", () => {
    const r = tryCatch(() => resolveTier("pi", PRO_NEAR_DISK_CAPACITY, "pro", "heavy", sink));
    expect(r.ok).toBe(false);
    if (!r.ok && r.error instanceof RigError) {
      expect(r.error.code).toBe("validation");
      expect(r.error.message).toContain("heavy");
      expect(r.error.message).toContain("disk");
    }
  });

  test("unknown --size value throws RigError listing the valid tiers", () => {
    const r = tryCatch(() => resolveTier("pi", FREE_DEFAULT_CAPACITY, "free", "xlarge", sink));
    expect(r.ok).toBe(false);
    if (!r.ok && r.error instanceof RigError) {
      expect(r.error.message).toContain("Unknown --size 'xlarge'");
      expect(r.error.message).toContain("nano");
      expect(r.error.message).toContain("heavy");
    }
  });
});

describe("resolveTier — capacity exhaustion", () => {
  test("zero workspace slots throws capacity_exceeded regardless of agent", () => {
    const r = tryCatch(() => resolveTier("pi", FREE_ZERO_SLOTS, "free", undefined, sink));
    expect(r.ok).toBe(false);
    if (!r.ok && r.error instanceof RigError) {
      expect(r.error.code).toBe("capacity_exceeded");
      expect(r.error.message).toContain("workspace limit");
    }
  });

  test("disk exhausted (no tier fits) throws capacity_exceeded", () => {
    const r = tryCatch(() => resolveTier("pi", FREE_DISK_EXHAUSTED, "free", undefined, sink));
    expect(r.ok).toBe(false);
    if (!r.ok && r.error instanceof RigError) {
      expect(r.error.code).toBe("capacity_exceeded");
      expect(r.error.message).toContain("No workspace size fits");
    }
  });
});

describe("capacityFromLimits + fallbackCapacityFromSubscription", () => {
  test("capacityFromLimits subtracts usage from totals", () => {
    const cap = capacityFromLimits(
      {
        max_vms: 5,
        max_ram_per_vm_mb: 8192,
        max_ram_total_mb: 16384,
        max_disk_total_mb: 20480,
        max_vcpu_per_vm: 4,
        max_running_vcpus: 4,
      },
      {
        workspace_count: 2,
        running_vcpus: 2,
        total_disk_mb: 8192,
        total_ram_mb: 4096,
      },
    );
    expect(cap.maxRamPerVmMb).toBe(8192);
    expect(cap.remainingDiskMb).toBe(12288); // 20480 − 8192
    expect(cap.remainingVmSlots).toBe(3); // 5 − 2
  });

  test("capacityFromLimits clamps to zero (never negative)", () => {
    const cap = capacityFromLimits(
      {
        max_vms: 3,
        max_ram_per_vm_mb: 2048,
        max_ram_total_mb: 2048,
        max_disk_total_mb: 4096,
        max_vcpu_per_vm: 2,
        max_running_vcpus: 4,
      },
      // Over-consumed (admin bumped down a quota while usage was higher).
      {
        workspace_count: 5,
        running_vcpus: 4,
        total_disk_mb: 8192,
        total_ram_mb: 4096,
      },
    );
    expect(cap.remainingDiskMb).toBe(0);
    expect(cap.remainingVmSlots).toBe(0);
  });

  test("fallbackCapacityFromSubscription matches the server's FREE/PRO defaults", () => {
    const free = fallbackCapacityFromSubscription("free");
    expect(free.maxRamPerVmMb).toBe(2048);
    expect(free.remainingDiskMb).toBe(10240);
    expect(free.remainingVmSlots).toBe(3);

    const pro = fallbackCapacityFromSubscription("pro");
    expect(pro.maxRamPerVmMb).toBe(8192);
    expect(pro.remainingDiskMb).toBe(20480);
    expect(pro.remainingVmSlots).toBe(5);
  });

  test("resolver behavior with fallback capacity reproduces the prior subscription-keyed behavior", () => {
    // Free user, no override, t3code → starter (recommended is agent
    // which doesn't fit the 2 GB per-VM RAM ceiling). Mirrors the
    // pre-limits behavior so `rig limits` failure stays safe.
    const warnings: string[] = [];
    const tier = resolveTier("t3code", fallbackCapacityFromSubscription("free"), "free", undefined, (m) =>
      warnings.push(m),
    );
    expect(tier.id).toBe("starter");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("agent");
  });
});

describe("highestAllowedTier", () => {
  test("returns starter for free and heavy for pro", () => {
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

  test("recommendedFor is purely informational, never gates resolution", () => {
    // Sanity check: every tier declares a recommendedFor; the resolver
    // doesn't read it, but downstream UX strings might.
    for (const tier of Object.values(SPAWN_TIERS)) {
      expect([
        "free",
        "pro",
      ]).toContain(tier.recommendedFor);
    }
  });
});
