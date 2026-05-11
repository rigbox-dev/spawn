# Rigbox cloud — one-liners

[Rigbox](https://rigbox.dev) is a managed Firecracker host. Every shim
in this directory provisions a Rigbox workspace pre-baked with the
named agent's catalog recipe.

```bash
# Install dependencies (one-time)
brew install bun  # or via your package manager

# Launch any supported agent on Rigbox
bash <(curl -fsSL https://openrouter.ai/labs/spawn/rigbox/claude.sh)
bash <(curl -fsSL https://openrouter.ai/labs/spawn/rigbox/codex.sh)
bash <(curl -fsSL https://openrouter.ai/labs/spawn/rigbox/openclaw.sh)
bash <(curl -fsSL https://openrouter.ai/labs/spawn/rigbox/opencode.sh)
bash <(curl -fsSL https://openrouter.ai/labs/spawn/rigbox/hermes.sh)
bash <(curl -fsSL https://openrouter.ai/labs/spawn/rigbox/kilocode.sh)
```

## What happens

1. First-time users are pushed through a browser-based Rigbox login
   (device-code flow against `POST /auth/cli-session`). `rig` CLI
   users have their existing login reused automatically.
2. `POST /v1/workspaces { catalog_ids: ["<recipe>"] }` provisions a
   Firecracker VM with the agent install script baked in.
3. The user's spawn-OAuth'd OpenRouter key is forwarded into the
   workspace env via `POST /v1/workspaces/{id}/env`. The recipe's
   `/etc/profile.d/<agent>-routing.sh` translates `OPENROUTER_*` into
   the agent-native env shape (`ANTHROPIC_*` for claude, `OPENAI_*`
   for codex, native for opencode, `KILO_*` for kilocode).
4. Spawn opens an interactive SSH session against the region host
   (default `eu-west-1.rigbox.dev`; override via `RIGBOX_SSH_HOST`).

## Flags

- `--managed` — route AI through Rigbox's managed proxy instead of
  forwarding your OpenRouter key. One bill on Rigbox.
- `RIG_API_KEY=rb_…` — headless override, skips the browser login.

## Cleanup

```bash
spawn delete -c rigbox --name <workspace>
```
