import { Store } from "@tanstack/react-store";

import { mergeChatStreamText } from "../../shared/chatStreamText.ts";
import { sortChatDisplayMessages } from "./chatMessageOrdering.ts";
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
    readonly lastPlan?: Readonly<{
        readonly plan: ChatActivePlanView;
        readonly updatedAtMs: number;
    }>;
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
          readonly explanation?: string;
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
    readonly abortBoundary?: Readonly<{
        readonly attemptId: string;
        readonly attemptedAtMs: number;
        readonly baselineObservationEpoch: number;
        readonly baselineUpdatedAtMs: number;
        readonly settlement: "not-aborted" | "pending" | "unknown";
    }>;
    readonly continuity: "complete" | "interrupted";
    readonly hasUnprojectedActivity: boolean;
    readonly lifecycle: "active" | "terminal-pending-history";
    readonly message: ChatDisplayMessage;
    readonly observationEpoch: number;
    readonly observedAtMs: number;
    readonly plan?: ChatActivePlanView;
    readonly projectionTruncated: boolean;
    readonly providerRunId: string;
    /** Provider-ordered assistant lanes split at steer/user boundaries. */
    readonly segments?: readonly ChatExternalRunSegmentProjection[];
    readonly source: "provider-in-flight" | "provider-runtime";
    readonly streamResets?: readonly Readonly<{
        readonly resetKey: string;
        readonly sourceStreamKey: string;
    }>[];
    readonly updatedAtMs: number;
}

export interface ChatExternalRunSegmentProjection {
    readonly message: ChatDisplayMessage;
    /** Exact canonical history identity for the provider user anchor. */
    readonly precedingUserMessageId?: string;
    /** Provider user text preceding this lane; used only to place an existing user row. */
    readonly precedingUserText?: string;
    readonly providerSequence: number;
    readonly segmentId: string;
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
            ...((event.explanation ?? run.plan?.description) === undefined
                ? {}
                : { description: event.explanation ?? run.plan?.description }),
            items: event.steps.map((step, index) => ({
                id: `${event.runId}:plan:${index}`,
                label: step.text,
                status: step.status === "in_progress" ? "in-progress" : step.status,
            })),
            runId: event.runId,
            title: "Task progress",
        };
    }
    return run.plan;
}

function truncatedExternalPartIdentity(part: ChatMessagePart): string | undefined {
    if (part.kind === "tool") return `tool:${part.callId}`;
    if (part.kind === "control" && part.activity !== undefined) {
        return "activity:compaction";
    }
    if (
        (part.kind === "text" || part.kind === "thinking") &&
        part.sourceKey !== undefined
    ) {
        return `stream:${part.sourceKey}`;
    }
    return undefined;
}

function mergeMatchingTruncatedExternalPart(
    previous: ChatMessagePart,
    current: ChatMessagePart,
    preserveTerminalLifecycle: boolean
): ChatMessagePart {
    if (
        (previous.kind === "text" || previous.kind === "thinking") &&
        current.kind === previous.kind
    ) {
        let text = current.text;
        if (current.text.startsWith(previous.text)) text = current.text;
        else if (previous.text.startsWith(current.text)) text = previous.text;
        return { ...previous, ...current, text };
    }
    if (previous.kind === "tool" && current.kind === "tool") {
        const previousIsTerminal =
            previous.status === "completed" || previous.status === "failed";
        const currentIsTerminal =
            current.status === "completed" || current.status === "failed";
        const retainPreviousTerminal = previousIsTerminal && !currentIsTerminal;
        return {
            ...previous,
            ...current,
            ...((current.input ?? previous.input) === undefined
                ? {}
                : { input: current.input ?? previous.input }),
            ...((current.output ?? previous.output) === undefined
                ? {}
                : { output: current.output ?? previous.output }),
            ...(retainPreviousTerminal
                ? {
                      ...(previous.error === undefined ? {} : { error: previous.error }),
                      status: previous.status,
                  }
                : {}),
        };
    }
    if (
        previous.kind === "control" &&
        current.kind === "control" &&
        preserveTerminalLifecycle &&
        previous.activity === "complete" &&
        current.activity === "running"
    ) {
        return previous;
    }
    return current;
}

function isAggregateAssistantPart(
    part: ChatMessagePart
): part is Extract<ChatMessagePart, { kind: "text" }> {
    return (
        part.kind === "text" && part.sourceKey?.endsWith(":aggregate:assistant") === true
    );
}

function identifiedAssistantPartIndexes(parts: readonly ChatMessagePart[]): number[] {
    return parts.flatMap((part, index) =>
        part.kind === "text" &&
        part.sourceKey !== undefined &&
        !isAggregateAssistantPart(part)
            ? [index]
            : []
    );
}

function identifiedAssistantText(
    parts: readonly ChatMessagePart[],
    indexes: readonly number[]
): string {
    return indexes
        .map((index) => {
            const part = parts[index];
            return part?.kind === "text" ? part.text : "";
        })
        .join("");
}

function extendLastIdentifiedAssistantPart(
    parts: ChatMessagePart[],
    indexes: readonly number[],
    aggregateText: string
): boolean {
    const rendered = identifiedAssistantText(parts, indexes);
    if (rendered === "" || !aggregateText.startsWith(rendered)) return false;
    const lastIndex = indexes.at(-1);
    const last = lastIndex === undefined ? undefined : parts[lastIndex];
    if (lastIndex !== undefined && last?.kind === "text") {
        parts[lastIndex] = {
            ...last,
            text: last.text + aggregateText.slice(rendered.length),
        };
    }
    return true;
}

function mergeTruncatedExternalParts(
    known: readonly ChatMessagePart[],
    incoming: readonly ChatMessagePart[],
    replacedSourceStreams: ReadonlySet<string> = new Set(),
    preserveTerminalLifecycle = false
): readonly ChatMessagePart[] {
    let candidateKnown = [...known];
    let candidateIncoming = [...incoming];
    if (replacedSourceStreams.size > 0) {
        candidateKnown = candidateKnown.filter(
            (part) =>
                (part.kind !== "text" && part.kind !== "thinking") ||
                part.sourceStreamKey === undefined ||
                !replacedSourceStreams.has(part.sourceStreamKey)
        );
    }
    const incomingRichIndexes = identifiedAssistantPartIndexes(candidateIncoming);
    const knownRichIndexes = identifiedAssistantPartIndexes(candidateKnown);
    const incomingAggregate = candidateIncoming.findLast((part) =>
        isAggregateAssistantPart(part)
    );
    const withoutAggregate = (parts: readonly ChatMessagePart[]) =>
        parts.filter((part) => !isAggregateAssistantPart(part));

    if (incomingRichIndexes.length > 0) {
        // The adapter emits rich assistant parts only when they cover the
        // authoritative run.text. Missing older rich identities therefore
        // represent replacement, not a truncated window; retain only the
        // matching assistant identities needed for idempotent prefix replay.
        const incomingAssistantIdentities = new Set(
            candidateIncoming.flatMap((part) =>
                part.kind === "text" &&
                part.sourceKey !== undefined &&
                !part.sourceKey.endsWith(":aggregate:assistant")
                    ? [part.sourceKey]
                    : []
            )
        );
        candidateKnown = candidateKnown.filter(
            (part) =>
                part.kind !== "text" ||
                (part.sourceKey !== undefined &&
                    incomingAssistantIdentities.has(part.sourceKey))
        );
        candidateIncoming = withoutAggregate(candidateIncoming);
    } else if (incomingAggregate !== undefined && knownRichIndexes.length > 0) {
        const knownAssistantText = identifiedAssistantText(
            candidateKnown,
            knownRichIndexes
        );
        if (
            extendLastIdentifiedAssistantPart(
                candidateKnown,
                knownRichIndexes,
                incomingAggregate.text
            ) ||
            knownAssistantText.startsWith(incomingAggregate.text)
        ) {
            candidateKnown = withoutAggregate(candidateKnown);
            candidateIncoming = withoutAggregate(candidateIncoming);
        } else {
            // The newer compact projection carries authoritative run.text. If
            // it does not cover the retained rich lane, discard only that stale
            // assistant lane and let incoming tool anchors place the aggregate.
            candidateKnown = candidateKnown.filter(
                (part) => part.kind !== "text" || part.sourceKey === undefined
            );
        }
    } else if (knownRichIndexes.length > 0) {
        candidateKnown = withoutAggregate(candidateKnown);
    }
    const knownParts = candidateKnown;
    const incomingParts = candidateIncoming;
    const streamReplay = (kind: "text" | "thinking") => {
        const knownText = knownParts
            .flatMap((part) =>
                (part.kind === "text" || part.kind === "thinking") &&
                part.kind === kind &&
                part.sourceKey === undefined
                    ? [part.text]
                    : []
            )
            .join("");
        const incomingText = incomingParts
            .flatMap((part) =>
                (part.kind === "text" || part.kind === "thinking") &&
                part.kind === kind &&
                part.sourceKey === undefined
                    ? [part.text]
                    : []
            )
            .join("");
        const converged = mergeChatStreamText(knownText, incomingText);
        let appendFrom: number | undefined = 0;
        if (converged === knownText) appendFrom = undefined;
        else if (incomingText.startsWith(knownText)) {
            appendFrom = knownText.length;
        }
        return {
            appendFrom,
            offset: 0,
        };
    };
    const replay = {
        text: streamReplay("text"),
        thinking: streamReplay("thinking"),
    };
    const replayedIncoming: ChatMessagePart[] = [];
    for (const part of incomingParts) {
        if (part.kind === "control" || part.kind === "tool") {
            replayedIncoming.push(part);
            continue;
        }
        if (part.sourceKey !== undefined) {
            replayedIncoming.push(part);
            continue;
        }
        const state = replay[part.kind];
        const partStart = state.offset;
        state.offset += part.text.length;
        if (state.appendFrom === undefined || state.offset <= state.appendFrom) {
            continue;
        }
        const suffix = part.text.slice(Math.max(0, state.appendFrom - partStart));
        if (suffix === "") continue;
        replayedIncoming.push({ ...part, text: suffix });
    }

    const merged: ChatMessagePart[] = knownParts.filter(
        (part) => part.kind !== "control" || part.activity !== undefined
    );
    const knownIdentities = new Set(
        merged.flatMap((part) => {
            const identity = truncatedExternalPartIdentity(part);
            return identity === undefined ? [] : [identity];
        })
    );
    const nextKnownIdentity: (string | undefined)[] = Array.from({
        length: replayedIncoming.length,
    });
    let nextIdentity: string | undefined;
    for (let index = replayedIncoming.length - 1; index >= 0; index -= 1) {
        nextKnownIdentity[index] = nextIdentity;
        const identity = truncatedExternalPartIdentity(replayedIncoming[index]!);
        if (identity !== undefined && knownIdentities.has(identity)) {
            nextIdentity = identity;
        }
    }
    let lastIncomingIndex: number | undefined;
    for (const [incomingIndex, part] of replayedIncoming.entries()) {
        if (part.kind === "control" && part.activity === undefined) continue;
        const identity = truncatedExternalPartIdentity(part);
        const existingIndex =
            identity === undefined
                ? -1
                : merged.findIndex(
                      (candidate) => truncatedExternalPartIdentity(candidate) === identity
                  );
        if (existingIndex !== -1) {
            merged[existingIndex] = mergeMatchingTruncatedExternalPart(
                merged[existingIndex]!,
                part,
                preserveTerminalLifecycle
            );
            lastIncomingIndex = existingIndex;
            continue;
        }
        const nextIdentity = nextKnownIdentity[incomingIndex];
        const nextIndex =
            nextIdentity === undefined
                ? -1
                : merged.findIndex(
                      (candidate) =>
                          truncatedExternalPartIdentity(candidate) === nextIdentity
                  );
        let insertionIndex = nextIndex === -1 ? merged.length : nextIndex;
        if (lastIncomingIndex !== undefined) {
            insertionIndex = Math.min(
                lastIncomingIndex + 1,
                nextIndex === -1 ? Infinity : nextIndex
            );
        }
        merged.splice(insertionIndex, 0, part);
        lastIncomingIndex = insertionIndex;
    }

    const controls: ChatMessagePart[] = [];
    for (const part of [...incomingParts, ...knownParts]) {
        if (
            part.kind === "control" &&
            part.activity === undefined &&
            !controls.some(
                (candidate) =>
                    candidate.kind === "control" && candidate.text === part.text
            )
        ) {
            controls.push(part);
        }
    }
    return [...merged, ...controls];
}

function mergeExternalSegments(
    known: readonly ChatExternalRunSegmentProjection[],
    incoming: readonly ChatExternalRunSegmentProjection[],
    replacedSourceStreams: ReadonlySet<string>,
    incomingIsNewer: boolean
): readonly ChatExternalRunSegmentProjection[] {
    const merged: ChatExternalRunSegmentProjection[] = known
        .map((segment) => {
            const retainedParts = segment.message.parts.filter(
                (part) =>
                    (part.kind !== "text" && part.kind !== "thinking") ||
                    part.sourceStreamKey === undefined ||
                    !replacedSourceStreams.has(part.sourceStreamKey)
            );
            return {
                ...segment,
                message: { ...segment.message, parts: retainedParts },
            };
        })
        .filter(
            (segment) =>
                segment.precedingUserText !== undefined ||
                segment.precedingUserMessageId !== undefined ||
                segment.message.parts.length > 0
        );
    let lastIncomingIndex: number | undefined;
    for (const [incomingIndex, segment] of incoming.entries()) {
        const existingIndex = merged.findIndex(
            (candidate) => candidate.segmentId === segment.segmentId
        );
        if (existingIndex !== -1) {
            const previous = merged[existingIndex]!;
            const parts = mergeTruncatedExternalParts(
                previous.message.parts,
                segment.message.parts,
                replacedSourceStreams,
                !incomingIsNewer
            );
            const lifecycleObservation = parts.some(
                (part) => part.kind === "control" && part.activity !== undefined
            );
            merged[existingIndex] = {
                ...previous,
                ...segment,
                providerSequence: previous.providerSequence,
                message: {
                    ...segment.message,
                    parts,
                    sequence: previous.message.sequence,
                    ...((incomingIsNewer && lifecycleObservation
                        ? segment.message.timestampMs
                        : previous.message.timestampMs) === undefined
                        ? {}
                        : {
                              timestampMs:
                                  incomingIsNewer && lifecycleObservation
                                      ? segment.message.timestampMs
                                      : previous.message.timestampMs,
                          }),
                },
            };
            lastIncomingIndex = existingIndex;
            continue;
        }
        const nextKnownId = incoming
            .slice(incomingIndex + 1)
            .map((candidate) => candidate.segmentId)
            .find((segmentId) =>
                merged.some((candidate) => candidate.segmentId === segmentId)
            );
        const nextKnownIndex =
            nextKnownId === undefined
                ? -1
                : merged.findIndex((candidate) => candidate.segmentId === nextKnownId);
        let insertionIndex = nextKnownIndex === -1 ? merged.length : nextKnownIndex;
        if (lastIncomingIndex !== undefined) {
            insertionIndex = Math.min(
                lastIncomingIndex + 1,
                nextKnownIndex === -1 ? Infinity : nextKnownIndex
            );
        }
        merged.splice(insertionIndex, 0, segment);
        lastIncomingIndex = insertionIndex;
    }
    return merged;
}

function externalProjectionIsNewer(
    previous: ChatExternalRunProjection,
    incoming: ChatExternalRunProjection
): boolean {
    return (
        incoming.updatedAtMs > previous.updatedAtMs ||
        (incoming.updatedAtMs === previous.updatedAtMs &&
            (incoming.observedAtMs > previous.observedAtMs ||
                (incoming.observedAtMs === previous.observedAtMs &&
                    incoming.observationEpoch > previous.observationEpoch)))
    );
}

function externalSegments(
    projection: ChatExternalRunProjection
): readonly ChatExternalRunSegmentProjection[] {
    return (
        projection.segments ?? [
            {
                message: projection.message,
                providerSequence: projection.message.sequence,
                segmentId: "legacy-aggregate",
            },
        ]
    );
}

function externalControlIdentity(part: ChatMessagePart): string | undefined {
    if (part.kind !== "control" || part.activity !== undefined) return undefined;
    if (
        part.tone === "warning" &&
        (part.text.includes("OpenClaw activity") ||
            part.text.includes("updates were interrupted"))
    ) {
        return "activity-gap";
    }
    return `${part.tone}:${part.text}`;
}

function deduplicateExternalSegmentControls(
    segments: readonly ChatExternalRunSegmentProjection[]
): readonly ChatExternalRunSegmentProjection[] {
    const seen = new Set<string>();
    return segments
        .toReversed()
        .map((segment) => ({
            ...segment,
            message: {
                ...segment.message,
                parts: segment.message.parts
                    .toReversed()
                    .filter((part) => {
                        const identity = externalControlIdentity(part);
                        if (identity === undefined) return true;
                        if (seen.has(identity)) return false;
                        seen.add(identity);
                        return true;
                    })
                    .toReversed(),
            },
        }))
        .toReversed()
        .filter(
            (segment) =>
                segment.precedingUserText !== undefined ||
                segment.precedingUserMessageId !== undefined ||
                segment.message.parts.length > 0
        );
}

function withExternalSegments(
    projection: ChatExternalRunProjection,
    segments: readonly ChatExternalRunSegmentProjection[]
): ChatExternalRunProjection {
    const deduplicatedSegments = deduplicateExternalSegmentControls(segments);
    const message = {
        ...projection.message,
        parts: deduplicatedSegments.flatMap((segment) => segment.message.parts),
    };
    if (
        projection.segments === undefined &&
        deduplicatedSegments.length === 1 &&
        deduplicatedSegments[0]?.segmentId === "legacy-aggregate" &&
        deduplicatedSegments[0].precedingUserText === undefined
    ) {
        return { ...projection, message };
    }
    return {
        ...projection,
        message,
        segments: deduplicatedSegments,
    };
}

function reconcileExternalSegmentsWithAuthoritativeParts(
    segments: readonly ChatExternalRunSegmentProjection[],
    parts: readonly ChatMessagePart[]
): readonly ChatExternalRunSegmentProjection[] {
    const authoritativeByIdentity = new Map(
        parts.flatMap((part) => {
            const identity = truncatedExternalPartIdentity(part);
            return identity === undefined ? [] : [[identity, part] as const];
        })
    );
    return segments.flatMap((segment) => {
        if (segment.message.parts.length === 0) return [segment];
        const reconciled = segment.message.parts.flatMap((part) => {
            const identity = truncatedExternalPartIdentity(part);
            if (identity === undefined) return [part];
            const authoritative = authoritativeByIdentity.get(identity);
            return authoritative === undefined ? [] : [authoritative];
        });
        return reconciled.length === 0
            ? []
            : [
                  {
                      ...segment,
                      message: { ...segment.message, parts: reconciled },
                  },
              ];
    });
}

function trimExternalRuns(
    runs: Readonly<Record<string, ChatExternalRunProjection>>
): Readonly<Record<string, ChatExternalRunProjection>> {
    return Object.fromEntries(
        Object.entries(runs)
            .toSorted(
                ([leftId, left], [rightId, right]) =>
                    right.updatedAtMs - left.updatedAtMs || leftId.localeCompare(rightId)
            )
            .slice(0, retainedSettledRunLimit)
    );
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
            parts = updateTextPart(
                settleThinkingParts(parts),
                "text",
                event.mode,
                event.text
            );
            break;
        }
        case "thinking": {
            parts = updateTextPart(parts, "thinking", event.mode, event.text);
            break;
        }
        case "tool-started": {
            parts = updateToolPart(settleThinkingParts(parts), event.callId, () => ({
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
                ...settleThinkingParts(parts),
                {
                    kind: "control",
                    text: "The live response was interrupted. Checking chat history…",
                    tone: "warning",
                },
            ];
            phase = "unresolved";
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
                ...(nextRun.plan === undefined
                    ? {}
                    : {
                          lastPlan: {
                              plan: nextRun.plan,
                              updatedAtMs: event.occurredAtMs,
                          },
                      }),
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
            providerRunIds?: readonly string[];
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
            const providerRunIds = new Set(projection.providerRunIds);
            for (const [runId, run] of Object.entries(runs)) {
                if (
                    run.message.providerRunId !== undefined &&
                    providerRunIds.has(run.message.providerRunId)
                ) {
                    delete runs[runId];
                }
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
                        externalRuns: session.externalRuns,
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
            const newestPlanRun = Object.values(projectedRuns)
                .filter((run) => run.plan !== undefined)
                .toSorted(
                    (left, right) => right.lastObservedAtMs - left.lastObservedAtMs
                )[0];
            const lastPlan =
                newestPlanRun?.plan !== undefined &&
                newestPlanRun.lastObservedAtMs >= (session.lastPlan?.updatedAtMs ?? 0)
                    ? {
                          plan: newestPlanRun.plan,
                          updatedAtMs: newestPlanRun.lastObservedAtMs,
                      }
                    : session.lastPlan;
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
                        ...(lastPlan === undefined ? {} : { lastPlan }),
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
            const installed = Object.fromEntries(
                projections.map((projection) => {
                    const existing = session.externalRuns[projection.providerRunId];
                    if (existing === undefined) {
                        return [projection.providerRunId, projection] as const;
                    }
                    const existingResetByStream = new Map(
                        (existing.streamResets ?? []).map(
                            ({ resetKey, sourceStreamKey }) =>
                                [sourceStreamKey, resetKey] as const
                        )
                    );
                    const newlyReplacedStreams = new Set(
                        (projection.streamResets ?? [])
                            .filter(
                                ({ resetKey, sourceStreamKey }) =>
                                    existingResetByStream.get(sourceStreamKey) !==
                                    resetKey
                            )
                            .map(({ sourceStreamKey }) => sourceStreamKey)
                    );
                    const incomingIsNewer = externalProjectionIsNewer(
                        existing,
                        projection
                    );
                    const segments = mergeExternalSegments(
                        externalSegments(existing),
                        externalSegments(projection),
                        newlyReplacedStreams,
                        incomingIsNewer
                    );
                    const authoritativeParts = mergeTruncatedExternalParts(
                        existing.message.parts,
                        projection.message.parts,
                        newlyReplacedStreams,
                        !incomingIsNewer
                    );
                    const reconciledSegments =
                        reconcileExternalSegmentsWithAuthoritativeParts(
                            segments,
                            authoritativeParts
                        );
                    const streamResets = projection.streamResets ?? existing.streamResets;
                    const plan =
                        projection.plan ??
                        (projection.projectionTruncated ? existing.plan : undefined);
                    const preserved = withExternalSegments(
                        {
                            ...projection,
                            lifecycle: incomingIsNewer
                                ? projection.lifecycle
                                : existing.lifecycle,
                            observationEpoch: Math.max(
                                existing.observationEpoch,
                                projection.observationEpoch
                            ),
                            observedAtMs: Math.max(
                                existing.observedAtMs,
                                projection.observedAtMs
                            ),
                            updatedAtMs: Math.max(
                                existing.updatedAtMs,
                                projection.updatedAtMs
                            ),
                            ...(plan === undefined ? {} : { plan }),
                            ...(streamResets === undefined ? {} : { streamResets }),
                        },
                        reconciledSegments
                    );
                    return [projection.providerRunId, preserved] as const;
                })
            );
            const omitted = Object.fromEntries(
                Object.entries(session.externalRuns).flatMap(([providerRunId, run]) => {
                    if (installed[providerRunId] !== undefined) return [];
                    return truncated ? [[providerRunId, run] as const] : [];
                })
            );
            const externalRuns = trimExternalRuns({
                ...omitted,
                ...installed,
            });
            const newestPlanRun = Object.values(installed)
                .filter((run) => run.plan !== undefined)
                .toSorted((left, right) => right.updatedAtMs - left.updatedAtMs)[0];
            const lastPlan =
                newestPlanRun?.plan !== undefined &&
                newestPlanRun.updatedAtMs >= (session.lastPlan?.updatedAtMs ?? 0)
                    ? {
                          plan: newestPlanRun.plan,
                          updatedAtMs: newestPlanRun.updatedAtMs,
                      }
                    : session.lastPlan;
            return {
                ...state,
                sessions: {
                    ...state.sessions,
                    [sessionKey]: {
                        ...session,
                        externalRuns,
                        externalRunsTruncated: truncated,
                        ...(lastPlan === undefined ? {} : { lastPlan }),
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
    const optimisticMessage = (send: ChatOptimisticSend): ChatDisplayMessage => ({
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
    });
    const optimisticRunIds = new Set(optimisticSends.map((send) => send.clientRunId));
    const runs = Object.values(session.runs).flatMap((run) => [
        ...(run.userMessage === undefined || optimisticRunIds.has(run.message.runId ?? "")
            ? []
            : [run.userMessage]),
        ...(run.message.parts.length === 0 && run.phase !== "active"
            ? []
            : [run.message]),
    ]);
    const matchedOptimisticRunIds = new Set<string>();
    const externalRows = Object.values(session.externalRuns)
        .toSorted(
            (left, right) =>
                left.observedAtMs - right.observedAtMs ||
                left.providerRunId.localeCompare(right.providerRunId)
        )
        .flatMap((run) => {
            const messages: ChatDisplayMessage[] = [];
            let pendingUserMessageId: string | undefined;
            let pendingUserText: string | undefined;
            for (const segment of externalSegments(run)) {
                if (segment.precedingUserText !== undefined) {
                    pendingUserMessageId = segment.precedingUserMessageId;
                    pendingUserText = segment.precedingUserText;
                    const matchingSend = optimisticSends.find(
                        (send) =>
                            !matchedOptimisticRunIds.has(send.clientRunId) &&
                            send.text === pendingUserText
                    );
                    if (matchingSend === undefined) {
                        messages.push({
                            attachments: segment.message.attachments,
                            id: `external-user:${sessionKey}:${run.providerRunId}:${segment.segmentId}`,
                            ...(pendingUserMessageId === undefined
                                ? {}
                                : { idempotencyKey: pendingUserMessageId }),
                            parts:
                                pendingUserText === ""
                                    ? []
                                    : [{ kind: "text", text: pendingUserText }],
                            providerRunId: run.providerRunId,
                            role: "user",
                            sequence: segment.providerSequence,
                            sessionKey,
                            timestampMs: segment.message.timestampMs,
                        });
                    } else {
                        matchedOptimisticRunIds.add(matchingSend.clientRunId);
                        messages.push({
                            ...optimisticMessage(matchingSend),
                            providerRunId: run.providerRunId,
                            sequence: segment.providerSequence,
                        });
                    }
                }
                if (segment.message.parts.length === 0) {
                    if (run.segments === undefined) {
                        messages.push(segment.message);
                    }
                    continue;
                }
                messages.push({
                    ...segment.message,
                    ...(pendingUserMessageId === undefined
                        ? {}
                        : {
                              precedingUserMessageIdAnchor: pendingUserMessageId,
                          }),
                    ...(pendingUserText === undefined
                        ? {}
                        : { precedingUserTextAnchor: pendingUserText }),
                });
                pendingUserMessageId = undefined;
                pendingUserText = undefined;
            }
            return messages;
        });
    const optimistic = optimisticSends
        .filter((send) => !matchedOptimisticRunIds.has(send.clientRunId))
        .map((send) => optimisticMessage(send));
    return sortChatDisplayMessages([...optimistic, ...runs, ...externalRows]);
}

/**
 * Returns the latest task progress until a newer run publishes its replacement.
 * @param state Current tab-local runtime state.
 * @param sessionKey Exact selected provider session.
 * @returns At most one durable latest plan for the selected session.
 */
export function chatRuntimePlans(
    state: ChatRuntimeState,
    sessionKey: string
): readonly ChatActivePlanView[] {
    const session = state.sessions[sessionKey];
    if (session === undefined) return [];
    return session.lastPlan === undefined ? [] : [session.lastPlan.plan];
}
