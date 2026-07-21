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

### Session URL State

The selected chat session is stored in the `/chat?session=<session-key>` query.
Refreshing, opening a copied URL, and browser back/forward navigation therefore
restore the same session. When a plain `/chat` route resolves an available fallback
session, it passes that fallback through the normal selector and persists it in the
URL. Session changes replace the query value, so automatic fallback and routine
picker navigation do not add one browser-history entry per selection. History may
load while a URL-selected session is being resolved, but sending, preference
updates, and compaction remain disabled until that key exists in the Gateway
session index. A previously available selection that disappears is replaced with
the next available fallback. An explicit URL key that has not yet appeared remains
selected until Gateway reports it or the user chooses another session.
The socket provider applies raw array and wrapped response shapes only to the
Promise returned by its own `sessions.list` request. Unrelated RPC responses
therefore cannot clear the session collection merely because their payload is an
array; explicit `sessions` push envelopes remain supported separately.

### Attachments And Media

Dashboard delegates attachment delivery and persistence to OpenClaw through the
provider-independent `ChatTransport`. The composer only prepares the Gateway
attachment contract; it does not maintain a second Dashboard upload store.
Images, audio, PDFs, text/data files, archives, and common Office formats are
accepted. Selected video files are skipped before encoding because OpenClaw chat
does not support them in this flow, while valid files from the same selection are
kept. Audio MIME types take precedence over ambiguous extensions such as `.webm`.

Files can be dropped directly on the composer or added through the attachment
picker. The picker provides its own drop target, native file selection, queued-file
removal, and an inline detail view built from the shared attachment preview content.
Modal drag events do not reach the composer, and a page-level file-drop guard stops
the browser from navigating away when a drop misses the active target.

Validation runs before FileReader output enters chat state. A supported declared
MIME is authoritative. If the browser omits MIME or reports the generic
`application/octet-stream`, a recognized filename extension supplies the canonical
MIME; a non-generic unsupported MIME must agree with that extension instead of
being accepted by filename alone. JSON is accepted from its declared MIME even
without a filename extension, common browser ZIP aliases are normalized to
`application/zip`, CSV's legacy Excel MIME is normalized only for `.csv`, and
ZIP-reported OOXML packages are normalized only for `.docx`, `.xlsx`, or `.pptx`.
The normalized MIME is also used to rebuild the base64 data URL,
so empty-MIME images keep working in picker and optimistic message previews. SVG is
classified as `image/svg+xml` for chat display, while its normal backend download
remains attachment-only as described below. Validation errors are scoped to their
source: picker errors stay in the open picker, and direct-drop errors appear above
the composer, never in both places.

History normalization accepts OpenClaw `image`, `image_url`, and `input_image`
blocks plus generic attachment and `MediaPath` records. Every attachment keeps a
download action. Images render inline; JSON and Markdown use the existing
structured viewers; CSV and plain text use a bounded text preview; other files
remain downloadable. MIME parameters are normalized before the viewer is chosen.
When OpenClaw omits an attachment label, Dashboard derives the filename from the
remote URL pathname rather than signed query parameters. When MIME metadata is
missing, a recognized label extension wins; a friendly label without an extension
falls back to the source path. The known local `/api/media` proxy uses its encoded
`path` query for both fallbacks because the proxy pathname contains no file metadata.
External HTTP(S) text references remain download-only because Dashboard cannot
enforce the bounded preview policy on cross-origin responses. Attachment Markdown
renders image references as plain labels so opening a preview cannot fetch remote
resources.

Managed Gateway image URLs stay authenticated without exposing the Gateway token
to the browser. The browser requests the same managed path from Dashboard under
`/api/chat/media/outgoing/*`; the backend validates OpenClaw's exact UUIDv4-shaped path,
converts the configured Gateway WebSocket origin to HTTP(S), adds the bearer
token server-side, and does not follow redirects. The 30-second upstream timeout
ends after response headers arrive for downloads so a valid slow stream can
finish, while bounded preview reads keep the timeout active through the body. All
managed responses force `Cache-Control: private, no-store` regardless of upstream
cache headers.

Managed TXT, JSON, CSV, and Markdown previews use the same Dashboard proxy with
an explicit `preview=text` query. The backend validates the upstream media type
or filename and stops reading after 1 MiB; the original managed URL remains the
download target. Managed image thumbnails use `preview=image` and stop reading
after 16 MiB; SVG responses additionally use the same restrictive sandbox CSP
as local SVG. Managed SVG, HTML, XHTML, and XML downloads are downgraded to
`application/octet-stream` with attachment disposition so active provider
content cannot render as a same-origin document. Inline thumbnails and full modal
image previews use the bounded preview URL while their download action retains
the original managed URL. Switching attachment previews aborts the prior text
request and ignores any stale completion. History-provided root-relative and
absolute same-origin API image URLs are canonicalized before use. Only the two
known Dashboard media proxy paths may auto-render; dot-segment escapes and other
same-origin API paths are rejected, and absolute managed paths still use bounded
previews. Cross-origin HTTP(S) images remain explicit open/download controls and
are not embedded merely because their transcript is opened.

Local OpenClaw media continues through `/api/media`. Text preview is opt-in and
limited to `.txt`, `.json`, `.csv`, and `.md` files no larger than 1 MiB. SVG is
downloaded as `application/octet-stream` by default and rendered only through an
explicit sandboxed image preview with a restrictive CSP. URL-only local image
blocks infer the SVG case from the proxy `path` before selecting that preview.
These preview rules do not remove the original download action.

An attachment-only optimistic user row remains visible while history is still
waiting for its echo, then reconciles with its canonical managed Gateway URL by
the send run ID when its local base64 identity necessarily differs from the
persisted media identity. Matching remains role- and run-scoped so separate
attachment turns are not collapsed, and an unrelated prior media row cannot
consume the fallback match. URL-only image blocks include their safe source URL
in media identity so distinct generated images in one run remain distinct.

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
event, pending `chat.send` boundaries keyed by request ID, and the latest settled
new-turn boundary when one exists. An unchanged prefix only appends new event
rows; coalescing, trimming, or a same-sequence content change replaces stale
rows. Older inline and `rows-v1` cache layouts are intentionally unsupported and
should be cleared or migrated when deploying the schema change.

Replay limits are:

- 1,000,000 serialized bytes per event;
- 64,000,000 serialized bytes or 20,000 events per active run;
- four runs per session;
- 100 pending outgoing request boundaries per session;
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

A Gateway transport disconnect marks only unfinished `dashboard-chat-*` runs as
eligible for interrupted-run recovery. If the Gateway resumes the same response
under a provider run ID, the bridge rewrites the provisional replay to that
canonical ID before retaining the new lifecycle event. The promotion is allowed
only for one unambiguous active run, inside the bounded restart window, and only
when no newer `chat.send` request boundary exists. Each outgoing request records
its own boundary under the Dashboard idempotency key and flushes it to SQLite
before forwarding the request. A matching acknowledgement or user
`session.message` echo removes only that request's pending boundary. If it
identifies a run that already existed at the boundary, the request is a steer;
otherwise the boundary becomes the durable cutoff for a new turn. Runless steer
acknowledgements may infer continuation only when exactly one active
conversation existed before the boundary. Equivalent canonical and short
session keys share the same boundary state, so alias promotion and concurrent
sends cannot clear or bypass each other. Restart hydration unions pending request
IDs and keeps the highest settled cutoff across equivalent persisted aliases;
snapshot load order is never an ordering authority. A Dashboard, systemd, or VPS
restart therefore cannot change the decision. A delayed event on an older run
does not move its first sequence past this boundary. This keeps pre- and
post-restart thinking, later steer messages, and tools in one ordered response
without merging a genuinely new, stale, or concurrent send. The recorded
disconnect time also protects a long-quiet interrupted run from the normal
six-hour stale run cleanup while that bounded recovery window is open.

The canonical reducer is ordered and idempotent. Run identifiers and aliases are
always session-scoped. Snapshot gating applies only to the selected session, so
off-screen terminal events continue to clean up their own runs while a snapshot
is in flight. Canonical history wins reconciliation after a terminal refresh;
transient diagnostics are inserted before the matching final answer. Runtime
tool IDs reconcile inside the current response segment, or outside it only when
the history row explicitly matches the run. This boundary is required because
some providers reuse short IDs such as `functions.exec:0` in later user turns.
Exact-ID final evidence is bounded on both sides by that response segment. A
follow-up recorded after the run starts cannot become its lower boundary merely
because it falls inside the timestamp-skew allowance; the allowance is only a
fallback when no causal or explicitly matched user boundary exists.
Name-only fallback matching is likewise bounded to the current user turn.
Every runtime user, thinking, and tool entry retains its Gateway sequence. During
reconciliation, projection anchors each run's initiating prompt and reorders its
remaining runtime-owned row slots by that sequence; canonical transcript-only
rows remain anchored. Presentation then collapses all thinking for the run into
exactly one bubble after the last tool or steer. The active status row is
appended last, and a canonical final replaces it as the last row when the run
completes. The resulting contract is therefore
`start -> tools/steers in event order -> one thinking -> active status or final`,
independent of wall-clock timestamps and identical after replay. Transcript
order and runtime sequence also take precedence over message timestamps when a
queued user message and compaction final carry inverted wall-clock times.
Projection indexes exact tool IDs once per pass and caches fallback signatures so
long runs do not rescan or reserialize the complete transcript for every runtime
diagnostic. Once a
completed final is matched, only unscoped canonical diagnostics after the
previous primary answer and that matched final adopt the completed run ID.
Scoping requires an explicit run match or primary assistant output whose final is
timestamp/diagnostic anchored or has one unique text match in the response
segment. Media-only finals use the same unique-match rule with their media
identity, and the selected canonical final must itself match that evidence.
Metadata-only and diagnostic-only completions cannot claim a canonical answer,
and identical unanchored finals remain unscoped. Projection exposes both
the scoped row key and previous unscoped history key as delete aliases; the
delete action persists every alias. This keeps tool row keys stable when
transcript-backed runtime events are compacted, avoids claiming diagnostics from
overlapping runs, keeps hidden tool media with the final, and keeps retained
thinking after the canonical tools but before the final answer.

### Provider Session Messages

OpenClaw providers do not all emit the same live assistant shape. In particular,
Synthetic can place thinking, a tool call, and assistant text inside one
`session.message`. The OpenClaw adapter splits that message into independent
thinking, tool, and primary assistant events before it reaches the reducer. A
Synthetic assistant message with `stopReason: "toolUse"` remains nonterminal;
`stopReason: "stop"` completes the run in both the frontend adapter and backend
replay bridge. Split id-less thinking blocks receive stable per-message identities
so separate provider messages cannot concatenate unrelated reasoning. If one
provider envelope exceeds the adapter event-slot limit, the primary assistant and
terminal finish events are retained ahead of excess diagnostics; development
builds warn with envelope identity when that bound discards drafts. Oversized
terminal replay payloads retain a compact assistant-role/stop marker so refresh
still settles the completed run. A completed runless user/stop pair can adopt a
later provider run ID only while it remains the latest retained run in its own
session, backed by terminal metadata or the same final signature. Bridge-global,
unretained, and other-session sequence gaps therefore do not split the replay,
while newer work in the same session prevents stale adoption. The frontend also
coalesces an immediately repeated, identity-matching Synthetic final into that
completed runless turn. Top-level tool-result messages retain their call ID and
tool name before normalization so they merge into the matching live tool row. An
explicitly run-scoped user boundary takes precedence over timestamp fallback when
locating exact tool evidence. The final primary assistant event never inherits
tool fields from the preceding runtime buffer.

### Virtualized Sticky Bottom

Chat uses TanStack Virtual, so a structural row change can alter `scrollHeight`
again after React commits while row measurements settle. Initial/session history
loads first prime the viewport to the bottom, then wait for a stable measured
height before one final correction. Post-final and reorder corrections wait
passively for the same stability and perform a single bottom write. Repeated
per-frame writes are avoided because they can cycle different virtual windows
through the viewport and appear as flashing tool rows. Real wheel or touch intent
cancels any queued correction immediately.

The explicit Follow action marks the viewport sticky and uses the same bounded
settling pass, so late virtual measurements cannot leave it slightly above the
bottom. Composer layout changes participate in that correction: attachment chips
and the visible global-error content trigger an immediate bottom write followed by
one stable-height correction, but only when the user was already sticky. Deliberate
scroll-away state is preserved.

When the document is hidden, Chat remembers whether the viewport was sticky at
the bottom. Returning to a background tab restores the stable bottom only when
it was sticky before deactivation; a tab the user intentionally scrolled upward
keeps its position.

Session controls are Gateway-backed rather than Dashboard-only preferences:

- model selection patches the selected session;
- thinking options come from the selected session/model capabilities;
- speed maps to the Gateway fast-mode override (`auto`, enabled, or disabled);
- compact context invokes the Gateway compaction flow for that session;
- sparse session records inherit matching Gateway defaults instead of being
  treated as unsupported.

Both the send button and the send handler reject messages while the selected
session is compacting. Dashboard tracks locally initiated compaction RPCs in
addition to provider runtime status and releases the local lock in a `finally`
path, so success, provider failure, disconnect, or a later terminal phase cannot
leave sending permanently disabled.

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
The user can dismiss a visible global error without clearing chat state.

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
- a live Gateway restart promotes one interrupted provisional response to its
  resumed provider run, while a newer send boundary and concurrent runs remain
  separate;
- pending send boundaries survive Dashboard/systemd/VPS restart, overlapping
  requests settle only their own boundary, delayed old events cannot cross the
  settled new-turn cutoff, and a runless steer can clear only one unambiguous
  pre-boundary active conversation;
- live reduction and full replay both preserve
  `start -> tool/steer interleaving -> one thinking -> status/final`, including
  multiple steer messages between tool calls;
- main and ops sessions never share runtime replay state;
- an initial history load follows all pages, while incomplete sequence metadata
  cannot advance an incremental cache watermark;
- same-count first-page rewrites refresh cached tool output without reloading
  older pages;
- coalescing or trimming persisted replay removes stale event rows;
- tool trimming above the per-run byte limit preserves thinking;
- item-stream tool call/output variants are trimmed as transcript-backed tools;
- aggregate memory eviction can rehydrate the evicted session from SQLite;
- reused runtime tool-call IDs do not match across user boundaries without an
  explicit run match, exact evidence is bounded at both ends, and name-only
  matches remain turn-bounded;
- a fast follow-up after run start cannot move a media-only final into the later
  turn;
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
- mixed Synthetic session messages split into tool/thinking/final rows, and only
  `stopReason: "stop"` completes their replay run;
- large Synthetic messages retain their primary final and terminal event, compact
  replay keeps the stop marker, id-less thinking stays as separate blocks, and
  bounded draft loss emits development diagnostics;
- a runless Synthetic completion preserves one live and refreshed run when its
  provider ID arrives across unrelated sequence gaps, while top-level tool results
  retain the identity of their matching calls;
- explicit run-scoped user boundaries keep delayed exact tool evidence and
  media-only finals in their original turn;
- hard-refresh history loads and post-final structural changes settle at the
  virtualized bottom without repeated per-frame scroll writes;
- Follow, attachment-chip height changes, and global-error layout changes settle at
  the real bottom only while sticky, without moving a user who scrolled away;
- a background tab restores the bottom only when it was sticky before becoming
  hidden;
- URL session selection survives refresh and browser navigation, a query-less chat
  persists its resolved fallback, and a previously available session that disappears
  selects the next fallback without replacing a still-unresolved explicit URL key;
- composer and picker drops share attachment validation, mismatched explicit MIME
  cannot bypass policy by filename, empty/generic MIME produces a normalized preview
  data URL only for supported files with a recognized extension, JSON MIME works
  without a suffix, common ZIP aliases and suffix-bound CSV/OOXML aliases are
  canonicalized,
  and validation errors render only at their originating surface;
- local and managed Gateway attachments preserve inline previews and an original
  download path without exposing Gateway credentials;
- managed inline and tool-result images use bounded previews and notify the
  virtualized sticky-scroll path after both successful and failed loads;
- active managed documents are forced to download instead of rendering in the
  Dashboard origin, SVG previews stay sandboxed, and external text references
  remain download-only;
- attachment-only optimistic rows reconcile with their canonical managed URL by
  the shared send run without collapsing separate turns;
- compaction blocks all send paths and releases its lock after both success and
  failure;
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
