# LLM Town Square

LLM Town Square is a local bridge between Codex's native task messaging and Claude Code's native
cross-session messaging. Codex tasks and Claude sessions address each other by their ordinary
native names; stable thread and session IDs remain internal.

There is no registration database, CLI, installed skill, mandatory name prefix, queue polling, or
automatic reply forwarding. The relay starts with the HTTP server and exposes a JSON API plus a
browser inspector.

## How it works

- A real Codex task's native title is its address. Renaming the task changes its address without
  changing its stable identity.
- A Claude session's native name is mirrored as a marked Codex proxy task with exactly that name.
- Names share one case-insensitive namespace. `test`, `Test`, and `TEST` are the same address.
- Duplicate live names are temporarily unroutable. Each conflicting session is asked once to
  rename itself, and routing resumes automatically when the names become unique.

Claude continues to use its native `ListAgents` and `SendMessage` transport. Town Square mirrors
each real Codex task into Claude's peer list. Claude-to-Codex messages use Codex Desktop's
owner-side `send_message_to_thread` path: an active turn is steered immediately, while an idle
task starts a normal turn. The existing owner-aware `thread/queue/add` path remains the safe
fallback when the Desktop steering helper is unavailable.

For the other direction, each live Claude session has a marked Codex proxy backed by a local,
authenticated, no-inference Responses provider. Native Codex task messaging addressed to the
proxy is forwarded to Claude, and the provider completes without model inference or a generated
reply. Proxy creation uses a short-lived app-server process so it does not retain the task's
rollout writer.

A hidden no-inference Desktop helper provides narrowly scoped access to owner-side operations. It
uses `send_message_to_thread` for Claude-to-Codex delivery and, when Desktop owns a closed proxy's
writer, `set_thread_archived` to archive that proxy safely. The relay never archives, deletes, or
renames user-owned Codex tasks.

### Steering architecture

```text
Claude SendMessage
       |
       v
Town Square relay (HTTP on 127.0.0.1:7777)
       |
       +-- priority --> private Unix socket --> Desktop helper --> Codex Desktop
       |                                                       +-- active: steer turn
       |                                                       `-- idle: start turn
       |
       `-- fallback ------------------------------------------> durable Codex queue
```

The Desktop helper is not a second HTTP service and does not run a model. It is one small local
process, launched by Codex Desktop, that listens only on private Unix sockets. The same helper
supports both steering and proxy archival.

This indirection is required by Codex's turn ownership model. `turn/steer` needs the ID of the
currently active turn, and a separate app-server process does not own the turn already open in
Desktop. The helper asks Desktop's owner-side `send_message_to_thread` operation to deliver the
message; Desktop chooses whether to steer the active turn or start an idle task. Town Square's
ordinary app-server connection remains responsible for inventory, configuration, proxy lifecycle,
and durable queue fallback.

## Installation

Requirements:

- macOS or Linux with Unix-domain sockets
- Node.js 20 or newer
- Codex 0.151.0 or newer on `PATH`
- Claude Code when Claude bridging is required
- Git to clone the repository

Clone the repository:

```bash
git clone https://github.com/davidatch/llmtownsquare.git
cd llmtownsquare
```

The project has no npm dependencies, so no package installation step is required. Start it from
the repository root:

```bash
npm start
```

The server runs in the foreground at <http://127.0.0.1:7777> and starts the relay automatically.
Keep that process running while using Town Square. Stop it with `Ctrl-C`; use an external process
supervisor if it should run persistently or restart automatically.

On startup, the relay writes its authenticated local Codex provider and Desktop-helper
configuration through Codex's app-server API. No skill, shell command, global symlink, Codex
sandbox network permission, or manual registration is required.

After upgrading an already-running Codex Desktop session from a version without steering support,
restart Desktop when its active work is safe to interrupt so its existing hidden helper reloads.
Until then, Claude-to-Codex delivery remains safe and uses the durable queue fallback.

To use a different port:

```bash
TOWNSQUARE_PORT=8787 npm start
```

## HTTP API

All `/api/*` responses are JSON. POST requests must use `Content-Type: application/json`;
`/events` and `/v1/responses` return server-sent event streams.

| Method | Endpoint | Purpose |
|---|---|---|
| `GET` | `/api/health` | Server, relay, native app-server, and inventory health |
| `GET` | `/api/agents` | Reachable Claude sessions, real Codex tasks, and the relay |
| `GET` | `/api/threads` | Non-archived native Codex inventory, including marked proxies |
| `POST` | `/api/send` | Send one explicit message using `{from?, fromThread?, to, text}` |
| `GET` | `/api/messages?since=&limit=` | Read the in-memory traffic log |
| `GET` | `/events` | Server-sent inspector updates |
| `POST` | `/v1/responses` | Authenticated internal no-inference proxy transport |

The server has no lifecycle API. Starting, stopping, and restarting the HTTP process are external
process-management operations.

### Inspect health and identities

```bash
curl -s http://127.0.0.1:7777/api/health
curl -s http://127.0.0.1:7777/api/agents
curl -s http://127.0.0.1:7777/api/threads
curl -s 'http://127.0.0.1:7777/api/messages?limit=40'
```

### Send a message

Use a stable Codex thread ID when a real Codex task is the sender:

```bash
curl -sS -X POST http://127.0.0.1:7777/api/send \
  -H 'Content-Type: application/json' \
  -d '{
    "fromThread": "01a02e5d-ffc7-7ea2-8f01-40d17cad8b0e",
    "to": "researcher",
    "text": "Please inspect the failing test."
  }'
```

Use a Claude session's unique native name when Claude is the sender:

```bash
curl -sS -X POST http://127.0.0.1:7777/api/send \
  -H 'Content-Type: application/json' \
  -d '{"from":"claude-helper","to":"reviewer","text":"Review the proposed fix."}'
```

If both `from` and `fromThread` are omitted, the sender is the relay identity (`townsquare` by
default). The relay can post to its own web inbox or send to Claude, but it cannot originate a
native Codex delegation because it has no Codex thread ID.

Delivery is one-way. A successful request confirms that the message was steered, posted, or
queued; it does not wait for an answer. Any response must be sent as a separate native message.

## Web inspector

Open <http://127.0.0.1:7777> to see reachable agents and recent in-memory traffic. The inspector
also sends messages through `POST /api/send`.

## Configuration

| Variable | Default | Meaning |
|---|---:|---|
| `TOWNSQUARE_PORT` | `7777` | Loopback HTTP and provider port |
| `TOWNSQUARE_NAME` | `townsquare` | Relay and web-inbox identity |
| `TOWNSQUARE_CODEX_BIN` | `codex` | Codex executable |
| `TOWNSQUARE_SWEEP_MS` | `5000` | Native inventory reconciliation interval |
| `TOWNSQUARE_CODEX_REQUEST_TIMEOUT_MS` | `30000` | App-server request timeout |
| `TOWNSQUARE_CODEX_RECONNECT_MS` | `2000` | App-server reconnect delay |
| `TOWNSQUARE_STATE_DIR` | `~/.townsquare` | Provider token and helper socket directory |
| `TOWNSQUARE_PROVIDER_TOKEN_FILE` | `<state-dir>/codex-provider-token` | Provider token path |
| `TOWNSQUARE_CLAUDE_SESSIONS_DIR` | `~/.claude/sessions` | Claude's native session registry |
| `TOWNSQUARE_SOCK_DIR` | Claude runtime socket directory | Override for virtual-peer sockets |
| `TOWNSQUARE_FROM_MODE` | `prompting` | Claude cross-session sender mode |
| `TOWNSQUARE_ARCHIVE_HELPER_NODE` | Desktop bundled Node on macOS | Desktop-helper Node executable override |
| `TOWNSQUARE_ARCHIVE_HELPER_SOCK` | `<state-dir>/codex-archive-helper.sock` | Desktop-helper archive socket override |
| `TOWNSQUARE_STEERING_HELPER_SOCK` | `<state-dir>/codex-steering-helper.sock` | Desktop-helper steering socket override |

## Safety and errors

The server binds only to `127.0.0.1`. Its internal Responses endpoint requires a random token
stored with mode `0600`; do not expose the server through a public proxy or non-loopback bind.

Path overrides should point to dedicated Town Square state or socket locations. Town Square does
not change permissions on pre-existing directories. Registry writes require the configured
Claude sessions directory to be owned by the current user and not writable by other users. Town
Square removes only Unix sockets at expected paths that are confirmed inactive; regular files,
symlinks, live sockets, and uncertain paths are preserved. Startup replaces only the
`model_providers.llmtownsquare_bridge` and `mcp_servers.townsquare_archive_helper` Codex
configuration entries owned by this project. It also disables the retired
`mcp_servers.townsquare_steering_helper` entry during migration from older releases.

The API returns JSON errors with conventional status codes: `400` for invalid input, `401` for an
invalid provider token, `404` for unknown routes or names, `409` for name conflicts, `413` for an
oversized body, `415` for non-JSON POST bodies, and `503` while the relay is unavailable.

## License and disclaimer

Copyright 2026 David Atch. Licensed under the [Apache License 2.0](LICENSE).

LLM Town Square is provided on an **as-is** basis, without warranties or conditions of any kind.
It can deliver instructions to active AI coding tasks, which may modify files, run commands, or
interact with other configured tools. Review agent permissions, preserve appropriate backups, and
evaluate messages before using the software in sensitive or production environments. See the
license for the complete warranty disclaimer and limitation of liability.

## Manual LLM instructions

[`SKILL.md`](SKILL.md) is a concise, runtime-neutral guide that can be supplied manually to an LLM.
It is reference material only and is never installed or loaded automatically.

## Development

Run the test suite with:

```bash
npm test
```

The integration tests use loopback TCP and Unix-domain sockets and may require permission to bind
local sockets in restricted development environments.
