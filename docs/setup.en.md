# Reproduce

This page describes behavior only. It contains no host name, account, or key. Replace the placeholders with your own values.

## What one route is

A route is three things: one DeepSeek Harness model, one remote machine running official `agy` and signed in as itself, and one entry in the local config. Chat, tool transport, and quota display are one code path. The plugin runs that path once per route. There is no second plugin.

## The remote machine

Install the same official `agy` version on every machine. Sign each machine in to its own Google account:

```bash
agy acp --login
```

The token is stored at `.gemini/antigravity-cli/antigravity-oauth-token` under that user's home. Do not copy it to another machine or commit it.

The execution setting the plugin writes, in `$HOME/.dsh-antigravity/agy/settings.json`, is:

```json
{
  "toolPermission": "always-proceed",
  "agentMode": ""
}
```

`always-proceed` stops per-call prompts for MCP, commands, and web tools. Deny rules still apply.

The isolated home also contains an agent named `dsh-bridge`:

- `plugin.json` names `dsh-bridge`
- the agent front matter is `tools: []`, `excludeDefaultComponents: true`, `mainAgent: true`
- the body is the system prompt: use only the tools DeepSeek Harness provides, do not use built-in terminal or file tools, and show images as Markdown with absolute paths rather than base64

Each time a route starts, the plugin rewrites the agent file, `plugin.json`, and `settings.json` on that route's machine, and copies that machine's own token into the isolated home with mode `600`. A change to this preparation runs on every configured machine the next time the plugin loads.

Trust that machine's own home directory as a workspace. Do not copy another machine's path.

## The local plugin

Config lives in `~/.dsh/antigravity-acp.local.json` and is not committed. One route uses the flat fields. Several routes use a `routes` array. Every item has the same fields: `id`, `provider`, `providerName`, `modelName`, `sshHost`, `sshKey`, `mcpPort`, `home`, `quotaUrl`, and `quotaCredential`.

Use a distinct provider id and MCP port per route. Keep the first route's `id` as `primary` if you want existing session keys to stay valid. `home` must be expanded by the remote shell.

After you change `index.js`, `quota.js`, or `client.js` and reload the plugin, the change applies to every route. That includes the system prompt, session caps, idle reclaim, the tool tunnel, and how quota is drawn.

## The quota bridge

Quota is not read from the ACP session. Each remote machine runs the same local HTTP program, bound to `127.0.0.1`, which calls that machine's own `agy` for `/usage` and `models`. The computer running DeepSeek Harness opens one SSH local forward per route.

The plugin does not upload the bridge program. Keep those files identical yourself: deploy the same build to every machine and restart the bridge there. Keys may differ, but each route's `quotaCredential` must match the bearer that machine's bridge checks.

A route without a bridge can still chat. Its row in Settings says quota is unavailable.

## What you should see

- One Gemini 3.8 Flash entry per route. The selected entry decides which machine receives the chat.
- One quota row per route in the Antigravity subscription section.
- A composer badge for the selected route only.
- Sessions, workers, and quota are not shared across routes. A memory cap applies only to that machine.
