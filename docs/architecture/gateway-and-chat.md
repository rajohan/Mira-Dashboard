# Gateway And Chat Runtime

Dashboard has two WebSocket layers:

```text
Browser /ws
  |
  v
Dashboard backend
  |
  v
OpenClaw Gateway WebSocket
```

The backend owns the long-lived OpenClaw Gateway connection. Browsers never
connect to OpenClaw directly; they connect to Dashboard `/ws` after Dashboard
auth.

## Startup Token Selection

On backend startup, the Gateway token is selected in this order:

1. `OPENCLAW_GATEWAY_TOKEN`
2. `OPENCLAW_TOKEN`
3. persisted `app_config.gateway_token`

Environment tokens win over the persisted database token. This is intentional:
production should prefer Doppler-managed state over older bootstrap state.

## Bootstrap Validation

First-user bootstrap validates the submitted Gateway token before publishing the
Dashboard user:

1. Reject immediately if bootstrap is already closed.
2. Serialize overlapping first-user attempts in the backend process.
3. Persist and switch to the submitted token.
4. Wait for an authenticated Gateway hello with `gateway.initAndWait(...)`.
5. Create the first user only after Gateway validation succeeds.
6. Roll back the submitted token and user/session state if validation or user
   creation fails.
7. On failure, restore the previously active token afterward, or shut Gateway
   down if there was no previous token.

Invalid Gateway auth returns `401`. Rollback failures return `500` because the
server may need manual inspection.

## Gateway Health

`GET /api/health` reports:

| Field              | Meaning                                                            |
| ------------------ | ------------------------------------------------------------------ |
| `status`           | Backend health state.                                              |
| `gatewayConnected` | Whether the backend Gateway client is authenticated and connected. |
| `sessionCount`     | Gateway session count known to Dashboard.                          |
| `backendCommit`    | Git commit served by the backend when available.                   |

If `gatewayConnected:false`, check:

- `mira-dashboard.service` logs;
- `openclaw-gateway.service` status;
- token mismatch messages;
- token precedence from Doppler and `app_config`.

## Browser WebSocket

The browser `/ws` upgrade requires:

- allowed origin;
- authenticated Dashboard session cookie;
- Dashboard route policy accepting the request.

The WebSocket is used for Gateway state, chat runtime events, live tool
diagnostics, and selected operational updates. Treat browser WebSocket failures
as Dashboard session/origin/Gateway health issues before debugging React state.

## Chat Runtime Model

The chat UI combines several event sources into one visible conversation:

- historical session messages;
- live assistant deltas;
- runtime events;
- tool call diagnostics;
- tool result diagnostics;
- terminal chat state events.

The Dashboard backend keeps a bounded, in-memory replay snapshot for active
runs and the most recently completed run during a short grace period. A browser
requests the selected session's snapshot after connecting and then continues
with sequenced live events. This restores current thinking, tool diagnostics,
and status after refresh or device changes without permanently storing
reasoning. Snapshot payloads are session-scoped, size-limited, and cleared on
Gateway credential changes or backend restart.

Session controls are Gateway-backed rather than Dashboard-only preferences:

- model selection patches the selected session;
- thinking options come from the selected session/model capabilities;
- speed maps to the Gateway fast-mode override (`auto`, enabled, or disabled);
- compact context invokes the Gateway compaction flow for that session;
- sparse session records inherit matching Gateway defaults instead of being
  treated as unsupported.

Thinking/reasoning and tool diagnostics have separate visibility toggles stored
in browser local storage. The composer owns these controls so the setting and
the message it affects stay in one interaction surface. These settings are
presentation-only: raw diagnostics remain in client state while toggles filter
rendering, so hiding and showing them does not delete current-run data.

Keeping thinking after the final answer is a separate persisted preference. It
is available only while thinking is visible, defaults off, and preserves an
in-progress thinking row until a primary assistant answer supersedes it.

Tool-call failures should render as tool diagnostics, not as the global chat
error banner. The global error banner is reserved for send failures, Gateway
disconnects, and terminal chat/runtime failures that are not already represented
by a visible failed tool result.

When changing chat event handling, test these cases:

- streaming text merges with final assistant messages;
- a final message does not duplicate a local pending row, recovered-text echo,
  diagnostic-only row, or an earlier final from the same run;
- overlapping follow-up runs retain their own legitimate final messages;
- live tool result updates merge into the matching row;
- failed tool results stay visible when tool output is enabled;
- hiding tool output does not also hide a real terminal chat error;
- run IDs are scoped by session, not treated as globally unique.
- snapshot replay and live delivery interleaving does not duplicate deltas;
- refresh/reconnect restores only the selected active or latest completed run;
- hiding diagnostics does not remove them from cached client state.
- socket reconnects, compaction replacement runs, and selected-session changes
  cannot leak control or stream state between sessions.

## Local Debug Commands

```bash
curl http://127.0.0.1:3100/api/health
systemctl --user status mira-dashboard.service --no-pager
systemctl --user status openclaw-gateway.service --no-pager
journalctl --user -u mira-dashboard.service -n 160 --no-pager
openclaw status
```

Do not print Gateway token values while debugging. Inspect length/metadata only:

```bash
cd backend
sqlite3 "${MIRA_DASHBOARD_DB_PATH:-data/mira-dashboard.db}" \
  "SELECT key, length(value), updated_at FROM app_config WHERE key='gateway_token';"
```
