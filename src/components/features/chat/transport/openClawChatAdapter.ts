import type { ChatHistoryMessage } from "../chatTypes";
import type { ChatRuntimeEvent } from "../domain/chatState";
import { adaptOpenClawHistory } from "./openClawHistoryAdapter";
import type { RawOpenClawHistoryMessage } from "./openClawHistoryNormalizer";
import {
    adaptOpenClawRuntimeEvent,
    type OpenClawRuntimeSnapshot,
} from "./openClawRuntimeAdapter";

const MAX_FAILED_TOOL_RUNS = 200;

export type {
    OpenClawRuntimeEnvelope,
    OpenClawRuntimeSnapshot,
} from "./openClawRuntimeAdapter";

/** The single provider boundary used by the frontend chat system. */
export class OpenClawChatAdapter {
    #fallbackSequence = 0;
    readonly #failedToolRuns = new Set<string>();

    #rememberFailedToolRun(runKey: string): void {
        this.#failedToolRuns.delete(runKey);
        this.#failedToolRuns.add(runKey);
        while (this.#failedToolRuns.size > MAX_FAILED_TOOL_RUNS) {
            const oldestRunKey = this.#failedToolRuns.values().next().value;
            if (!oldestRunKey) {
                break;
            }
            this.#failedToolRuns.delete(oldestRunKey);
        }
    }

    #normalizeToolError(event: ChatRuntimeEvent): ChatRuntimeEvent {
        const runKey = event.runId ? `${event.sessionKey}\u{0}${event.runId}` : undefined;
        if (event.kind === "tool") {
            const hasFailedTool = Boolean(
                event.message.toolResult?.isError ||
                event.message.toolCalls?.some((call) => call.toolResult?.isError)
            );
            if (hasFailedTool && runKey) {
                this.#rememberFailedToolRun(runKey);
            }
            return event;
        }
        if (event.kind !== "finish") {
            return event;
        }

        const error = event.error?.trim() || "";
        const isSurfacedToolError = Boolean(
            error.startsWith("⚠️ 🛠️") ||
            /^tool (?:call|execution) failed\b/iu.test(error) ||
            (runKey && this.#failedToolRuns.has(runKey))
        );
        if (runKey) {
            this.#failedToolRuns.delete(runKey);
        }
        return isSurfacedToolError ? { ...event, error: undefined } : event;
    }

    history(messages: RawOpenClawHistoryMessage[] | undefined): ChatHistoryMessage[] {
        return adaptOpenClawHistory(messages);
    }

    event(raw: unknown): ChatRuntimeEvent[] {
        this.#fallbackSequence += 1;
        return adaptOpenClawRuntimeEvent(raw, this.#fallbackSequence).map((event) =>
            this.#normalizeToolError(event)
        );
    }

    snapshot(snapshot: OpenClawRuntimeSnapshot | undefined): ChatRuntimeEvent[] {
        return (snapshot?.events || [])
            .flatMap((event) => this.event(event))
            .toSorted((left, right) => left.sequence - right.sequence);
    }
}
