import type { CanonicalChatEvent } from "./canonical";

type WithoutCanonicalMetadata<Event> = Event extends unknown
    ? Omit<
          Event,
          "id" | "lifecycle" | "origin" | "provider" | "schemaVersion" | "sequence"
      >
    : never;

export type CanonicalChatEventDraft = WithoutCanonicalMetadata<CanonicalChatEvent>;

export interface RuntimeDraftLimitContext {
    eventName: string;
    runId?: string;
    runtimeSequence: number;
    sessionKey: string;
}

const MAX_DRAFTS_PER_ENVELOPE = 15;

/**
 * Detects provider error text that represents a failed tool execution.
 * @param value Provider error text.
 * @returns Whether the error represents a tool failure.
 */
export function isToolFailureError(value: string | undefined): boolean {
    const normalized = value?.trim() || "";
    return (
        normalized.startsWith("⚠️ 🛠️") ||
        /^tool (?:call|execution) failed\b/iu.test(normalized) ||
        /\bcodex native tool failed\b/iu.test(normalized)
    );
}

/**
 * Bounds event drafts while retaining a terminal event and its assistant result.
 * @param drafts Provider event drafts.
 * @param context Envelope context used for development diagnostics.
 * @returns Bounded drafts.
 */
export function boundedRuntimeDrafts(
    drafts: CanonicalChatEventDraft[],
    context: RuntimeDraftLimitContext
): CanonicalChatEventDraft[] {
    if (drafts.length <= MAX_DRAFTS_PER_ENVELOPE) {
        return drafts;
    }
    const finishIndex = drafts.findLastIndex((draft) => draft.kind === "finish");
    let boundedDrafts = drafts.slice(0, MAX_DRAFTS_PER_ENVELOPE);
    if (finishIndex !== -1) {
        const terminalStart =
            drafts[finishIndex - 1]?.kind === "assistant" ? finishIndex - 1 : finishIndex;
        const terminalDrafts = drafts.slice(terminalStart, finishIndex + 1);
        boundedDrafts = [
            ...drafts.slice(0, MAX_DRAFTS_PER_ENVELOPE - terminalDrafts.length),
            ...terminalDrafts,
        ];
    }
    if (process.env.NODE_ENV !== "production") {
        console.warn(
            "[openClawRuntimeAdapter] Dropped runtime drafts above the per-envelope limit",
            {
                ...context,
                droppedDrafts: drafts.length - boundedDrafts.length,
            }
        );
    }
    return boundedDrafts;
}
