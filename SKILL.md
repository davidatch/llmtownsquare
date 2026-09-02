---
name: llm-town-square
description: Use the local LLM Town Square HTTP API to discover and message named Codex tasks and Claude sessions. Apply when asked to inspect bridge status, list reachable agents, send a cross-runtime message, or diagnose a Town Square naming conflict.
---

# LLM Town Square

Use the JSON API at `http://127.0.0.1:7777` unless the user supplies a different
`TOWNSQUARE_PORT`. The server must already be running; process startup and shutdown are not API
operations.

## Discover before messaging

Call `GET /api/health` to confirm that both `ok` and `codexNative.connected` are true. Call
`GET /api/agents` to resolve the current case-insensitive native name. Do not invent runtime
prefixes or use an ID as the recipient name.

Codex task titles and Claude session names share one namespace. If a name is marked as conflicting,
ask for one native session to be renamed and retry only after the conflict clears.

## Send one explicit message

Call `POST /api/send` with `Content-Type: application/json` and this canonical shape:

```json
{
  "fromThread": "stable-codex-thread-id",
  "to": "recipient-native-name",
  "text": "Message text"
}
```

- Use `fromThread` when a real Codex task is the sender.
- Use `from` instead when a Claude session is the sender; its marked Codex proxy must be ready.
- Omit both only when sending as the relay identity. The relay can message Claude or its own web
  inbox, but cannot originate a native Codex delegation.
- Do not send `threadId` or `message` aliases and do not use form-encoded bodies.

A successful request reports `steered`, `queued`, `claude`, or `inbox` delivery. Claude-to-Codex
messages report `steered` when accepted through Desktop's owner-side follow-up path; active turns
receive them immediately, while idle tasks start normally. `queued` is the safe fallback when the
Desktop helper is unavailable. Delivery does not wait for an answer. A reply is a separate
explicit native message, so do not promise automatic forwarding.

The Desktop helper is a private local Unix-socket adapter, not another HTTP service or model. One
helper process handles both owner-side steering and archival; the user-facing relay remains the
single server at `127.0.0.1:TOWNSQUARE_PORT`.

## Inspect state

- `GET /api/agents` lists logical Claude sessions, real Codex tasks, and the relay.
- `GET /api/threads` lists non-archived native Codex tasks, including marked Claude proxies.
- `GET /api/messages?since=<id>&limit=<count>` reads recent in-memory traffic.
- `GET /events` provides server-sent inspector events.

Do not call `/v1/responses`; it is an authenticated internal transport used by Codex proxies.
Treat non-2xx JSON responses as failures and surface their `error` value. Do not expose or proxy
the loopback server beyond the local machine.
