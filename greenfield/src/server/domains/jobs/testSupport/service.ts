import { Effect } from "effect";

import { JobService } from "../service.ts";

function unexpectedJobServiceCall(method: string): () => Effect.Effect<never> {
    return () =>
        Effect.die(new Error(`Test job service received an unexpected call: ${method}`));
}

/**
 * Creates a fail-closed durable jobs service for unrelated router/server tests.
 * @param overrides Exact methods exercised by the current test.
 * @returns Complete jobs-domain test double.
 */
export function createTestJobService(
    overrides: Partial<JobService["Service"]> = {}
): JobService["Service"] {
    return JobService.of({
        cancelRun: unexpectedJobServiceCall("cancelRun"),
        getRun: unexpectedJobServiceCall("getRun"),
        getSchedule: unexpectedJobServiceCall("getSchedule"),
        listRuns: unexpectedJobServiceCall("listRuns"),
        listScheduleRuns: unexpectedJobServiceCall("listScheduleRuns"),
        listSchedules: unexpectedJobServiceCall("listSchedules"),
        runSchedule: unexpectedJobServiceCall("runSchedule"),
        setClaimingPaused: unexpectedJobServiceCall("setClaimingPaused"),
        updateSchedule: unexpectedJobServiceCall("updateSchedule"),
        ...overrides,
    });
}
