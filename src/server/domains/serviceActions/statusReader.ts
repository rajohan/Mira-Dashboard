import { subMilliseconds } from "date-fns";
import * as v from "valibot";

import { jobTimestampSchema, jobWorkerFreshnessMs } from "../../../contracts/jobModel.ts";
import {
    type ServiceActionStatus,
    serviceActionIds,
} from "../../../contracts/serviceActions.ts";
import { fullCommitShaSchema } from "../../../shared/validation.ts";
import { toJobRunSummary } from "../jobs/records.ts";
import type {
    JobRepositoryReader,
    WorkerActionAvailabilityReader,
} from "../jobs/repository.ts";
import { serviceActionJobActionKeys } from "../jobs/serviceActionQueue.ts";
import type { ServiceActionStatusReader } from "./service.ts";

type ServiceActionStatusRepository = Pick<
    JobRepositoryReader,
    "readActionPayloadRunSnapshots"
> &
    WorkerActionAvailabilityReader;

export interface SqliteServiceActionStatusReaderOptions {
    readonly expectedReleaseId: string;
    readonly nowMs?: () => number;
    readonly repository: ServiceActionStatusRepository;
}

/**
 * Creates the exact-release, fresh-worker availability projection for fixed Service Actions.
 * @param options Release identity, jobs repository, and observation clock.
 * @returns A bounded status reader with sanitized durable-run summaries.
 */
export function createSqliteServiceActionStatusReader(
    options: SqliteServiceActionStatusReaderOptions
): ServiceActionStatusReader {
    const expectedReleaseId = v.parse(
        fullCommitShaSchema("Expected worker release id is invalid"),
        options.expectedReleaseId
    );
    const nowMs = options.nowMs ?? Date.now;
    const actionKeys = Object.freeze(
        serviceActionIds.map((actionId) => serviceActionJobActionKeys[actionId])
    );

    return Object.freeze({
        async read(signal?: AbortSignal): Promise<readonly ServiceActionStatus[]> {
            await Promise.resolve();
            signal?.throwIfAborted();
            const observedAtMs = v.parse(jobTimestampSchema, nowMs());
            const minimumHeartbeatAt = subMilliseconds(
                new Date(observedAtMs),
                Math.min(observedAtMs, jobWorkerFreshnessMs)
            );
            const availableActionKeys = new Set(
                options.repository.readWorkerActionAvailability({
                    actionKeys,
                    expectedReleaseId,
                    minimumHeartbeatAt,
                })
            );
            signal?.throwIfAborted();

            const statuses = serviceActionIds.map((id): ServiceActionStatus => {
                signal?.throwIfAborted();
                const actionKey = serviceActionJobActionKeys[id];
                const snapshot = options.repository.readActionPayloadRunSnapshots({
                    actionKey,
                    payloadJsons: ["{}"],
                })[0];
                if (snapshot === undefined || snapshot.payloadJson !== "{}") {
                    throw new Error("Service Action run status is unavailable");
                }
                return Object.freeze({
                    ...(snapshot.activeRun === undefined
                        ? {}
                        : { activeRun: toJobRunSummary(snapshot.activeRun) }),
                    availability: availableActionKeys.has(actionKey)
                        ? "available"
                        : "unavailable",
                    id,
                    ...(snapshot.lastRun === undefined
                        ? {}
                        : { latestRun: toJobRunSummary(snapshot.lastRun) }),
                });
            });
            signal?.throwIfAborted();
            return Object.freeze(statuses);
        },
    });
}
