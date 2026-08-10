import * as v from "valibot";

import {
    chatRuntimeSnapshotSchema,
    mergeChatStreamText,
    type ChatRunState,
    type ChatRunSummary,
    type ChatRuntimeEvent,
    type ChatRuntimeProjectionPart,
    type ChatRuntimeSnapshot,
} from "../../../contracts/chatModel.ts";
import { ChatRunTransitionError } from "./errors.ts";

const terminalStates: ReadonlySet<ChatRunState> = new Set([
    "cancelled",
    "completed",
    "failed",
    "unresolved",
]);

/**
 * Maps one accepted event to its legal run state, including cancellation-loss races.
 * @param state Current durable run state.
 * @param event Next contiguous runtime event.
 * @returns The legal durable state after the event.
 */
export function chatRunStateAfterEvent(
    state: ChatRunState,
    event: ChatRuntimeEvent
): ChatRunState {
    if (terminalStates.has(state)) {
        if (event.kind === "reconciled") return state;
        throw new ChatRunTransitionError(
            "A terminal chat run cannot accept runtime events"
        );
    }
    if (event.kind === "terminal") {
        if (event.outcome === "aborted") return "cancelled";
        if (event.outcome === "completed") return "completed";
        return "failed";
    }
    if (event.kind === "reconciled") return state;
    if (event.kind === "cancel") return "cancel-requested";
    if (event.kind === "interrupted") return "interrupted";
    if (event.kind === "user") {
        if (state !== "admitted" || event.sequence !== 1) {
            throw new ChatRunTransitionError(
                "A chat user event must be the admission event"
            );
        }
        return state;
    }
    if (state === "cancel-requested") return state;
    return "active";
}

function updateStreamPart(
    parts: readonly ChatRuntimeProjectionPart[],
    event: Extract<ChatRuntimeEvent, { kind: "assistant" | "thinking" }>
): readonly ChatRuntimeProjectionPart[] {
    const previous = parts.at(-1);
    if (previous?.kind !== event.kind) {
        return [
            ...parts,
            { kind: event.kind, sequence: event.sequence, text: event.text },
        ];
    }
    const mergedText = mergeChatStreamText(previous.text, event.text);
    let text = event.text;
    if (event.mode === "append") text = previous.text + event.text;
    if (event.mode === "merge") text = mergedText;
    return [
        ...parts.slice(0, -1),
        {
            kind: event.kind,
            sequence: event.sequence,
            text,
        },
    ];
}

function updateToolPart(
    parts: readonly ChatRuntimeProjectionPart[],
    event: Extract<ChatRuntimeEvent, { kind: "tool" }>
): readonly ChatRuntimeProjectionPart[] {
    const index = parts.findIndex(
        (part) => part.kind === "tool" && part.callId === event.callId
    );
    const previous = index === -1 ? undefined : parts[index];
    const previousTool = previous?.kind === "tool" ? previous : undefined;
    const input = previousTool?.input ?? event.input;
    const output = event.output ?? previousTool?.output;
    const projection = {
        callId: event.callId,
        ...((previousTool?.callIdSource ?? event.callIdSource) === undefined
            ? {}
            : { callIdSource: "synthetic" as const }),
        ...(input === undefined ? {} : { input }),
        isError: event.isError,
        kind: "tool" as const,
        name: previousTool?.name ?? event.name,
        ...((previousTool?.nameSource ?? event.nameSource) === undefined
            ? {}
            : { nameSource: "synthetic" as const }),
        ...(output === undefined ? {} : { output }),
        phase: event.phase,
        sequence: index === -1 ? event.sequence : parts[index]!.sequence,
    };
    if (index === -1) return [...parts, projection];
    return parts.map((part, partIndex) => (partIndex === index ? projection : part));
}

function updateItemPart(
    parts: readonly ChatRuntimeProjectionPart[],
    event: Extract<ChatRuntimeEvent, { kind: "item" }>
): readonly ChatRuntimeProjectionPart[] {
    const index = parts.findIndex(
        (part) => part.kind === "item" && part.id === event.itemId
    );
    const projection = {
        id: event.itemId,
        kind: "item" as const,
        sequence: index === -1 ? event.sequence : parts[index]!.sequence,
        ...(event.text === undefined ? {} : { text: event.text }),
        type: event.itemType,
    };
    if (index === -1) return [...parts, projection];
    return parts.map((part, partIndex) => (partIndex === index ? projection : part));
}

function projectParts(
    parts: readonly ChatRuntimeProjectionPart[],
    event: ChatRuntimeEvent
): readonly ChatRuntimeProjectionPart[] {
    switch (event.kind) {
        case "assistant":
        case "thinking": {
            return updateStreamPart(parts, event);
        }
        case "tool": {
            return updateToolPart(parts, event);
        }
        case "item": {
            return updateItemPart(parts, event);
        }
        case "user": {
            return [
                ...parts,
                { kind: "user", sequence: event.sequence, text: event.text },
            ];
        }
        default: {
            return parts;
        }
    }
}

function parseSnapshot(
    firstSequence: number,
    parts: readonly ChatRuntimeProjectionPart[],
    plan: ChatRuntimeSnapshot["plan"],
    projectionTruncated: boolean,
    run: ChatRunSummary,
    throughSequence: number
): ChatRuntimeSnapshot {
    return v.parse(chatRuntimeSnapshotSchema, {
        firstSequence,
        parts,
        ...(plan === undefined ? {} : { plan }),
        projectionTruncated,
        run,
        throughSequence,
    });
}

/**
 * Applies one contiguous durable event to the compact ordered restart projection.
 * @param previous Previous compact snapshot, when one exists.
 * @param event Next contiguous runtime event.
 * @param run Durable run summary after applying the event.
 * @returns The validated full or degraded restart projection.
 */
export function reduceChatRuntimeSnapshot(
    previous: ChatRuntimeSnapshot | undefined,
    event: ChatRuntimeEvent,
    run: ChatRunSummary
): ChatRuntimeSnapshot {
    const expectedSequence = (previous?.throughSequence ?? 0) + 1;
    if (
        event.sequence !== expectedSequence ||
        event.runId !== run.id ||
        (previous !== undefined && previous.run.id !== run.id)
    ) {
        throw new ChatRunTransitionError("Chat runtime journal is not contiguous");
    }
    let plan = previous?.plan;
    if (event.kind === "terminal") plan = undefined;
    if (event.kind === "plan") plan = { phase: event.phase, steps: event.steps };
    const firstSequence = previous?.firstSequence ?? event.sequence;
    const projectionTruncated = previous?.projectionTruncated ?? false;

    // Parse a projection-free control value first so invalid run/plan lifecycle
    // state is never mistaken for a projection-budget overflow.
    const compact = parseSnapshot(firstSequence, [], plan, true, run, event.sequence);
    const projected = projectParts(previous?.parts ?? [], event);
    const full = v.safeParse(chatRuntimeSnapshotSchema, {
        ...compact,
        parts: projected,
        projectionTruncated,
    });
    if (full.success) return full.output;

    // The journal is authoritative. If cumulative text, part count, or encoded
    // snapshot bytes overflow, retain only the bounded current projection and
    // mark the omission instead of rolling the already-valid event back.
    const current = v.safeParse(chatRuntimeSnapshotSchema, {
        ...compact,
        parts: projectParts([], event),
    });
    return current.success ? current.output : compact;
}
