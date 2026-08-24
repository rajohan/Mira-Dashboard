import { getTime } from "date-fns";
import * as v from "valibot";

import {
    type DeliveryDeploymentsResult,
    deliveryDeploymentMaximum,
    deliveryDeploymentsResultSchema,
} from "../../../contracts/delivery.ts";
import {
    type DeliveryJobOperationResult,
    deliveryJobOperationResultSchema,
    deliveryProductionActionKey,
    parseDeliveryOperationJobPayload,
} from "../../../contracts/deliveryWorker.ts";
import type { JobRunState } from "../../../contracts/jobModel.ts";
import { parseJsonText } from "../../../shared/json.ts";

/** Narrow record returned only by an exact indexed `delivery.production.v1` query. */
export interface DeliveryProductionRunRecord {
    readonly actionKey: string;
    readonly id: string;
    readonly payloadJson: string;
    readonly queuedAt: Date;
    readonly resultJson: string | null;
    readonly state: JobRunState;
    readonly terminalMessage: string | null;
    readonly updatedAt: Date;
}

export interface DeliveryProductionRunRepository {
    readonly listByActionKey: (
        actionKey: typeof deliveryProductionActionKey,
        limit: number
    ) => readonly DeliveryProductionRunRecord[];
}

export interface DeliveryDeploymentHistoryReader {
    readonly read: () => DeliveryDeploymentsResult;
}

export interface DeliveryDeploymentHistoryReaderOptions {
    readonly nowMs?: () => number;
    readonly repository: DeliveryProductionRunRepository;
}

function checkedTime(nowMs: () => number): number {
    const value = nowMs();
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new RangeError("Delivery history clock is invalid");
    }
    return value;
}

interface StoredOperationResult {
    readonly operationResult: DeliveryJobOperationResult;
    readonly postSettlementWarnings?: readonly ["delivery-overview-refresh-failed"];
}

function parseStoredOperationResult(value: unknown): StoredOperationResult {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new TypeError("Delivery deployment result is invalid");
    }
    const record = value as Readonly<Record<string, unknown>>;
    const operationResult = v.parse(deliveryJobOperationResultSchema, {
        operation: record.operation,
        outcome: record.outcome,
        ...(record.releaseId === undefined ? {} : { releaseId: record.releaseId }),
        ...(record.warnings === undefined ? {} : { warnings: record.warnings }),
    });
    const postSettlementWarnings =
        record.postSettlementWarnings === undefined
            ? undefined
            : v.parse(
                  v.tuple([v.literal("delivery-overview-refresh-failed")]),
                  record.postSettlementWarnings
              );
    return Object.freeze({
        operationResult,
        ...(postSettlementWarnings === undefined ? {} : { postSettlementWarnings }),
    });
}

/**
 * Creates a sanitized deployment history reader over one exact action-key query.
 * @param options Exact repository and checked-at clock.
 * @returns One bounded sanitized Delivery production history reader.
 */
export function createDeliveryDeploymentHistoryReader({
    nowMs = Date.now,
    repository,
}: DeliveryDeploymentHistoryReaderOptions): DeliveryDeploymentHistoryReader {
    return Object.freeze({
        read() {
            let checkedAtMs = 0;
            try {
                checkedAtMs = checkedTime(nowMs);
                const records = repository.listByActionKey(
                    deliveryProductionActionKey,
                    deliveryDeploymentMaximum
                );
                if (records.length > deliveryDeploymentMaximum) {
                    throw new RangeError(
                        "Delivery deployment history exceeded its budget"
                    );
                }
                const deployments = records.map((record) => {
                    if (record.actionKey !== deliveryProductionActionKey) {
                        throw new TypeError(
                            "Delivery deployment history crossed action authority"
                        );
                    }
                    const payload = parseDeliveryOperationJobPayload(
                        parseJsonText(record.payloadJson)
                    );
                    const result =
                        record.resultJson === null
                            ? undefined
                            : parseStoredOperationResult(
                                  parseJsonText(record.resultJson)
                              );
                    let commitSha: string | undefined = result?.operationResult.releaseId;
                    let operation: "deploy" | "rollback-release";
                    if (payload.operation === "deploy") {
                        commitSha ??= payload.expectedMainHeadSha;
                        operation = "deploy";
                    } else if (payload.operation === "rollback-release") {
                        commitSha ??= payload.target.releaseId;
                        operation = "rollback-release";
                    } else {
                        throw new TypeError(
                            "Delivery history contains a non-production payload"
                        );
                    }
                    if (
                        result !== undefined &&
                        result.operationResult.operation !== payload.operation
                    ) {
                        throw new TypeError(
                            "Delivery history result does not match its payload"
                        );
                    }
                    return {
                        ...(commitSha === undefined ? {} : { commitSha }),
                        jobRunId: record.id,
                        ...(record.terminalMessage === null
                            ? {}
                            : { note: record.terminalMessage }),
                        ...(result === undefined
                            ? {}
                            : {
                                  outcome: result.operationResult.outcome,
                                  ...(result.operationResult.warnings === undefined
                                      ? {}
                                      : {
                                            warnings: result.operationResult.warnings,
                                        }),
                                  ...(result.postSettlementWarnings === undefined
                                      ? {}
                                      : {
                                            postSettlementWarnings:
                                                result.postSettlementWarnings,
                                        }),
                              }),
                        operation,
                        queuedAtMs: getTime(record.queuedAt),
                        state: record.state,
                        updatedAtMs: getTime(record.updatedAt),
                    };
                });
                return v.parse(deliveryDeploymentsResultSchema, {
                    checkedAtMs,
                    deployments,
                    state: "fresh",
                });
            } catch {
                return v.parse(deliveryDeploymentsResultSchema, {
                    checkedAtMs,
                    state: "unavailable",
                });
            }
        },
    });
}
