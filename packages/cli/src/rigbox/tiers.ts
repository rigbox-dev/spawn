// rigbox/tiers.ts — Subscription-aware workspace sizing for spawn-on-Rigbox.
//
// Each spawn agent recommends a tier ({ramMb, diskMb, vcpuCount}) that
// represents the steady-state size the agent actually wants — not the
// catalog-minimum boot floor `rig spawn --auto-size` falls back to. A
// tier is gated by the minimum Rigbox plan needed to run it.
//
// Tier ceilings derive from the server-side quota constants in
// `server/rig-data-store/src/models.rs`:
//   FREE_MAX_RAM_PER_VM_MB = 2048
//   PRO_MAX_RAM_PER_VM_MB  = 8192
// `starter` sits on the free ceiling; `heavy` sits on the pro ceiling.
//
// `resolveTier` picks the right tier for an (agent, plan, override)
// triple, falling back to the user's plan ceiling with a warning when
// the recommended tier outruns their plan. An explicit `--size` flag
// that's above the plan ceiling is a hard error — we don't silently
// downgrade a user-chosen size.

import { RigError } from "./rig-runner.js";

export type Subscription = "free" | "pro";

export interface SpawnTier {
  id: string;
  ramMb: number;
  diskMb: number;
  vcpuCount: number;
  minPlan: Subscription;
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
    minPlan: "free",
    description: "1 GB RAM · 4 GB disk · 1 vCPU",
  },
  starter: {
    id: "starter",
    ramMb: 2048,
    diskMb: 4096,
    vcpuCount: 2,
    minPlan: "free",
    description: "2 GB RAM · 4 GB disk · 2 vCPU",
  },
  agent: {
    id: "agent",
    ramMb: 4096,
    diskMb: 4096,
    vcpuCount: 2,
    minPlan: "pro",
    description: "4 GB RAM · 4 GB disk · 2 vCPU",
  },
  heavy: {
    id: "heavy",
    ramMb: 8192,
    diskMb: 8192,
    vcpuCount: 4,
    minPlan: "pro",
    description: "8 GB RAM · 8 GB disk · 4 vCPU",
  },
};

/**
 * Recommended tier per spawn agent. Free-fit agents (CLI tools that idle
 * around 1-2 GB) live on `starter`; multi-process or GUI-heavy agents
 * recommend `agent` and gracefully fall back to `starter` for free
 * users with a one-line upgrade prompt.
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

/** Highest tier a plan can use without an explicit override. */
export function highestAllowedTier(plan: Subscription): SpawnTier {
  if (plan === "pro") {
    return SPAWN_TIERS.heavy;
  }
  return SPAWN_TIERS.starter;
}

function tierAllowed(tier: SpawnTier, plan: Subscription): boolean {
  if (tier.minPlan === "free") {
    return true;
  }
  return plan === "pro";
}

/**
 * Pick the effective tier for this spawn.
 *
 * - If `override` is set it must (a) exist in the registry and (b) be
 *   reachable on the user's plan; otherwise we throw `RigError("validation")`.
 * - Otherwise the agent's recommended tier wins, capped at the plan
 *   ceiling. When the recommendation is gated above the plan we log a
 *   one-line warning and return the highest allowed tier instead.
 */
export function resolveTier(
  agentName: string,
  plan: Subscription,
  override: string | undefined,
  logWarn: (msg: string) => void,
): SpawnTier {
  if (override) {
    const tier = SPAWN_TIERS[override];
    if (!tier) {
      throw new RigError(
        "validation",
        `Unknown --size '${override}'. Valid sizes: ${Object.keys(SPAWN_TIERS).join(", ")}.`,
        1,
      );
    }
    if (!tierAllowed(tier, plan)) {
      throw new RigError(
        "validation",
        `The '${tier.id}' tier requires the Pro plan. ` +
          "Either re-run without --size, or upgrade at https://rigbox.dev/billing.",
        1,
      );
    }
    return tier;
  }
  const recommendedId = SPAWN_AGENT_TIER[agentName] ?? "starter";
  const recommended = SPAWN_TIERS[recommendedId] ?? SPAWN_TIERS.starter;
  if (tierAllowed(recommended, plan)) {
    return recommended;
  }
  const fallback = highestAllowedTier(plan);
  logWarn(
    `${agentName} recommends the '${recommended.id}' tier (${recommended.ramMb} MB RAM) ` +
      `but your account is on the ${plan} plan. Falling back to '${fallback.id}'. ` +
      "Upgrade at https://rigbox.dev/billing for the full experience.",
  );
  return fallback;
}
