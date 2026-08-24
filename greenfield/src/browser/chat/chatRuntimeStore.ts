import { Store } from "@tanstack/react-store";

import type {
    ChatActivePlanView,
    ChatDisplayMessage,
    ChatMessagePart,
    ChatOptimisticAttachment,
    ChatToolPart,
} from "./chatTypes.ts";

const retainedEventIdentityLimit = 512;
const retainedSettledRunLimit = 32;
export const retainedFailedOptimisticSendLimit = 32;
export const retainedFailedOptimisticSendByteLimit = 256 * 1024;
const utf8Encoder = new TextEncoder();

export interface ChatOptimisticSend {
    readonly attachments: readonly ChatOptimisticAttachment[];
    readonly clientRunId: string;
    readonly createdAtMs: number;
    readonly delivery:
        | "accepted"
        | "failed"
        | "queued"
        | "reconciling"
        | "sending"
        | "sent";
    readonly error?: string;
    readonly idempotencyKey: string;
    readonly sessionKey: string;
    readonly text: string;
}

export interface ChatRuntimeRun {
    readonly clientRunId?: string;
    readonly lastObservedAtMs: number;
    readonly lastSequence: number;
    readonly message: ChatDisplayMessage;
    readonly plan?: ChatActivePlanView;
    readonly phase: "aborted" | "active" | "completed" | "failed" | "unresolved";
    readonly projectionTruncated: boolean;
    readonly reconciliation:
        | "failed"
        | "history-authoritative"
        | "pending"
        | "runtime-authoritative";
    readonly userMessage?: ChatDisplayMessage;
}

interface ChatSessionRuntime {
    readonly eventIdentities: readonly string[];
    readonly externalRuns: Readonly<Record<string, ChatExternalRunProjection>>;
    readonly externalRunsTruncated: boolean;
    readonly lastCursor: number;
    readonly needsReconciliation: boolean;
    readonly optimisticSends: Readonly<Record<string, ChatOptimisticSend>>;
    readonly runs: Readonly<Record<string, ChatRuntimeRun>>;
    readonly transcriptGeneration: number;
}

export interface ChatRuntimeState {
    readonly connection: "connected" | "disconnected" | "reconnecting";
    readonly sessions: Readonly<Record<string, ChatSessionRuntime>>;
}

interface ChatRuntimeEventBase {
    readonly cursor: number;
    readonly eventId: string;
    readonly occurredAtMs: number;
    readonly runId: string;
    readonly sequence: number;
    readonly sessionKey: string;
}

export type ChatRuntimeEvent =
    | (ChatRuntimeEventBase & {
          readonly clientRunId?: string;
          readonly kind: "started";
      })
    | (ChatRuntimeEventBase & {
          readonly attachmentTicketId?: string;
          readonly idempotencyKey: string;
          readonly kind: "user";
          readonly text: string;
      })
    | (ChatRuntimeEventBase & {
          readonly kind: "plan";
          readonly steps: readonly Readonly<{
              status: "completed" | "in_progress" | "pending";
              text: string;
          }>[];
      })
    | (ChatRuntimeEventBase & {
          readonly kind: "assistant" | "thinking";
          readonly mode: "append" | "merge" | "replace";
          readonly text: string;
      })
    | (ChatRuntimeEventBase & {
          readonly kind: "control";
          readonly text: string;
          readonly tone: "danger" | "muted" | "warning";
      })
    | (ChatRuntimeEventBase & {
          readonly kind: "noop";
      })
    | (ChatRuntimeEventBase & {
          readonly kind: "reconciled";
      })
    | (ChatRuntimeEventBase & {
          readonly kind: "interrupted";
      })
    | (ChatRuntimeEventBase & {
          readonly callId: string;
          readonly input?: unknown;
          readonly kind: "tool-started";
          readonly name: string;
      })
    | (ChatRuntimeEventBase & {
          readonly callId: string;
          readonly error?: string;
          readonly kind: "tool-completed" | "tool-failed";
          readonly output?: unknown;
      })
    | (ChatRuntimeEventBase & {
          readonly kind: "aborted" | "failed" | "final";
          readonly text?: string;
      });

type RuntimeEventWithoutBase<TEvent extends ChatRuntimeEvent> = TEvent extends unknown
    ? Omit<TEvent, keyof ChatRuntimeEventBase>
    : never;

/** Event-specific fields accepted before common SSE identity is attached. */
export type ChatRuntimeEventInput = RuntimeEventWithoutBase<ChatRuntimeEvent>;

/** Contract-independent restart projection installed without replaying lossy deltas. */
export interface ChatRuntimeSnapshotProjection {
    readonly lastSequence: number;
    readonly message: ChatDisplayMessage;
    readonly phase: ChatRuntimeRun["phase"];
    readonly plan?: ChatActivePlanView;
    readonly projectionTruncated?: boolean;
    readonly reconciliation:
        | "failed"
        | "history-authoritative"
        | "pending"
        | "runtime-authoritative";
    readonly runId: string;
    readonly updatedAtMs?: number;
    readonly userMessage?: ChatDisplayMessage;
}

/** Provider-origin projection that intentionally has no local run or user identity. */
export interface ChatExternalRunProjection {
    readonly continuity: "complete" | "interrupted";
    readonly hasUnprojectedActivity: boolean;
    readonly message: ChatDisplayMessage;
    readonly plan?: ChatActivePlanView;
    readonly projectionTruncated: boolean;
    readonly providerRunId: string;
    readonly source: "provider-in-flight" | "provider-runtime";
}

function emptySession(): ChatSessionRuntime {
    return {
        eventIdentities: [],
        externalRuns: {},
        externalRunsTruncated: false,
        lastCursor: 0,
        needsReconciliation: false,
        optimisticSends: {},
        runs: {},
        transcriptGeneration: 0,
    };
}

function initialRuntimeState(): ChatRuntimeState {
    return { connection: "reconnecting", sessions: {} };
}

function updateTextPart(
    parts: readonly ChatMessagePart[],
    kind: "text" | "thinking",
    mode: "append" | "merge" | "replace",
    text: string
): readonly ChatMessagePart[] {
    const next = [...parts];
    const lastIndex = next.at(-1)?.kind === kind ? next.length - 1 : -1;
    const previous = lastIndex === -1 ? undefined : next[lastIndex];
    const previousText =
        previous !== undefined &&
        (previous.kind === "text" || previous.kind === "thinking")
            ? previous.text
            : "";
    const nextText = (() => {
        if (mode === "replace") return text;
        if (mode === "append") return `${previousText}${text}`;
        if (text === "") return previousText;
        if (previousText === "" || text.startsWith(previousText)) return text;
        if (previousText.endsWith(text)) return previousText;
        return `${previousText}${text}`;
    })();
    const part: ChatMessagePart =
        kind === "thinking"
            ? { kind, status: "running", text: nextText }
            : { kind, text: nextText };
    if (lastIndex === -1) next.push(part);
    else next[lastIndex] = part;
    return next;
}

function updateToolPart(
    parts: readonly ChatMessagePart[],
    callId: string,
    update: (previous: ChatToolPart | undefined) => ChatToolPart
): readonly ChatMessagePart[] {
    const next = [...parts];
    const index = next.findIndex(
        (part) => part.kind === "tool" && part.callId === callId
    );
    const previous = index === -1 ? undefined : next[index];
    const part = update(previous?.kind === "tool" ? previous : undefined);
    if (index === -1) next.push(part);
    else next[index] = part;
    return next;
}

function settleThinkingParts(
    parts: readonly ChatMessagePart[]
): readonly ChatMessagePart[] {
    return parts.map((part) =>
        part.kind === "thinking" && part.status === "running"
            ? { ...part, status: "complete" }
            : part
    );
}

function createRun(event: ChatRuntimeEvent): ChatRuntimeRun {
    return {
        ...((event.kind === "started" && event.clientRunId !== undefined) ||
        event.kind === "user"
            ? {
                  clientRunId: event.kind === "user" ? event.runId : event.clientRunId,
              }
            : {}),
        lastObservedAtMs: event.occurredAtMs,
        lastSequence: 0,
        message: {
            attachments: [],
            id: `runtime:${event.sessionKey}:${event.runId}`,
            parts: [],
            role: "assistant",
            runId: event.runId,
            sequence: event.sequence,
            sessionKey: event.sessionKey,
            timestampMs: event.occurredAtMs,
        },
        phase: "active",
        projectionTruncated: false,
        reconciliation: "runtime-authoritative",
    };
}

function planAfterEvent(
    run: ChatRuntimeRun,
    event: ChatRuntimeEvent
): ChatActivePlanView | undefined {
    if (event.kind === "plan") {
        return {
            items: event.steps.map((step, index) => ({
                id: `${event.runId}:plan:${index}`,
                label: step.text,
                status: step.status === "in_progress" ? "in-progress" : step.status,
            })),
            runId: event.runId,
            title: "Active plan",
        };
    }
    if (event.kind === "final" || event.kind === "aborted" || event.kind === "failed") {
        return undefined;
    }
    return run.plan;
}

function applyRunEvent(run: ChatRuntimeRun, event: ChatRuntimeEvent): ChatRuntimeRun {
    let parts = run.message.parts;
    let phase = run.phase;
    let reconciliation = run.reconciliation;
    switch (event.kind) {
        case "started": {
            break;
        }
        case "user": {
            break;
        }
        case "plan": {
            break;
        }
        case "assistant": {
            parts = updateTextPart(parts, "text", event.mode, event.text);
            break;
        }
        case "thinking": {
            parts = updateTextPart(parts, "thinking", event.mode, event.text);
            break;
        }
        case "tool-started": {
            parts = updateToolPart(parts, event.callId, () => ({
                callId: event.callId,
                ...(event.input === undefined ? {} : { input: event.input }),
                kind: "tool",
                name: event.name,
                status: "running",
            }));
            break;
        }
        case "tool-completed":
        case "tool-failed": {
            parts = updateToolPart(parts, event.callId, (previous) => ({
                callId: event.callId,
                ...(event.error === undefined ? {} : { error: event.error }),
                ...(previous?.input === undefined ? {} : { input: previous.input }),
                kind: "tool",
                name: previous?.name ?? "Tool",
                ...(event.output === undefined ? {} : { output: event.output }),
                status: event.kind === "tool-failed" ? "failed" : "completed",
            }));
            break;
        }
        case "control": {
            parts = [...parts, { kind: "control", text: event.text, tone: event.tone }];
            break;
        }
        case "noop": {
            reconciliation = "runtime-authoritative";
            break;
        }
        case "reconciled": {
            reconciliation = "history-authoritative";
            break;
        }
        case "interrupted": {
            parts = [
                ...parts,
                {
                    kind: "control",
                    text: "Runtime stream was interrupted; reconciling…",
                    tone: "warning",
                },
            ];
            reconciliation = "failed";
            break;
        }
        case "final": {
            if (event.text !== undefined) {
                parts = updateTextPart(parts, "text", "replace", event.text);
            }
            parts = settleThinkingParts(parts);
            phase = "completed";
            break;
        }
        case "aborted":
        case "failed": {
            if (event.text !== undefined) {
                parts = [
                    ...parts,
                    {
                        kind: "control",
                        text: event.text,
                        tone: event.kind === "failed" ? "danger" : "warning",
                    },
                ];
            }
            parts = settleThinkingParts(parts);
            phase = event.kind;
            break;
        }
    }
    return {
        ...run,
        ...(event.kind === "started" && event.clientRunId !== undefined
            ? { clientRunId: event.clientRunId }
            : {}),
        lastObservedAtMs: event.occurredAtMs,
        lastSequence: event.sequence,
        message: {
            ...run.message,
            parts,
            sequence: Math.min(run.message.sequence, event.sequence),
        },
        plan: planAfterEvent(run, event),
        phase,
        reconciliation,
        ...(event.kind === "user"
            ? {
                  userMessage: {
                      attachments: [],
                      clientRunId: event.runId,
                      delivery: "sent",
                      id: `runtime-user:${event.sessionKey}:${event.runId}`,
                      idempotencyKey: event.idempotencyKey,
                      parts:
                          event.text === "" ? [] : [{ kind: "text", text: event.text }],
                      role: "user",
                      runId: event.runId,
                      sequence: event.sequence,
                      sessionKey: event.sessionKey,
                      timestampMs: event.occurredAtMs,
                  },
              }
            : {}),
    };
}

function trimRuns(
    runs: Readonly<Record<string, ChatRuntimeRun>>
): Readonly<Record<string, ChatRuntimeRun>> {
    const entries = Object.entries(runs);
    const active = entries.filter(([, run]) => run.phase === "active");
    const settled = entries
        .filter(([, run]) => run.phase !== "active")
        .toSorted(
            ([leftId, left], [rightId, right]) =>
                right.lastObservedAtMs - left.lastObservedAtMs ||
                rightId.localeCompare(leftId)
        )
        .slice(0, retainedSettledRunLimit);
    return Object.fromEntries([...active, ...settled]);
}

function optimisticSendRetainedBytes(send: ChatOptimisticSend): number {
    return utf8Encoder.encode(JSON.stringify(send)).byteLength;
}

function sanitizeOptimisticSend(send: ChatOptimisticSend): ChatOptimisticSend {
    return {
        attachments: send.attachments.map(
            ({ id, mediaType, name, progress, sizeBytes, status }) => ({
                id,
                mediaType,
                name,
                progress,
                sizeBytes,
                status,
            })
        ),
        clientRunId: send.clientRunId,
        createdAtMs: send.createdAtMs,
        delivery: send.delivery,
        ...(send.error === undefined ? {} : { error: send.error }),
        idempotencyKey: send.idempotencyKey,
        sessionKey: send.sessionKey,
        text: send.text,
    };
}

function retainBoundedFailedOptimisticSends(
    sends: Readonly<Record<string, ChatOptimisticSend>>
): Readonly<Record<string, ChatOptimisticSend>> {
    const entries = Object.entries(sends);
    const retained = entries.filter(([, send]) => send.delivery !== "failed");
    const failed = entries
        .filter(([, send]) => send.delivery === "failed")
        .toSorted(
            ([leftId, left], [rightId, right]) =>
                right.createdAtMs - left.createdAtMs || rightId.localeCompare(leftId)
        );
    let failedBytes = 0;
    let failedCount = 0;
    for (const entry of failed) {
        const bytes = optimisticSendRetainedBytes(entry[1]);
        if (
            failedCount >= retainedFailedOptimisticSendLimit ||
            failedBytes + bytes > retainedFailedOptimisticSendByteLimit
        ) {
            continue;
        }
        retained.push(entry);
        failedCount += 1;
        failedBytes += bytes;
    }
    return Object.fromEntries(retained);
}

function runsNeedReconciliation(runs: Readonly<Record<string, ChatRuntimeRun>>): boolean {
    return Object.values(runs).some(
        ({ projectionTruncated, reconciliation }) =>
            projectionTruncated ||
            reconciliation === "failed" ||
            reconciliation === "pending"
    );
}

function reconcileOptimisticSendFromEvent(
    sends: Readonly<Record<string, ChatOptimisticSend>>,
    run: ChatRuntimeRun,
    event: ChatRuntimeEvent
): Readonly<Record<string, ChatOptimisticSend>> {
    const matched = Object.entries(sends).find(
        ([clientRunId, send]) =>
            clientRunId === event.runId ||
            clientRunId === run.clientRunId ||
            (event.kind === "user" && send.idempotencyKey === event.idempotencyKey)
    );
    if (matched === undefined || event.kind === "noop" || event.kind === "interrupted") {
        return sends;
    }
    const [clientRunId, send] = matched;
    let nextSend: ChatOptimisticSend;
    if (event.kind === "failed" || event.kind === "aborted") {
        const fallbackError =
            event.kind === "aborted" ? "Response stopped." : "Response failed.";
        nextSend = {
            ...send,
            delivery: "failed",
            error: event.text ?? fallbackError,
        };
    } else {
        nextSend = { ...send, delivery: "sent", error: undefined };
    }
    return { ...sends, [clientRunId]: nextSend };
}

/** Session-scoped TanStack runtime store fed by the tab's shared SSE cursor. */
export class ChatRuntimeStore extends Store<ChatRuntimeState> {
    constructor() {
        super(initialRuntimeState());
    }

    apply(event: ChatRuntimeEvent): void {
        this.setState((state) => {
            const session = state.sessions[event.sessionKey] ?? emptySession();
            if (session.eventIdentities.includes(event.eventId)) return state;
            if (event.cursor <= session.lastCursor) return state;
            const run = session.runs[event.runId] ?? createRun(event);
            if (event.sequence <= run.lastSequence) return state;
            const nextRun = applyRunEvent(run, event);
            const runs = trimRuns({
                ...session.runs,
                [event.runId]: nextRun,
            });
            const nextSession: ChatSessionRuntime = {
                ...session,
                eventIdentities: [...session.eventIdentities, event.eventId].slice(
                    -retainedEventIdentityLimit
                ),
                lastCursor: event.cursor,
                needsReconciliation: runsNeedReconciliation(runs),
                optimisticSends: retainBoundedFailedOptimisticSends(
                    reconcileOptimisticSendFromEvent(
                        session.optimisticSends,
                        nextRun,
                        event
                    )
                ),
                runs,
            };
            return {
                ...state,
                sessions: { ...state.sessions, [event.sessionKey]: nextSession },
            };
        });
    }

    enqueue(send: ChatOptimisticSend): void {
        this.setState((state) => {
            const sanitized = sanitizeOptimisticSend(send);
            const session = state.sessions[sanitized.sessionKey] ?? emptySession();
            if (session.optimisticSends[sanitized.clientRunId] !== undefined) {
                return state;
            }
            return {
                ...state,
                sessions: {
                    ...state.sessions,
                    [sanitized.sessionKey]: {
                        ...session,
                        optimisticSends: retainBoundedFailedOptimisticSends({
                            ...session.optimisticSends,
                            [sanitized.clientRunId]: sanitized,
                        }),
                    },
                },
            };
        });
    }

    updateSend(
        sessionKey: string,
        clientRunId: string,
        update: Readonly<Pick<ChatOptimisticSend, "delivery">> &
            Readonly<{ error?: string }>
    ): void {
        this.setState((state) => {
            const session = state.sessions[sessionKey];
            const send = session?.optimisticSends[clientRunId];
            if (session === undefined || send === undefined) return state;
            const optimisticSends = retainBoundedFailedOptimisticSends({
                ...session.optimisticSends,
                [clientRunId]: {
                    ...send,
                    ...update,
                    ...(update.error === undefined ? { error: undefined } : {}),
                },
            });
            return {
                ...state,
                sessions: {
                    ...state.sessions,
                    [sessionKey]: {
                        ...session,
                        optimisticSends,
                    },
                },
            };
        });
    }

    updateSendAttachment(
        sessionKey: string,
        clientRunId: string,
        attachmentId: string,
        progress: number,
        status: ChatOptimisticAttachment["status"]
    ): void {
        this.setState((state) => {
            const session = state.sessions[sessionKey];
            const send = session?.optimisticSends[clientRunId];
            if (session === undefined || send === undefined) return state;
            const attachments = send.attachments.map((attachment) =>
                attachment.id === attachmentId
                    ? { ...attachment, progress, status }
                    : attachment
            );
            return {
                ...state,
                sessions: {
                    ...state.sessions,
                    [sessionKey]: {
                        ...session,
                        optimisticSends: {
                            ...session.optimisticSends,
                            [clientRunId]: { ...send, attachments },
                        },
                    },
                },
            };
        });
    }

    dismissSend(sessionKey: string, clientRunId: string): void {
        this.setState((state) => {
            const session = state.sessions[sessionKey];
            if (session?.optimisticSends[clientRunId] === undefined) return state;
            const optimisticSends = { ...session.optimisticSends };
            delete optimisticSends[clientRunId];
            return {
                ...state,
                sessions: {
                    ...state.sessions,
                    [sessionKey]: { ...session, optimisticSends },
                },
            };
        });
    }

    markReconciled(sessionKey: string, throughCursor: number): void {
        this.setState((state) => {
            const session = state.sessions[sessionKey];
            if (session === undefined || throughCursor < session.lastCursor) return state;
            return {
                ...state,
                sessions: {
                    ...state.sessions,
                    [sessionKey]: {
                        ...session,
                        needsReconciliation: runsNeedReconciliation(session.runs),
                    },
                },
            };
        });
    }

    /**
     * Retires runtime and optimistic rows only after canonical history carries their ids.
     * This keeps a send visible across acknowledgement and final-history lag.
     * @param sessionKey Exact selected provider session.
     * @param projection Canonical ids and the history read boundary.
     */
    reconcileHistory(
        sessionKey: string,
        projection: Readonly<{
            clientRunIds: readonly string[];
            idempotencyKeys: readonly string[];
            runIds: readonly string[];
            throughCursor: number;
        }>
    ): void {
        this.setState((state) => {
            const session = state.sessions[sessionKey];
            if (session === undefined) return state;
            const optimisticSends = { ...session.optimisticSends };
            for (const clientRunId of projection.clientRunIds) {
                delete optimisticSends[clientRunId];
            }
            for (const [clientRunId, send] of Object.entries(optimisticSends)) {
                if (projection.idempotencyKeys.includes(send.idempotencyKey)) {
                    delete optimisticSends[clientRunId];
                }
            }
            const runs = { ...session.runs };
            for (const runId of projection.runIds) {
                delete runs[runId];
            }
            return {
                ...state,
                sessions: {
                    ...state.sessions,
                    [sessionKey]: {
                        ...session,
                        needsReconciliation:
                            projection.throughCursor < session.lastCursor ||
                            runsNeedReconciliation(runs),
                        optimisticSends,
                        runs,
                    },
                },
            };
        });
    }

    clearSession(sessionKey: string): void {
        this.setState((state) => {
            if (state.sessions[sessionKey] === undefined) return state;
            const sessions = { ...state.sessions };
            delete sessions[sessionKey];
            return { ...state, sessions };
        });
    }

    setConnection(connection: ChatRuntimeState["connection"]): void {
        this.setState((state) =>
            state.connection === connection ? state : { ...state, connection }
        );
    }

    installSnapshots(
        sessionKey: string,
        snapshots: readonly ChatRuntimeSnapshotProjection[],
        cursor: number,
        replace: boolean,
        transcriptGeneration?: number
    ): void {
        this.setState((state) => {
            const session = state.sessions[sessionKey] ?? emptySession();
            const nextTranscriptGeneration =
                transcriptGeneration ?? session.transcriptGeneration;
            const generationChanged =
                nextTranscriptGeneration !== session.transcriptGeneration;
            const projectedRuns = Object.fromEntries(
                snapshots.flatMap((snapshot) => {
                    const existing = session.runs[snapshot.runId];
                    if (
                        !replace &&
                        existing !== undefined &&
                        snapshot.lastSequence < existing.lastSequence
                    ) {
                        return [];
                    }
                    const preserveKnownProjection =
                        snapshot.projectionTruncated === true &&
                        !replace &&
                        existing !== undefined;
                    const markerParts = snapshot.message.parts.filter(
                        (part) => part.kind === "control"
                    );
                    const knownParts = existing?.message.parts ?? [];
                    const parts = preserveKnownProjection
                        ? [
                              ...knownParts,
                              ...markerParts.filter(
                                  (marker) =>
                                      !knownParts.some(
                                          (part) =>
                                              part.kind === "control" &&
                                              part.text === marker.text
                                      )
                              ),
                          ]
                        : snapshot.message.parts;
                    const plan = preserveKnownProjection ? existing.plan : snapshot.plan;
                    const userMessage = preserveKnownProjection
                        ? existing.userMessage
                        : snapshot.userMessage;
                    const projectedRun: ChatRuntimeRun = {
                        clientRunId: snapshot.runId,
                        lastObservedAtMs: preserveKnownProjection
                            ? Math.max(
                                  existing.lastObservedAtMs,
                                  snapshot.updatedAtMs ?? 0
                              )
                            : (snapshot.updatedAtMs ?? snapshot.message.timestampMs ?? 0),
                        lastSequence: preserveKnownProjection
                            ? Math.max(existing.lastSequence, snapshot.lastSequence)
                            : snapshot.lastSequence,
                        message: preserveKnownProjection
                            ? { ...existing.message, parts }
                            : snapshot.message,
                        phase: snapshot.phase,
                        ...(plan === undefined ? {} : { plan }),
                        projectionTruncated: snapshot.projectionTruncated === true,
                        reconciliation: snapshot.reconciliation,
                        ...(userMessage === undefined ? {} : { userMessage }),
                    };
                    return [[snapshot.runId, projectedRun] as const];
                })
            );
            const runs = trimRuns(
                replace ? projectedRuns : { ...session.runs, ...projectedRuns }
            );
            return {
                ...state,
                sessions: {
                    ...state.sessions,
                    [sessionKey]: {
                        ...session,
                        eventIdentities: replace ? [] : session.eventIdentities,
                        externalRuns:
                            replace && generationChanged ? {} : session.externalRuns,
                        externalRunsTruncated:
                            replace && generationChanged
                                ? false
                                : session.externalRunsTruncated,
                        lastCursor: replace
                            ? cursor
                            : Math.max(session.lastCursor, cursor),
                        needsReconciliation: runsNeedReconciliation(runs),
                        optimisticSends:
                            replace && generationChanged ? {} : session.optimisticSends,
                        runs,
                        transcriptGeneration: nextTranscriptGeneration,
                    },
                },
            };
        });
    }

    installExternalRuns(
        sessionKey: string,
        projections: readonly ChatExternalRunProjection[],
        truncated = false
    ): void {
        this.setState((state) => {
            const session = state.sessions[sessionKey] ?? emptySession();
            return {
                ...state,
                sessions: {
                    ...state.sessions,
                    [sessionKey]: {
                        ...session,
                        externalRuns: Object.fromEntries(
                            projections.map((projection) => [
                                projection.providerRunId,
                                projection,
                            ])
                        ),
                        externalRunsTruncated: truncated,
                    },
                },
            };
        });
    }

    cursorFor(sessionKey: string): number {
        return this.state.sessions[sessionKey]?.lastCursor ?? 0;
    }

    transcriptGenerationFor(sessionKey: string): number {
        return this.state.sessions[sessionKey]?.transcriptGeneration ?? 0;
    }
}

/** @returns One independent runtime store for an application/tab lifetime. */
export function createChatRuntimeStore(): ChatRuntimeStore {
    return new ChatRuntimeStore();
}

/**
 * Projects optimistic user rows followed by active runtime assistant rows.
 * @param state Current tab-local runtime state.
 * @param sessionKey Exact selected provider session.
 * @returns Chronological optimistic and runtime messages.
 */
export function chatRuntimeMessages(
    state: ChatRuntimeState,
    sessionKey: string
): readonly ChatDisplayMessage[] {
    const session = state.sessions[sessionKey];
    if (session === undefined) return [];
    const optimisticSends = Object.values(session.optimisticSends);
    const optimistic = optimisticSends.map((send): ChatDisplayMessage => ({
        attachments: send.attachments.map((attachment) => ({
            id: attachment.id,
            mediaType: attachment.mediaType,
            name: attachment.name,
            progress: attachment.progress,
            sizeBytes: attachment.sizeBytes,
            status: attachment.status,
        })),
        clientRunId: send.clientRunId,
        delivery: send.delivery,
        id: `optimistic:${send.clientRunId}`,
        idempotencyKey: send.idempotencyKey,
        parts: send.text === "" ? [] : [{ kind: "text", text: send.text }],
        role: "user",
        sequence: Number.MAX_SAFE_INTEGER - 1,
        sessionKey,
        timestampMs: send.createdAtMs,
    }));
    const optimisticRunIds = new Set(optimisticSends.map((send) => send.clientRunId));
    const runs = Object.values(session.runs).flatMap((run) => [
        ...(run.userMessage === undefined || optimisticRunIds.has(run.message.runId ?? "")
            ? []
            : [run.userMessage]),
        ...(run.message.parts.length === 0 && run.phase !== "active"
            ? []
            : [run.message]),
    ]);
    const externalRuns = Object.values(session.externalRuns).map(
        ({ message }) => message
    );
    const externalTruncation: readonly ChatDisplayMessage[] =
        session.externalRunsTruncated
            ? [
                  {
                      attachments: [],
                      id: `external:${sessionKey}:bounded-collection`,
                      parts: [
                          {
                              kind: "control",
                              text: "Additional provider-origin runs were omitted by the bounded response.",
                              tone: "warning",
                          },
                      ],
                      role: "control",
                      sequence: Number.MAX_SAFE_INTEGER,
                      sessionKey,
                  },
              ]
            : [];
    return [...optimistic, ...runs, ...externalRuns, ...externalTruncation].toSorted(
        (left, right) => {
            const leftUsesFallback = left.timestampMs === undefined;
            const rightUsesFallback = right.timestampMs === undefined;
            if (leftUsesFallback !== rightUsesFallback) {
                return leftUsesFallback ? 1 : -1;
            }
            return (
                (left.timestampMs ?? 0) - (right.timestampMs ?? 0) ||
                left.sequence - right.sequence ||
                left.id.localeCompare(right.id)
            );
        }
    );
}

/**
 * Returns only ephemeral plans for runs that remain active.
 * @param state Current tab-local runtime state.
 * @param sessionKey Exact selected provider session.
 * @returns Active plans that must disappear at settlement.
 */
export function chatRuntimePlans(
    state: ChatRuntimeState,
    sessionKey: string
): readonly ChatActivePlanView[] {
    const session = state.sessions[sessionKey];
    if (session === undefined) return [];
    const localPlans = Object.values(session.runs)
        .filter((run) => run.phase === "active" && run.plan !== undefined)
        .map((run) => run.plan as ChatActivePlanView);
    const externalPlans = Object.values(session.externalRuns).flatMap((run) =>
        run.plan === undefined ? [] : [run.plan]
    );
    return [...localPlans, ...externalPlans];
}
