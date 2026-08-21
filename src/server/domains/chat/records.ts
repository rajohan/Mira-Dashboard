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
import {
    parseChatExternalRuntimeSnapshotPayload,
    type ChatExternalRuntimeSnapshotPayload,
    type ChatExternalRuntimeSnapshotRow,
} from "../../database/validation/chatExternalRuntimeSnapshots.ts";
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

export interface ChatExternalRuntimeSnapshotRecord {
    readonly observationEpoch: number;
    readonly payload: ChatExternalRuntimeSnapshotPayload;
    readonly sessionKey: string;
    readonly transcriptGeneration: number;
    readonly updatedAtMs: number;
}

/**
 * Hydrates one validated provider-origin session snapshot from strict storage JSON.
 * @returns Immutable provider-origin restart state.
 */
export function toChatExternalRuntimeSnapshot(
    record: ChatExternalRuntimeSnapshotRow
): ChatExternalRuntimeSnapshotRecord {
    return Object.freeze({
        observationEpoch: record.observationEpoch,
        payload: parseChatExternalRuntimeSnapshotPayload(record.snapshotJson),
        sessionKey: record.sessionKey,
        transcriptGeneration: record.transcriptGeneration,
        updatedAtMs: getTime(record.updatedAt),
    });
}
