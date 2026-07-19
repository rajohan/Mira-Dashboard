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

Chat is split into provider-independent layers. OpenClaw-specific shapes stop at
the adapter boundary:

```text
OpenClaw Gateway
  -> backend OpenClawChatBridge (bounded replay journal)
  -> frontend OpenClaw transport + adapter (raw shapes -> canonical events)
  -> chat reducer (session/run state machine)
  -> reconciliation + visibility projection
  -> existing Chat UI components
```

`Chat.tsx` composes the view. History, input media, scrolling, commands, models,
and runtime replay each have a focused controller. The domain reducer and
projection functions do not know RPC method names or OpenClaw event variants.
Supporting another provider should require a new `ChatTransport` adapter, not
changes throughout the reducer or UI.

The runtime combines several event sources into one visible conversation:

- historical session messages;
- live assistant deltas;
- runtime events;
- tool call diagnostics;
- tool result diagnostics;
- terminal chat state events.

### Transcript And Runtime Authority

Dashboard uses two complementary history sources:

- while a run is active, the Dashboard runtime replay journal is authoritative
  for thinking, tool diagnostics, and control events that may not exist in the
  OpenClaw transcript yet;
- after a final answer, OpenClaw `chat.history` is canonical for transcript-backed
  user, assistant, and tool messages, while runtime replay continues to supply
  runtime-only thinking and control data;
- completed sessions that never entered Dashboard's runtime cache, including
  heartbeat sessions, can still be loaded from OpenClaw by session key. Their
  transcript is available, but thinking is not recoverable from
  `chat.history`.

The first history load for a selected session follows every OpenClaw offset page
and builds the complete transcript. Later refreshes fetch the first page and
walk backward only until they overlap the cached sequence watermark. The browser
keeps an LRU cache of two complete session transcripts. Incremental reuse
requires complete `__openclaw.seq` metadata; if any loaded message lacks a
sequence, Dashboard performs a full uncached load and does not advance the
watermark. Every refresh still revalidates the newest page by sequence, even
when the total row count is unchanged, so same-sequence image hydration or
tool-result rewrites replace stale cached rows without reloading older pages.

### Runtime Replay Cache

The backend bridge keeps bounded replay state in memory and mirrors it to
SQLite so active and completed thinking can survive a backend or VPS restart.
Replay is partitioned by Gateway credential scope, normalized session key, and
then run ID. Main and ops sessions therefore have independent caches, and each
session can retain up to four runs.

SQLite uses two related tables:

- `chat_runtime_snapshots` stores session-level replay metadata;
- `chat_runtime_snapshot_events` stores one serialized replay event per runtime
  sequence.

The current `rows-v2` metadata stores a SHA-256 fingerprint for every retained
event. An unchanged prefix only appends new event rows; coalescing, trimming, or
a same-sequence content change replaces stale rows. Older inline and `rows-v1`
cache layouts are intentionally unsupported and should be cleared or migrated
when deploying the schema change.

Replay limits are:

- 1,000,000 serialized bytes per event;
- 64,000,000 serialized bytes or 20,000 events per active run;
- four runs per session;
- 50 persisted sessions per Gateway scope;
- 256,000,000 serialized bytes across in-process replay state.

When the process-wide memory budget is exceeded, completed sessions are evicted
before active sessions, oldest first. The current session is preferred while
another candidate exists, but remains a last-resort eviction candidate so the
limit stays hard. Its latest state is flushed to SQLite before memory eviction
and can be rehydrated transiently on demand. The latest completed run remains
available until the next successful send for that session. An abandoned active
run expires after six hours without an event. Successful `/new` or `/reset`,
abort, session deletion, and Gateway credential changes clear the applicable
replay cache.

The canonical reducer is ordered and idempotent. Run identifiers and aliases are
always session-scoped. Snapshot gating applies only to the selected session, so
off-screen terminal events continue to clean up their own runs while a snapshot
is in flight. Canonical history wins reconciliation after a terminal refresh;
transient diagnostics are inserted before the matching final answer. Exact tool
call IDs may match results across a later user boundary, while name-only fallback
matching remains bounded to the current user turn. Transcript order and runtime
sequence take precedence over message timestamps when a queued user message and
compaction final carry inverted wall-clock times. Projection indexes exact tool
IDs once per pass and caches fallback signatures so long runs do not rescan or
reserialize the complete transcript for every runtime diagnostic. Once a
completed final is matched, only unscoped canonical diagnostics after the
previous primary answer and that matched final adopt the completed run ID.
Scoping requires an explicit run match or primary assistant output whose final is
timestamp/diagnostic anchored or has one unique text match in the response
segment. Media-only finals use the same unique-match rule with their media
identity. Metadata-only and diagnostic-only completions cannot claim a canonical
answer, and identical unanchored finals remain unscoped. Projection exposes both
the scoped row key and previous unscoped history key as delete aliases; the
delete action persists every alias. This keeps tool row keys stable when
transcript-backed runtime events are compacted, avoids claiming diagnostics from
overlapping runs, keeps hidden tool media with the final, and keeps retained
thinking after the canonical tools but before the final answer.

Session controls are Gateway-backed rather than Dashboard-only preferences:

- model selection patches the selected session;
- thinking options come from the selected session/model capabilities;
- speed maps to the Gateway fast-mode override (`auto`, enabled, or disabled);
- compact context invokes the Gateway compaction flow for that session;
- sparse session records inherit matching Gateway defaults instead of being
  treated as unsupported.

Thinking/reasoning, tool diagnostics, keeping thinking after final, and the
default tool-detail expansion state are grouped in the composer's Chat display
drawer and stored in browser local storage. Tool bubbles can also be expanded or
collapsed individually. Changing the global tool-detail setting immediately
applies to every existing bubble and controls the initial state of new bubbles;
the default is collapsed. These settings are presentation-only: raw diagnostics
remain in client state while toggles filter rendering, so hiding and showing
them does not delete current-run data.

Keeping thinking after the final answer is a separate persisted preference. It
is available only while thinking is visible, defaults off, and preserves an
in-progress thinking row until a primary assistant answer supersedes it.

Tool-call failures should render as tool diagnostics, not as the global chat
error banner. The global error banner is reserved for send failures, Gateway
disconnects, and non-tool terminal chat/runtime failures. A tool terminal error
stays out of the global banner even when it arrives before its diagnostic row.

When changing chat event handling, test these cases:

- streaming text merges with final assistant messages;
- a final message does not duplicate a local pending row, recovered-text echo,
  diagnostic-only row, or an earlier final from the same run;
- overlapping follow-up runs retain their own legitimate final messages;
- live tool result updates merge into the matching row;
- failed tool results stay visible when tool output is enabled;
- hiding tool output does not also hide a real terminal chat error;
- run IDs are scoped by session, not treated as globally unique;
- snapshot replay and live delivery interleaving does not duplicate deltas;
- snapshot gating never drops queued events for other sessions;
- restart and reconnect restore active and latest completed thinking from
  SQLite;
- main and ops sessions never share runtime replay state;
- an initial history load follows all pages, while incomplete sequence metadata
  cannot advance an incremental cache watermark;
- same-count first-page rewrites refresh cached tool output without reloading
  older pages;
- coalescing or trimming persisted replay removes stale event rows;
- tool trimming above the per-run byte limit preserves thinking;
- item-stream tool call/output variants are trimmed as transcript-backed tools;
- aggregate memory eviction can rehydrate the evicted session from SQLite;
- exact tool-call IDs can match across user boundaries, while name-only matches
  cannot;
- compaction diagnostics remain before their final when the next queued user
  message has an earlier timestamp;
- compacting transcript-backed runtime tools after final preserves each tool row
  key and the `tools -> thinking -> final` order;
- overlapping completed runs cannot claim diagnostics before another run's final;
- metadata-only completions cannot claim or duplicate another run's final;
- diagnostic-only completions and identical unanchored finals remain unscoped;
- final and diagnostic reconciliation preserve persisted history delete keys;
- scoped deletions remain hidden after completed replay is cleared;
- hidden tool media remains attached to its completed final after compaction;
- media-only finals keep compacted tools before retained thinking;
- completed thinking remains grouped and follows the keep-after-final preference;
- hiding diagnostics does not remove them from cached client state;
- the global tool-detail setting updates existing bubbles and the default for
  new bubbles;
- repeated short final answers in different user turns remain distinct;
- hidden tool attachments never cross a user or run boundary;
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
