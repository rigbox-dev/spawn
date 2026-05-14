// rigbox/tiers.ts — Capacity-aware workspace sizing for spawn-on-Rigbox.
//
// Each spawn agent recommends a tier ({ramMb, diskMb, vcpuCount}) that
// represents the steady-state size the agent actually wants — not the
// catalog-minimum boot floor `rig spawn --auto-size` falls back to.
//
// The resolver gates by **real** per-user capacity (from `rig limits`),
// not by hardcoded plan defaults. A free user with a per-user DB or
// TOML override granting 4 GB per VM gets the `agent` tier; the
// `recommendedFor` field on a tier is cosmetic now — it only shapes
// the upgrade-hint copy. The hardcoded subscription ceilings remain as
// a fallback for the case where `rig limits` is unavailable (older
// rig CLI, network failure).

import type { Limits } from "./rig-runner.js";

import { RigError } from "./rig-runner.js";

export type Subscription = "free" | "pro";

export interface SpawnTier {
  id: string;
  ramMb: number;
  diskMb: number;
  vcpuCount: number;
  /** Cosmetic — drives upgrade-hint copy only; not a gate. */
  recommendedFor: Subscription;
  /** Short human-readable summary surfaced in `--size` validation and warnings. */
  description: string;
}

/** Registry of valid `--size` values for the rigbox cloud. */
export const SPAWN_TIERS: Record<string, SpawnTier> = {
  nano: {
    id: "nano",
    ramMb: 1024,
    diskMb: 4096,
    vcpuCount: 1,
    recommendedFor: "free",
    description: "1 GB RAM · 4 GB disk · 1 vCPU",
  },
  starter: {
    id: "starter",
    ramMb: 2048,
    diskMb: 4096,
    vcpuCount: 2,
    recommendedFor: "free",
    description: "2 GB RAM · 4 GB disk · 2 vCPU",
  },
  agent: {
    id: "agent",
    ramMb: 4096,
    diskMb: 4096,
    vcpuCount: 2,
    recommendedFor: "pro",
    description: "4 GB RAM · 4 GB disk · 2 vCPU",
  },
  heavy: {
    id: "heavy",
    ramMb: 8192,
    diskMb: 8192,
    vcpuCount: 4,
    recommendedFor: "pro",
    description: "8 GB RAM · 8 GB disk · 4 vCPU",
  },
};

/** Order tiers go through when searching for the largest fit-the-capacity option. */
const TIER_ORDER_DESCENDING = [
  "heavy",
  "agent",
  "starter",
  "nano",
] as const;

/**
 * Recommended tier per spawn agent. Free-fit agents (CLI tools that idle
 * around 1-2 GB) live on `starter`; multi-process or GUI-heavy agents
 * recommend `agent` and gracefully fall back when an account's capacity
 * can't accommodate that size.
 *
 * Unlisted agents default to `starter`.
 */
export const SPAWN_AGENT_TIER: Record<string, string> = {
  claude: "starter",
  codex: "starter",
  opencode: "starter",
  pi: "starter",
  junie: "starter",
  kilocode: "agent",
  hermes: "agent",
  openclaw: "agent",
  t3code: "agent",
};

/**
 * Per-spawn capacity envelope derived from `rig limits` (or the hardcoded
 * fallback when limits aren't available). These are the fields that matter
 * for tier selection: per-VM RAM/CPU ceilings, remaining running CPU, disk
 * budget, and remaining workspace slots.
 */
export interface TierCapacity {
  maxRamPerVmMb: number;
  maxVcpuPerVm: number;
  remainingRunningVcpus: number;
  remainingDiskMb: number;
  remainingVmSlots: number;
}

/** Build a TierCapacity from the live `rig limits` response. */
export function capacityFromLimits(limits: Limits["limits"], usage: Limits["usage"]): TierCapacity {
  return {
    maxRamPerVmMb: limits.max_ram_per_vm_mb,
    maxVcpuPerVm: limits.max_vcpu_per_vm,
    remainingRunningVcpus: Math.max(0, limits.max_running_vcpus - usage.running_vcpus),
    remainingDiskMb: Math.max(0, limits.max_disk_total_mb - usage.total_disk_mb),
    remainingVmSlots: Math.max(0, limits.max_vms - usage.workspace_count),
  };
}

/**
 * Last-resort fallback when `rig limits` isn't available (older rig
 * CLI, transient network failure). Matches the prior subscription-keyed
 * behavior: free users get the FREE_MAX_RAM_PER_VM_MB ceiling, pro
 * users get PRO_MAX_RAM_PER_VM_MB. Assumes a clean slate — full disk
 * budget, full workspace slots — so it's never *more* restrictive than
 * the real capacity, only less accurate.
 *
 * Source-of-truth for the constants: server/rig-data-store/src/models.rs.
 */
export function fallbackCapacityFromSubscription(plan: Subscription): TierCapacity {
  if (plan === "pro") {
    return {
      maxRamPerVmMb: 8192,
      maxVcpuPerVm: 4,
      remainingRunningVcpus: 4,
      remainingDiskMb: 20480,
      remainingVmSlots: 5,
    };
  }
  return {
    maxRamPerVmMb: 2048,
    maxVcpuPerVm: 2,
    remainingRunningVcpus: 4,
    remainingDiskMb: 10240,
    remainingVmSlots: 3,
  };
}

function fitsCapacity(tier: SpawnTier, cap: TierCapacity): boolean {
  return (
    tier.ramMb <= cap.maxRamPerVmMb &&
    tier.vcpuCount <= cap.maxVcpuPerVm &&
    tier.vcpuCount <= cap.remainingRunningVcpus &&
    tier.diskMb <= cap.remainingDiskMb &&
    cap.remainingVmSlots >= 1
  );
}

/**
 * Largest tier (by RAM) that fits the capacity, scanning heavy→nano.
 * Returns null when nothing fits.
 */
function largestFittingTier(cap: TierCapacity): SpawnTier | null {
  for (const id of TIER_ORDER_DESCENDING) {
    const tier = SPAWN_TIERS[id];
    if (tier && fitsCapacity(tier, cap)) {
      return tier;
    }
  }
  return null;
}

/** Build a human-actionable reason string for an override that can't fit. */
function explainOverflow(tier: SpawnTier, cap: TierCapacity): string {
  const reasons: string[] = [];
  if (tier.ramMb > cap.maxRamPerVmMb) {
    reasons.push(`needs ${tier.ramMb} MB per-VM RAM but your account is capped at ${cap.maxRamPerVmMb} MB`);
  }
  if (tier.diskMb > cap.remainingDiskMb) {
    reasons.push(`needs ${tier.diskMb} MB disk but only ${cap.remainingDiskMb} MB remaining in your account budget`);
  }
  if (tier.vcpuCount > cap.maxVcpuPerVm) {
    reasons.push(`needs ${tier.vcpuCount} vCPU but your account is capped at ${cap.maxVcpuPerVm} vCPU per VM`);
  }
  if (tier.vcpuCount > cap.remainingRunningVcpus) {
    reasons.push(`needs ${tier.vcpuCount} running vCPU but only ${cap.remainingRunningVcpus} vCPU remain`);
  }
  if (cap.remainingVmSlots < 1) {
    reasons.push("you're already at your workspace limit");
  }
  return reasons.join("; ");
}

function upgradeHint(plan: Subscription): string {
  return plan === "free"
    ? "Upgrade at https://rigbox.dev/billing for more headroom."
    : "Free up resources or contact support to raise your limits.";
}

/**
 * Pick the effective tier for this spawn.
 *
 * - If `override` is set: must exist in the registry AND fit the
 *   capacity. The error message names the *specific* failing
 *   constraint so the user knows what to fix.
 * - Else: the agent's recommended tier wins if it fits the capacity.
 *   Otherwise fall back to the largest tier that does, logging a
 *   one-line warning that names the binding constraint.
 * - If nothing fits at all (e.g. workspace slot exhaustion, zero
 *   remaining disk), throw `capacity_exceeded`.
 */
export function resolveTier(
  agentName: string,
  capacity: TierCapacity,
  subscription: Subscription,
  override: string | undefined,
  logWarn: (msg: string) => void,
): SpawnTier {
  if (capacity.remainingVmSlots < 1) {
    throw new RigError(
      "capacity_exceeded",
      "You're at your workspace limit. Delete a workspace or upgrade at https://rigbox.dev/billing.",
      1,
    );
  }

  if (override) {
    const tier = SPAWN_TIERS[override];
    if (!tier) {
      throw new RigError(
        "validation",
        `Unknown --size '${override}'. Valid sizes: ${Object.keys(SPAWN_TIERS).join(", ")}.`,
        1,
      );
    }
    if (!fitsCapacity(tier, capacity)) {
      throw new RigError(
        "validation",
        `The '${tier.id}' tier doesn't fit your account: ${explainOverflow(tier, capacity)}. ${upgradeHint(subscription)}`,
        1,
      );
    }
    return tier;
  }

  const recommendedId = SPAWN_AGENT_TIER[agentName] ?? "starter";
  const recommended = SPAWN_TIERS[recommendedId] ?? SPAWN_TIERS.starter;
  if (fitsCapacity(recommended, capacity)) {
    return recommended;
  }

  const fallback = largestFittingTier(capacity);
  if (!fallback) {
    throw new RigError(
      "capacity_exceeded",
      `No workspace size fits your remaining capacity (${capacity.maxRamPerVmMb} MB RAM cap, ${capacity.maxVcpuPerVm} vCPU cap, ${capacity.remainingRunningVcpus} running vCPU remaining, ${capacity.remainingDiskMb} MB disk). ${upgradeHint(subscription)}`,
      1,
    );
  }
  logWarn(
    `${agentName} recommends the '${recommended.id}' tier (${recommended.ramMb} MB RAM, ${recommended.vcpuCount} vCPU, ${recommended.diskMb} MB disk) ` +
      `but your account is capped at ${capacity.maxRamPerVmMb} MB RAM per VM, ${capacity.maxVcpuPerVm} vCPU per VM, ` +
      `${capacity.remainingRunningVcpus} running vCPU remaining, and ${capacity.remainingDiskMb} MB disk remaining. ` +
      `Falling back to '${fallback.id}'. ${upgradeHint(subscription)}`,
  );
  return fallback;
}

/** Highest tier the user could pick today; used by the subscription-only
 * fallback path so the prior behavior remains stable when `rig limits`
 * isn't available. */
export function highestAllowedTier(plan: Subscription): SpawnTier {
  return largestFittingTier(fallbackCapacityFromSubscription(plan)) ?? SPAWN_TIERS.nano;
}
