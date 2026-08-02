import {
    CANONICAL_CHAT_EVENT_SCHEMA_VERSION,
    type CanonicalChatEvent,
    type CanonicalChatLifecycle,
} from "./canonical";
import { uniqueCanonicalChatIds } from "./canonicalUtilities";
import {
    asRecord,
    openClawCompactionRunId,
    openClawEventContext,
    openClawPayloadView,
    openClawSequence,
    stringValue,
} from "./openClawAdapterValues";
import { chatEventDrafts } from "./openClawChatEventDrafts";
import {
    boundedRuntimeDrafts,
    type CanonicalChatEventDraft,
} from "./openClawRuntimeDraft";
import { sessionMessageDrafts } from "./openClawSessionMessageDrafts";
import { runtimeStreamDrafts } from "./openClawStreamEventDrafts";

export interface OpenClawRuntimeEnvelopeInput {
    event: unknown;
    payload: unknown;
    runtimeRecordedAt: number;
    runtimeRunAliases?: string[];
    runtimeSequence: number;
    type: "event";
}

export type CanonicalizedOpenClawRuntimeEnvelope<
    Envelope extends OpenClawRuntimeEnvelopeInput = OpenClawRuntimeEnvelopeInput,
> = Envelope & {
    canonicalEvents: CanonicalChatEvent[];
};

function canonicalOpenClawOrigin(eventName: string): CanonicalChatEvent["origin"] {
    if (eventName === "chat") {
        return "openclaw-chat";
    }
    if (eventName.startsWith("session.")) {
        return "openclaw-session";
    }
    return "openclaw-runtime";
}

function canonicalOpenClawFormat(
    eventName: string
): CanonicalChatEvent["provider"]["format"] {
    if (eventName === "chat") {
        return "openclaw-chat";
    }
    if (eventName === "session.message") {
        return "openclaw-session-message";
    }
    if (eventName === "session.tool") {
        return "openclaw-session-tool";
    }
    return eventName === "agent" ? "openclaw-agent" : "openclaw-runtime";
}

function canonicalOpenClawLifecycle(
    draft: CanonicalChatEventDraft
): CanonicalChatLifecycle {
    if (draft.kind === "control") {
        return "completed";
    }
    if (draft.kind === "finish") {
        return draft.outcome;
    }
    if (draft.kind !== "status" || !draft.operation) {
        return "active";
    }
    if (draft.operationPhase === "complete") {
        return "completed";
    }
    return draft.operationPhase === "inactive" ? "aborted" : "active";
}

function canonicalOpenClawProvider(
    eventName: string,
    payload: Record<string, unknown>
): CanonicalChatEvent["provider"] {
    const message = asRecord(payload.message);
    const messageRole = (
        stringValue(message?.role) || stringValue(payload.role)
    )?.toLowerCase();
    const canUseSessionMetadata =
        eventName !== "session.message" || messageRole !== "user";
    return {
        eventName,
        format: canonicalOpenClawFormat(eventName),
        model:
            stringValue(message?.model) ||
            (canUseSessionMetadata ? stringValue(payload.model) : undefined),
        provider:
            stringValue(message?.provider) ||
            (canUseSessionMetadata
                ? stringValue(payload.provider) || stringValue(payload.modelProvider)
                : undefined),
        state: stringValue(payload.state),
        stream: stringValue(payload.stream),
    };
}

function canonicalOpenClawEventId(
    sessionKey: string,
    sequence: number,
    kind: CanonicalChatEvent["kind"]
): string {
    return `openclaw:${encodeURIComponent(sessionKey)}:${sequence}:${kind}`;
}

/**
 * Converts one raw OpenClaw envelope into provider-independent events.
 * @param raw Raw value.
 * @param fallbackSequence Fallback sequence value.
 * @returns Converted one raw OpenClaw envelope into provider-independent events.
 */
export function adaptOpenClawRuntimeEvent(
    raw: unknown,
    fallbackSequence: number
): CanonicalChatEvent[] {
    const context = openClawEventContext(raw);
    if (!context) {
        return [];
    }
    const { eventName, payload, runId, sessionKey, timestamp } = context;
    if (eventName === "session.started" && !runId) {
        return [];
    }
    const common = { runId, sessionKey, timestamp };
    const eventPayload = openClawPayloadView(payload);
    const rawRuntimeRunAliases = asRecord(raw)?.runtimeRunAliases;
    const runtimeRunAliases = uniqueCanonicalChatIds(
        Array.isArray(rawRuntimeRunAliases)
            ? rawRuntimeRunAliases.map((alias) => stringValue(alias))
            : []
    );
    const runtimeSequence = openClawSequence(raw, fallbackSequence);
    const sequence = runtimeSequence * 16;
    let drafts = runtimeStreamDrafts(eventName, eventPayload, common);
    if (eventName === "session.message") {
        drafts = sessionMessageDrafts(eventPayload, common, sequence);
    }
    if (eventName === "chat") {
        drafts = chatEventDrafts(stringValue(eventPayload.state), eventPayload, common);
    }
    const boundedDrafts = boundedRuntimeDrafts(drafts, {
        eventName,
        runId,
        runtimeSequence,
        sessionKey,
    });
    const normalizedDrafts: CanonicalChatEventDraft[] =
        runId && runtimeRunAliases.length > 0 && boundedDrafts.length === 0
            ? [{ ...common, kind: "identity" }]
            : boundedDrafts;
    const origin = canonicalOpenClawOrigin(eventName);
    const provider = canonicalOpenClawProvider(eventName, eventPayload);
    return normalizedDrafts.map((draft, index) => {
        const canonicalSequence = sequence + index;
        return {
            ...draft,
            id: canonicalOpenClawEventId(sessionKey, canonicalSequence, draft.kind),
            lifecycle: canonicalOpenClawLifecycle(draft),
            origin,
            provider,
            ...(draft.kind !== "control" &&
                runtimeRunAliases.length > 0 && {
                    runAliases: runtimeRunAliases,
                }),
            schemaVersion: CANONICAL_CHAT_EVENT_SCHEMA_VERSION,
            sequence: canonicalSequence,
        };
    });
}

/**
 * Rebuilds canonical events after any backend mutation of a provider envelope.
 * @param envelope Sequenced OpenClaw provider envelope.
 * @returns Envelope carrying canonical events derived from its current payload.
 */
export function withCanonicalOpenClawEvents<
    Envelope extends OpenClawRuntimeEnvelopeInput,
>(envelope: Envelope): CanonicalizedOpenClawRuntimeEnvelope<Envelope> {
    return {
        ...envelope,
        canonicalEvents: adaptOpenClawRuntimeEvent(envelope, envelope.runtimeSequence),
    };
}

/**
 * Preserves canonical content while applying rewritten provider run/session identity.
 * @param envelope Canonical envelope whose provider identity changed.
 * @returns Envelope with identity-consistent canonical events.
 */
export function withCurrentCanonicalOpenClawIdentity<
    Envelope extends CanonicalizedOpenClawRuntimeEnvelope,
>(envelope: Envelope): Envelope {
    const context = openClawEventContext(envelope);
    if (!context) {
        return envelope;
    }
    const rawRuntimeRunAliases = asRecord(envelope)?.runtimeRunAliases;
    const runAliases = uniqueCanonicalChatIds(
        Array.isArray(rawRuntimeRunAliases)
            ? rawRuntimeRunAliases.map((alias) => stringValue(alias))
            : []
    );
    return {
        ...envelope,
        canonicalEvents: envelope.canonicalEvents.map((event) => ({
            ...event,
            id: canonicalOpenClawEventId(context.sessionKey, event.sequence, event.kind),
            ...(event.kind === "finish" &&
                event.settlesCompactionRunId && {
                    settlesCompactionRunId: openClawCompactionRunId(
                        context.sessionKey,
                        context.runId
                    ),
                }),
            ...("message" in event &&
                event.message && {
                    message: {
                        ...event.message,
                        runId: event.kind === "control" ? undefined : context.runId,
                    },
                }),
            runAliases:
                event.kind !== "control" && runAliases.length > 0
                    ? runAliases
                    : undefined,
            runId: event.kind === "control" ? undefined : context.runId,
            sessionKey: context.sessionKey,
        })),
    };
}
