import { createSelectSchema } from "drizzle-orm/valibot";
import * as v from "valibot";

import { chatSendInputSchema } from "../../../contracts/chat.ts";
import {
    chatProviderRunIdSchema,
    chatRunEventBytesMaximum,
    chatRunEventMaximum,
    chatRunReconciliationStateSchema,
    chatRunStateSchema,
} from "../../../contracts/chatModel.ts";
import { gatewaySessionKeySchema } from "../../../contracts/gatewaySessions.ts";
import { jobIdempotencyKeySchema } from "../../../contracts/jobModel.ts";
import { parseJsonText } from "../../../shared/json.ts";
import {
    boundedControlSafeTextSchema,
    nonnegativeSafeIntegerSchema,
    positiveSafeIntegerSchema,
} from "../../../shared/validation.ts";
import { chatRuns } from "../schema/chatRuns.ts";
import { nonnegativeDateSchema, uuidV7TextSchema } from "./scalars.ts";
import { sha256TextSchema } from "./securityScalars.ts";

const chatRequestJsonSchema = v.pipe(
    v.string("Stored chat request is invalid"),
    v.check(
        (value) => v.safeParse(chatSendInputSchema, parseJsonText(value)).success,
        "Stored chat request is invalid"
    )
);

const chatRunRefinements = {
    admittedAt: nonnegativeDateSchema,
    cancelRequestedAt: nonnegativeDateSchema,
    dispatchAttemptedAt: nonnegativeDateSchema,
    eventBytes: () =>
        v.pipe(
            nonnegativeSafeIntegerSchema("Stored chat event bytes are invalid"),
            v.maxValue(chatRunEventBytesMaximum)
        ),
    eventCount: () =>
        v.pipe(
            nonnegativeSafeIntegerSchema("Stored chat event count is invalid"),
            v.maxValue(chatRunEventMaximum)
        ),
    failureCode: () =>
        boundedControlSafeTextSchema(128, "Stored chat failure code is invalid"),
    gatewayScope: () =>
        boundedControlSafeTextSchema(64, "Stored chat Gateway scope is invalid"),
    historyMessageId: () =>
        boundedControlSafeTextSchema(256, "Stored chat history id is invalid"),
    id: uuidV7TextSchema,
    idempotencyKey: () => jobIdempotencyKeySchema,
    lastEventSequence: () =>
        v.pipe(
            nonnegativeSafeIntegerSchema("Stored chat event sequence is invalid"),
            v.maxValue(chatRunEventMaximum)
        ),
    providerAcknowledgedAt: nonnegativeDateSchema,
    providerRunId: () => chatProviderRunIdSchema,
    reconciledAt: nonnegativeDateSchema,
    reconciliationState: () => chatRunReconciliationStateSchema,
    requestJson: () => chatRequestJsonSchema,
    requestSha256: sha256TextSchema,
    retentionExpiresAt: nonnegativeDateSchema,
    sessionKey: () => gatewaySessionKeySchema,
    state: () => chatRunStateSchema,
    stateVersion: () => positiveSafeIntegerSchema("Stored chat version is invalid"),
    terminalAt: nonnegativeDateSchema,
    transcriptGeneration: () =>
        positiveSafeIntegerSchema("Stored chat transcript generation is invalid"),
    updatedAt: nonnegativeDateSchema,
};

interface ChatRunRowLike {
    readonly admittedAt: Date;
    readonly cancelRequestedAt?: Date | null;
    readonly dispatchAttemptedAt?: Date | null;
    readonly eventCount: number;
    readonly failureCode?: string | null;
    readonly failureMessage?: string | null;
    readonly historyMessageId?: string | null;
    readonly id: string;
    readonly idempotencyKey: string;
    readonly lastEventSequence: number;
    readonly providerAcknowledgedAt?: Date | null;
    readonly reconciledAt?: Date | null;
    readonly reconciliationState:
        | "failed"
        | "history-authoritative"
        | "pending"
        | "runtime-authoritative";
    readonly requestJson: string;
    readonly retentionExpiresAt?: Date | null;
    readonly sessionKey: string;
    readonly state:
        | "active"
        | "admitted"
        | "cancel-requested"
        | "cancelled"
        | "completed"
        | "failed"
        | "interrupted"
        | "outcome-unknown"
        | "unresolved";
    readonly terminalAt?: Date | null;
    readonly transcriptGeneration: number;
    readonly updatedAt: Date;
}

export function chatRunRowIsConsistent(row: ChatRunRowLike): boolean {
    const requestResult = v.safeParse(
        chatSendInputSchema,
        parseJsonText(row.requestJson)
    );
    if (
        !requestResult.success ||
        requestResult.output.clientRunId !== row.id ||
        requestResult.output.idempotencyKey !== row.idempotencyKey ||
        requestResult.output.sessionKey !== row.sessionKey ||
        row.eventCount !== row.lastEventSequence ||
        row.updatedAt.getTime() < row.admittedAt.getTime()
    ) {
        return false;
    }
    const terminal = ["cancelled", "completed", "failed", "unresolved"].includes(
        row.state
    );
    if (
        terminal !== (row.terminalAt != null) ||
        terminal !== (row.retentionExpiresAt != null) ||
        (row.state === "failed") !==
            (row.failureCode != null && row.failureMessage != null) ||
        (["cancel-requested", "cancelled"].includes(row.state) &&
            row.cancelRequestedAt == null) ||
        (["admitted", "active", "interrupted"].includes(row.state) &&
            row.cancelRequestedAt != null) ||
        (row.reconciliationState === "history-authoritative") !==
            (row.reconciledAt != null)
    ) {
        return false;
    }
    const orderedTimes = [
        row.dispatchAttemptedAt,
        row.providerAcknowledgedAt,
        row.cancelRequestedAt,
        row.terminalAt,
        row.reconciledAt,
    ];
    return orderedTimes.every(
        (value) =>
            value == null ||
            (value.getTime() >= row.admittedAt.getTime() &&
                value.getTime() <= row.updatedAt.getTime())
    );
}

const generatedChatRunSelectSchema = createSelectSchema(chatRuns, chatRunRefinements);
export const chatRunSelectSchema = v.pipe(
    v.strictObject(generatedChatRunSelectSchema.entries),
    v.check((row) => chatRunRowIsConsistent(row), "Stored chat run is inconsistent")
);

/** Inserts supply every default explicitly so the same complete-row invariant applies. */
export const chatRunInsertSchema = chatRunSelectSchema;

export type ChatRunRow = v.InferOutput<typeof chatRunSelectSchema>;
