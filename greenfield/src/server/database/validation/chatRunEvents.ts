import { createInsertSchema, createSelectSchema } from "drizzle-orm/valibot";
import * as v from "valibot";

import {
    chatRunEventMaximum,
    chatRunEventPayloadMaximumBytes,
    chatRunIdSchema,
    chatRuntimeEventSchema,
} from "../../../contracts/chatModel.ts";
import { utf8ByteLength } from "../../../shared/encoding.ts";
import { parseJsonText } from "../../../shared/json.ts";
import {
    nonnegativeSafeIntegerSchema,
    positiveSafeIntegerSchema,
} from "../../../shared/validation.ts";
import { chatRunEvents } from "../schema/chatRunEvents.ts";
import { nonnegativeDateSchema } from "./scalars.ts";

const chatEventJsonSchema = v.pipe(
    v.string("Stored chat event is invalid"),
    v.check(
        (value) => v.safeParse(chatRuntimeEventSchema, parseJsonText(value)).success,
        "Stored chat event is invalid"
    )
);

const chatRunEventRefinements = {
    chatRunId: () => chatRunIdSchema,
    id: () => positiveSafeIntegerSchema("Stored chat event cursor is invalid"),
    occurredAt: nonnegativeDateSchema,
    payloadBytes: () =>
        v.pipe(
            positiveSafeIntegerSchema("Stored chat event bytes are invalid"),
            v.maxValue(chatRunEventPayloadMaximumBytes)
        ),
    payloadJson: () => chatEventJsonSchema,
    providerSequenceEnd: () =>
        nonnegativeSafeIntegerSchema("Stored provider sequence is invalid"),
    providerSequenceStart: () =>
        nonnegativeSafeIntegerSchema("Stored provider sequence is invalid"),
    sequence: () =>
        v.pipe(
            positiveSafeIntegerSchema("Stored chat event sequence is invalid"),
            v.maxValue(chatRunEventMaximum)
        ),
};

interface ChatRunEventRowLike {
    readonly chatRunId: string;
    readonly kind: string;
    readonly occurredAt: Date;
    readonly payloadBytes: number;
    readonly payloadJson: string;
    readonly providerSequenceEnd?: number | null;
    readonly providerSequenceStart?: number | null;
    readonly sequence: number;
}

export function chatRunEventRowIsConsistent(row: ChatRunEventRowLike): boolean {
    const parsed = v.safeParse(chatRuntimeEventSchema, parseJsonText(row.payloadJson));
    if (!parsed.success) return false;
    const event = parsed.output;
    let providerStart: number | undefined;
    let providerEnd: number | undefined;
    if (event.kind === "assistant" || event.kind === "thinking") {
        providerStart = event.providerSequenceStart;
        providerEnd = event.providerSequenceEnd;
    } else if (event.kind === "provider-noop") {
        providerStart = event.providerSequenceStart;
        providerEnd = event.providerSequenceEnd;
    } else if ("providerSequence" in event) {
        providerStart = event.providerSequence;
        providerEnd = event.providerSequence;
    }
    return (
        event.runId === row.chatRunId &&
        event.kind === row.kind &&
        event.sequence === row.sequence &&
        event.occurredAtMs === row.occurredAt.getTime() &&
        (providerStart ?? null) === (row.providerSequenceStart ?? null) &&
        (providerEnd ?? null) === (row.providerSequenceEnd ?? null) &&
        row.payloadBytes === utf8ByteLength(row.payloadJson)
    );
}

const generatedChatRunEventSelectSchema = createSelectSchema(
    chatRunEvents,
    chatRunEventRefinements
);
export const chatRunEventSelectSchema = v.pipe(
    v.strictObject(generatedChatRunEventSelectSchema.entries),
    v.check(
        (row) => chatRunEventRowIsConsistent(row),
        "Stored chat event is inconsistent"
    )
);

const generatedChatRunEventInsertSchema = v.omit(
    createInsertSchema(chatRunEvents, chatRunEventRefinements),
    ["id"]
);
export const chatRunEventInsertSchema = v.pipe(
    v.strictObject(generatedChatRunEventInsertSchema.entries),
    v.check(
        (row) => chatRunEventRowIsConsistent(row),
        "Stored chat event is inconsistent"
    )
);

export type ChatRunEventRow = v.InferOutput<typeof chatRunEventSelectSchema>;
