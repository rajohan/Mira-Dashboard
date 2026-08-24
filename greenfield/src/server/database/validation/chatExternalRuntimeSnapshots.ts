import { createInsertSchema, createSelectSchema } from "drizzle-orm/valibot";
import * as v from "valibot";

import {
    chatExternalRunSchema,
    chatExternalRunsPerSessionMaximum,
    chatMessageTextSchema,
} from "../../../contracts/chatModel.ts";
import { gatewaySessionKeySchema } from "../../../contracts/gatewaySessions.ts";
import { timestampMillisecondsSchema } from "../../../shared/dateTime.ts";
import { utf8ByteLength } from "../../../shared/encoding.ts";
import { parseJsonText } from "../../../shared/json.ts";
import {
    boundedControlSafeTextSchema,
    nonnegativeSafeIntegerSchema,
    positiveSafeIntegerSchema,
} from "../../../shared/validation.ts";
import {
    chatExternalRuntimeSnapshotMaximumBytes,
    chatExternalRuntimeSnapshots,
} from "../schema/chatExternalRuntimeSnapshots.ts";
import { nonnegativeDateSchema } from "./scalars.ts";

const chatExternalRuntimeSnapshotEntryObjectSchema = v.strictObject({
    historyCatchUpSignaled: v.optional(v.literal(true)),
    historyReplayRemainder: v.optional(v.nullable(chatMessageTextSchema)),
    lastProviderSequence: nonnegativeSafeIntegerSchema(
        "Stored external chat provider sequence is invalid"
    ),
    observationKind: v.picklist(["history", "live"]),
    pendingAssistantAppend: v.optional(chatMessageTextSchema),
    run: chatExternalRunSchema,
    terminalObservedAtMs: v.optional(
        timestampMillisecondsSchema(
            "Stored external chat terminal observation timestamp is invalid"
        )
    ),
});

function chatExternalRuntimeSnapshotEntryIsConsistent(
    entry: v.InferOutput<typeof chatExternalRuntimeSnapshotEntryObjectSchema>
): boolean {
    return (
        (entry.run.lifecycle === "terminal-pending-history") ===
        (entry.terminalObservedAtMs !== undefined)
    );
}

export const chatExternalRuntimeSnapshotEntrySchema = v.pipe(
    chatExternalRuntimeSnapshotEntryObjectSchema,
    v.check(
        chatExternalRuntimeSnapshotEntryIsConsistent,
        "Stored external chat runtime entry is inconsistent"
    )
);

const chatExternalRuntimeSnapshotPayloadObjectSchema = v.strictObject({
    entries: v.pipe(
        v.array(chatExternalRuntimeSnapshotEntrySchema),
        v.maxLength(
            chatExternalRunsPerSessionMaximum,
            "Stored external chat runtime entry count is outside its budget"
        )
    ),
    truncated: v.boolean(),
});

function chatExternalRuntimeSnapshotPayloadIsConsistent(
    payload: v.InferOutput<typeof chatExternalRuntimeSnapshotPayloadObjectSchema>
): boolean {
    const providerRunIds = payload.entries.map(({ run }) => run.providerRunId);
    return (
        new Set(providerRunIds).size === providerRunIds.length &&
        utf8ByteLength(JSON.stringify(payload)) <= chatExternalRuntimeSnapshotMaximumBytes
    );
}

/** Strict, bounded provider-origin projection and restart-resume envelope. */
export const chatExternalRuntimeSnapshotPayloadSchema = v.pipe(
    chatExternalRuntimeSnapshotPayloadObjectSchema,
    v.check(
        chatExternalRuntimeSnapshotPayloadIsConsistent,
        "Stored external chat runtime snapshot is inconsistent"
    )
);

export type ChatExternalRuntimeSnapshotPayload = v.InferOutput<
    typeof chatExternalRuntimeSnapshotPayloadSchema
>;

const snapshotJsonSchema = v.pipe(
    v.string("Stored external chat runtime snapshot is invalid"),
    v.check(
        (value) =>
            utf8ByteLength(value) <= chatExternalRuntimeSnapshotMaximumBytes &&
            v.safeParse(chatExternalRuntimeSnapshotPayloadSchema, parseJsonText(value))
                .success,
        "Stored external chat runtime snapshot is invalid"
    )
);

/**
 * Parses a stored JSON envelope through its complete strict contract.
 * @param snapshotJson Raw persisted snapshot JSON.
 * @returns Validated provider-origin restart state.
 */
export function parseChatExternalRuntimeSnapshotPayload(
    snapshotJson: string
): ChatExternalRuntimeSnapshotPayload {
    v.parse(snapshotJsonSchema, snapshotJson);
    return v.parse(chatExternalRuntimeSnapshotPayloadSchema, parseJsonText(snapshotJson));
}

const refinements = {
    gatewayScope: () =>
        boundedControlSafeTextSchema(64, "Stored external chat Gateway scope is invalid"),
    observationEpoch: () =>
        nonnegativeSafeIntegerSchema("Stored external chat observation epoch is invalid"),
    schemaVersion: () => v.literal(1),
    sessionKey: () => gatewaySessionKeySchema,
    snapshotBytes: () =>
        v.pipe(
            positiveSafeIntegerSchema(
                "Stored external chat runtime snapshot size is invalid"
            ),
            v.maxValue(
                chatExternalRuntimeSnapshotMaximumBytes,
                "Stored external chat runtime snapshot size is invalid"
            )
        ),
    snapshotJson: () => snapshotJsonSchema,
    transcriptGeneration: () =>
        positiveSafeIntegerSchema(
            "Stored external chat transcript generation is invalid"
        ),
    updatedAt: nonnegativeDateSchema,
};

interface ChatExternalRuntimeSnapshotRowLike {
    readonly observationEpoch: number;
    readonly sessionKey: string;
    readonly snapshotBytes: number;
    readonly snapshotJson: string;
    readonly updatedAt: Date;
}

export function chatExternalRuntimeSnapshotRowIsConsistent(
    row: ChatExternalRuntimeSnapshotRowLike
): boolean {
    const result = v.safeParse(
        chatExternalRuntimeSnapshotPayloadSchema,
        parseJsonText(row.snapshotJson)
    );
    if (!result.success || row.snapshotBytes !== utf8ByteLength(row.snapshotJson)) {
        return false;
    }
    const updatedAtMs = row.updatedAt.getTime();
    return result.output.entries.every(
        ({ run, terminalObservedAtMs }) =>
            run.sessionKey === row.sessionKey &&
            run.observationEpoch <= row.observationEpoch &&
            run.observedAtMs <= updatedAtMs &&
            run.updatedAtMs <= updatedAtMs &&
            (terminalObservedAtMs === undefined || terminalObservedAtMs <= updatedAtMs)
    );
}

const generatedSelectSchema = createSelectSchema(
    chatExternalRuntimeSnapshots,
    refinements
);
export const chatExternalRuntimeSnapshotSelectSchema = v.pipe(
    v.strictObject(generatedSelectSchema.entries),
    v.check(
        (row) => chatExternalRuntimeSnapshotRowIsConsistent(row),
        "Stored external chat runtime snapshot row is inconsistent"
    )
);

const generatedInsertSchema = createInsertSchema(
    chatExternalRuntimeSnapshots,
    refinements
);
export const chatExternalRuntimeSnapshotInsertSchema = v.pipe(
    v.strictObject(generatedInsertSchema.entries),
    v.check(
        (row) => chatExternalRuntimeSnapshotRowIsConsistent(row),
        "Stored external chat runtime snapshot row is inconsistent"
    )
);

export type ChatExternalRuntimeSnapshotRow = v.InferOutput<
    typeof chatExternalRuntimeSnapshotSelectSchema
>;
