import type { ChatHistoryMessage } from "../chatTypes";
import type { ChatRuntimeEvent } from "../domain/chatState";
import { asRecord, openClawSequence } from "./openClawAdapterValues";
import { adaptOpenClawHistory } from "./openClawHistoryAdapter";
import type { RawOpenClawHistoryMessage } from "./openClawHistoryNormalizer";
import { adaptOpenClawRuntimeEvent } from "./openClawRuntimeAdapter";

export type {
    OpenClawRuntimeEnvelope,
    OpenClawRuntimeSnapshot,
} from "./openClawRuntimeAdapter";

/** The single provider boundary used by the frontend chat system. */
export class OpenClawChatAdapter {
    #fallbackSequence = 0;

    history(messages: unknown): ChatHistoryMessage[] {
        const rows = Array.isArray(messages)
            ? messages.filter(
                  (message): message is RawOpenClawHistoryMessage =>
                      asRecord(message) !== undefined
              )
            : undefined;
        return adaptOpenClawHistory(rows);
    }

    event(raw: unknown): ChatRuntimeEvent[] {
        const nextFallback = this.#fallbackSequence + 1;
        this.#fallbackSequence = Math.max(
            nextFallback,
            openClawSequence(raw, nextFallback)
        );
        return adaptOpenClawRuntimeEvent(raw, this.#fallbackSequence);
    }

    snapshot(snapshot: unknown): ChatRuntimeEvent[] {
        const record = asRecord(snapshot);
        const events = Array.isArray(record?.events) ? record.events : [];
        return events
            .flatMap((event) => this.event(event))
            .toSorted((left, right) => left.sequence - right.sequence);
    }
}
