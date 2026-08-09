import { getTime } from "date-fns";
import * as v from "valibot";

import {
    chatRunSummarySchema,
    chatRuntimeEventSchema,
    chatRuntimeSnapshotSchema,
    type ChatRunSummary,
    type ChatRuntimeEvent,
    type ChatRuntimeSnapshot,
} from "../../../contracts/chatModel.ts";
import { parseJsonText } from "../../../shared/json.ts";
import type { ChatRunEventRow } from "../../database/validation/chatRunEvents.ts";
import type { ChatRunRow } from "../../database/validation/chatRuns.ts";
import type { ChatRuntimeSnapshotRow } from "../../database/validation/chatRuntimeSnapshots.ts";

export function toChatRunSummary(record: ChatRunRow): ChatRunSummary {
    return v.parse(chatRunSummarySchema, {
        admittedAtMs: getTime(record.admittedAt),
        ...(record.cancelRequestedAt === null
            ? {}
            : { cancelRequestedAtMs: getTime(record.cancelRequestedAt) }),
        ...(record.failureCode === null ? {} : { failureCode: record.failureCode }),
        ...(record.failureMessage === null
            ? {}
            : { failureMessage: record.failureMessage }),
        id: record.id,
        ...(record.providerRunId === null ? {} : { providerRunId: record.providerRunId }),
        reconciliation: record.reconciliationState,
        ...(record.reconciledAt === null
            ? {}
            : { reconciledAtMs: getTime(record.reconciledAt) }),
        sessionKey: record.sessionKey,
        state: record.state,
        stateVersion: record.stateVersion,
        ...(record.terminalAt === null
            ? {}
            : { terminalAtMs: getTime(record.terminalAt) }),
        updatedAtMs: getTime(record.updatedAt),
    });
}

export function toChatRuntimeEvent(record: ChatRunEventRow): ChatRuntimeEvent {
    return v.parse(chatRuntimeEventSchema, parseJsonText(record.payloadJson));
}

export function toChatRuntimeSnapshot(
    record: ChatRuntimeSnapshotRow
): ChatRuntimeSnapshot {
    return v.parse(chatRuntimeSnapshotSchema, parseJsonText(record.snapshotJson));
}
