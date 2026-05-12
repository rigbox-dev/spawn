#!/usr/bin/env bun

// rigbox/main.ts — Orchestrator: deploys an agent on Rigbox.
//
// Rigbox is a managed workspace host. Every supported agent has a
// pre-baked catalog recipe (see SPAWN_TO_RIGBOX_RECIPE in ./agents.ts)
// that install.sh inside the workspace at first boot. The orchestrator's job
// here is auth → POST /workspaces with the recipe ID → forward the
// user's OpenRouter key (or flip to managed proxy) → open the
// interactive SSH session.

import type { CloudOrchestrator } from "../shared/orchestrate.js";

import { getErrorMessage } from "@openrouter/spawn-shared";
import pkg from "../../package.json" with { type: "json" };
import { runOrchestration } from "../shared/orchestrate.js";
import { initTelemetry } from "../shared/telemetry.js";
import { logInfo, logStep } from "../shared/ui.js";
import { agents, resolveAgent, rigboxRecipeFor } from "./agents.js";
import {
  authenticate,
  createWorkspace,
  destroyWorkspace,
  downloadFile,
  enableManagedProxy,
  getConnectionInfo,
  getServerName,
  interactiveSession,
  isManagedMode,
  runServer,
  setForwardedOpenRouterKey,
  setManagedMode,
  uploadFile,
} from "./rigbox.js";

async function main() {
  const agentName = process.argv[2];
  if (!agentName) {
    console.error("Usage: bun run rigbox/main.ts <agent>");
    console.error(`Agents: ${Object.keys(agents).join(", ")}`);
    process.exit(1);
  }

  const agent = resolveAgent(agentName);
  const recipeId = rigboxRecipeFor(agentName);

  // --managed is a rigbox-specific flag: route AI through the Rigbox
  // managed proxy instead of forwarding the user's OpenRouter key.
  // Default behavior forwards the key (one less bill on Rigbox).
  if (process.argv.includes("--managed")) {
    setManagedMode(true);
    // Suppress spawn's OpenRouter key validation — under managed mode
    // we never actually use the user-supplied key, so a missing or
    // invalid one shouldn't block the flow.
    process.env.SPAWN_SKIP_API_VALIDATION = "1";
  }

  const cloud: CloudOrchestrator = {
    cloudName: "rigbox",
    cloudLabel: "Rigbox",
    // The catalog recipe installs the agent during first_boot — spawn
    // skips its own install path entirely.
    skipAgentInstall: true,
    // Rigbox workspaces do not run cloud-init the way Hetzner/DO do.
    skipCloudInit: true,
    runner: {
      runServer,
      uploadFile,
      downloadFile,
    },
    async authenticate() {
      await authenticate();
    },
    async promptSize() {
      // No region/size picker yet — Rigbox runs in a single global
      // fleet and uses the user's per-account default sizing.
    },
    async createServer(name: string) {
      // The top-level CLI captures `--size <tier>` and exports the
      // chosen tier via RIGBOX_TIER for the rigbox cloud (see
      // index.ts:1117). Empty string means no override → use the
      // per-agent recommended tier.
      const sizeOverride = process.env.RIGBOX_TIER || undefined;
      const connection = await createWorkspace(name, recipeId, agentName, sizeOverride);

      // After the workspace is running, wire up AI routing. Default
      // path forwards the spawn-OAuth'd OpenRouter key into the VM
      // env. The agent's /etc/profile.d/<agent>-routing.sh on the
      // Rigbox side translates that into the agent-native env shape.
      if (isManagedMode()) {
        logStep("Switching workspace to Rigbox managed AI proxy");
        await enableManagedProxy();
      } else {
        const openRouterKey = process.env.OPENROUTER_API_KEY;
        if (openRouterKey) {
          logStep("Forwarding OpenRouter key into the workspace env");
          await setForwardedOpenRouterKey(openRouterKey);
        } else {
          logInfo(
            "OPENROUTER_API_KEY not set — workspace will boot without a forwarded key. " +
              "Use --managed for the Rigbox managed proxy, or `rig ssh-info` to wire one in manually.",
          );
        }
      }

      return connection;
    },
    getServerName,
    async waitForReady() {
      // createServer already polled `status === "running"` — nothing
      // more to do at the cloud-init layer.
    },
    async interactiveSession(cmd: string, spawnFn?: (args: string[]) => number) {
      return interactiveSession(cmd, spawnFn);
    },
    getConnectionInfo,
  };

  // `destroyWorkspace` is the cleanup hook for `spawn delete -c rigbox`.
  // CloudOrchestrator doesn't surface it formally (yet) — the delete
  // command resolves it via the registry side of orchestrate.ts in
  // production. Keeping the import live here so the bundler doesn't
  // strip it; expose via a side channel when upstream wires delete.
  void destroyWorkspace;

  await runOrchestration(cloud, agent, agentName);
}

initTelemetry(pkg.version);
main().catch((err) => {
  process.stderr.write(`\x1b[0;31mFatal: ${getErrorMessage(err)}\x1b[0m\n`);
  process.exit(1);
});
