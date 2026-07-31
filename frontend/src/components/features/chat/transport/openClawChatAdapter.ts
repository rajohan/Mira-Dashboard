import { asRecord } from "../../../../../../contracts/chat/openClawAdapterValues";
import type { RawOpenClawHistoryMessage } from "../../../../../../contracts/chat/openClawHistoryNormalizer";
import { parseCanonicalChatEvents } from "../../../../../../contracts/chatCanonical";
import type { ChatHistoryMessage } from "../chatTypes";
import type { ChatRuntimeEvent } from "../domain/chatState";
import { adaptOpenClawHistory } from "./openClawHistoryAdapter";

/** The single provider boundary used by the frontend chat system. */
export class OpenClawChatAdapter {
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
        const envelope = asRecord(raw);
        if (!envelope || envelope.type !== "event") {
            return [];
        }
        return parseCanonicalChatEvents(
            envelope.canonicalEvents,
            "chat.runtimeEvent.canonicalEvents"
        );
    }

    snapshot(snapshot: unknown): ChatRuntimeEvent[] {
        const record = asRecord(snapshot);
        const events = Array.isArray(record?.events) ? record.events : [];
        return events
            .flatMap((event) => this.event(event))
            .toSorted((left, right) => left.sequence - right.sequence);
    }
}
