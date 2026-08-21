import { getTime, hoursToMilliseconds, subMilliseconds } from "date-fns";
import { Effect } from "effect";

import { testImmediateDatabaseWriteAdmission } from "../../../test/support/databaseWriteAdmission.ts";
import type { openFreshMigratedDatabase } from "../../../test/support/freshDatabase.ts";
import { createMonitoringRepository } from "../repository.ts";
import { createMonitoringService, type MonitoringSubmissionError } from "../service.ts";

const eventNowMs = 10_000;
export const oneDayMs = hoursToMilliseconds(24);

export function uuid(index: number): string {
    return `019fcb96-0000-7000-8000-${index.toString(16).padStart(12, "0")}`;
}

function idGenerator(start = 10_000): () => string {
    let next = start;
    return () => uuid(next++);
}

export function problem(
    key: "backup" | "filesystem",
    overrides: Record<string, unknown> = {}
) {
    const baseline =
        key === "filesystem"
            ? {
                  condition: "pressure",
                  details: { usagePercent: 91 },
                  entityKey: "filesystem:root",
                  kind: "system",
                  severity: "warning" as const,
                  title: "Root filesystem pressure",
              }
            : {
                  condition: "overdue",
                  details: { hours: 26 },
                  entityKey: "backup:primary",
                  kind: "backup",
                  severity: "error" as const,
                  title: "Primary backup overdue",
              };
    return { ...baseline, ...overrides };
}

export function snapshot(input: {
    completedAtMs: number;
    monitorKey?: string;
    problems?: readonly ReturnType<typeof problem>[];
    run: number;
}) {
    return {
        completedAtMs: input.completedAtMs,
        monitorKey: input.monitorKey ?? "ops-check:primary",
        problems: input.problems ?? [problem("filesystem")],
        report: {
            bodyMarkdown: `# Health at ${input.completedAtMs}`,
            kind: "heartbeat",
            metadata: { complete: true },
            source: "openclaw",
            sourceJobId: input.monitorKey ?? "ops-check:primary",
            title: "System health",
        },
        runId: uuid(input.run),
        startedAtMs: getTime(subMilliseconds(input.completedAtMs, 100)),
    };
}

export type TestDatabase = Awaited<ReturnType<typeof openFreshMigratedDatabase>>;

function rowCount(database: TestDatabase, table: string): number {
    return database.sqlite
        .query<{ count: number }, []>(`SELECT count(*) AS count FROM ${table}`)
        .get()!.count;
}

export function allRowCounts(database: TestDatabase) {
    return {
        incidents: rowCount(database, "incidents"),
        monitorRuns: rowCount(database, "monitor_runs"),
        notifications: rowCount(database, "notifications"),
        observations: rowCount(database, "incident_observations"),
        realtimeEvents: rowCount(database, "realtime_events"),
        reports: rowCount(database, "reports"),
    };
}

export function serviceFor(
    database: TestDatabase,
    overrides: {
        generateId?: () => string;
        wakeEventPump?: () => Promise<void> | void;
    } = {}
) {
    return createMonitoringService({
        generateId: overrides.generateId ?? idGenerator(),
        nowMs: () => eventNowMs,
        realtimeRetentionMs: oneDayMs,
        repository: createMonitoringRepository(
            database.orm,
            testImmediateDatabaseWriteAdmission
        ),
        wakeEventPump: overrides.wakeEventPump,
    });
}

export type TestMonitoringService = ReturnType<typeof createMonitoringService>;

export function submitSnapshot(service: TestMonitoringService, input: unknown) {
    return Effect.runPromise(service.submitCompleteSnapshot(input));
}

export function submitSnapshotFailure(
    service: TestMonitoringService,
    input: unknown
): Promise<MonitoringSubmissionError> {
    return Effect.runPromise(Effect.flip(service.submitCompleteSnapshot(input)));
}

export { openFreshMigratedDatabase } from "../../../test/support/freshDatabase.ts";
