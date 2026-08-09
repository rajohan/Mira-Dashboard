import { createInsertSchema, createSelectSchema } from "drizzle-orm/valibot";
import * as v from "valibot";

import {
    chatRunEventMaximum,
    chatRunIdSchema,
    chatRuntimeSnapshotMaximumBytes,
    chatRuntimeSnapshotSchema,
} from "../../../contracts/chatModel.ts";
import { utf8ByteLength } from "../../../shared/encoding.ts";
import { parseJsonText } from "../../../shared/json.ts";
import { positiveSafeIntegerSchema } from "../../../shared/validation.ts";
import { chatRuntimeSnapshots } from "../schema/chatRuntimeSnapshots.ts";
import { nonnegativeDateSchema } from "./scalars.ts";

const snapshotJsonSchema = v.pipe(
    v.string("Stored chat runtime snapshot is invalid"),
    v.check(
        (value) =>
            utf8ByteLength(value) <= chatRuntimeSnapshotMaximumBytes &&
            v.safeParse(chatRuntimeSnapshotSchema, parseJsonText(value)).success,
        "Stored chat runtime snapshot is invalid"
    )
);

const chatRuntimeSnapshotRefinements = {
    chatRunId: () => chatRunIdSchema,
    firstSequence: () =>
        v.pipe(positiveSafeIntegerSchema(), v.maxValue(chatRunEventMaximum)),
    schemaVersion: () => v.literal(1),
    snapshotBytes: () =>
        v.pipe(positiveSafeIntegerSchema(), v.maxValue(chatRuntimeSnapshotMaximumBytes)),
    snapshotJson: () => snapshotJsonSchema,
    throughSequence: () =>
        v.pipe(positiveSafeIntegerSchema(), v.maxValue(chatRunEventMaximum)),
    updatedAt: nonnegativeDateSchema,
};

interface ChatRuntimeSnapshotRowLike {
    readonly chatRunId: string;
    readonly firstSequence: number;
    readonly snapshotBytes: number;
    readonly snapshotJson: string;
    readonly throughSequence: number;
    readonly updatedAt: Date;
}

export function chatRuntimeSnapshotRowIsConsistent(
    row: ChatRuntimeSnapshotRowLike
): boolean {
    const result = v.safeParse(
        chatRuntimeSnapshotSchema,
        parseJsonText(row.snapshotJson)
    );
    return (
        result.success &&
        result.output.run.id === row.chatRunId &&
        result.output.firstSequence === row.firstSequence &&
        result.output.throughSequence === row.throughSequence &&
        result.output.run.updatedAtMs === row.updatedAt.getTime() &&
        row.snapshotBytes === utf8ByteLength(row.snapshotJson)
    );
}

const generatedSnapshotSelectSchema = createSelectSchema(
    chatRuntimeSnapshots,
    chatRuntimeSnapshotRefinements
);
export const chatRuntimeSnapshotSelectSchema = v.pipe(
    v.strictObject(generatedSnapshotSelectSchema.entries),
    v.check(
        (row) => chatRuntimeSnapshotRowIsConsistent(row),
        "Stored chat runtime snapshot is inconsistent"
    )
);

const generatedSnapshotInsertSchema = createInsertSchema(
    chatRuntimeSnapshots,
    chatRuntimeSnapshotRefinements
);
export const chatRuntimeSnapshotInsertSchema = v.pipe(
    v.strictObject(generatedSnapshotInsertSchema.entries),
    v.check(
        (row) => chatRuntimeSnapshotRowIsConsistent(row),
        "Stored chat runtime snapshot is inconsistent"
    )
);

export type ChatRuntimeSnapshotRow = v.InferOutput<
    typeof chatRuntimeSnapshotSelectSchema
>;
