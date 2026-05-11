// rigbox/agents.ts — Map spawn agent IDs onto Rigbox catalog recipe IDs.
//
// Rigbox ships pre-baked catalog recipes for a subset of spawn's agents.
// When the spawn agent has a matching recipe, we pass that ID to
// `POST /v1/workspaces { catalog_ids: [...] }` so the agent installs
// during VM boot (Mode A). The orchestrator then sets
// `skipAgentInstall: true` so spawn does not also try to install.
//
// Agents without a recipe (currently cursor) error out — spawn-on-rigbox
// is opt-in by recipe and we'd rather fail fast than silently provision
// a bare workspace and confuse the user.

import { createCloudAgents } from "../shared/agent-setup.js";
import { downloadFile, runServer, uploadFile } from "./rigbox.js";

export const { agents, resolveAgent: baseResolveAgent } = createCloudAgents({
  runServer,
  uploadFile,
  downloadFile,
});

/**
 * Spawn agent ID → Rigbox catalog recipe ID. Identity for most agents;
 * the two exceptions are openclaw (catalog item is `openclaw-gateway`
 * — the registered subject is the dashboard daemon) and hermes (catalog
 * item is `hermes-agent`).
 *
 * Update this table when new Rigbox recipes ship.
 */
export const SPAWN_TO_RIGBOX_RECIPE: Record<string, string> = {
  claude: "claude",
  codex: "codex",
  hermes: "hermes-agent",
  junie: "junie",
  kilocode: "kilocode",
  opencode: "opencode",
  openclaw: "openclaw-gateway",
  pi: "pi",
  t3code: "t3code",
};

export function rigboxRecipeFor(agentName: string): string | undefined {
  return SPAWN_TO_RIGBOX_RECIPE[agentName];
}

export function resolveAgent(name: string): ReturnType<typeof baseResolveAgent> {
  if (!SPAWN_TO_RIGBOX_RECIPE[name]) {
    throw new Error(
      `Agent "${name}" is not yet supported on Rigbox cloud. ` +
        `Supported: ${Object.keys(SPAWN_TO_RIGBOX_RECIPE).join(", ")}. ` +
        "Open an issue at https://github.com/rigbox-dev/spawn to request it.",
    );
  }
  return baseResolveAgent(name);
}
