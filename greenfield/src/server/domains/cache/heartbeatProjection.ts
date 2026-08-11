import { getTime } from "date-fns";

import {
    type CacheHeartbeatResult,
    cacheHeartbeatTaskRelevanceValues,
} from "../../../contracts/cache.ts";
import { compareStrings } from "../../../shared/validation.ts";
import {
    jobActionDefinitions,
    type JobActionDefinition,
} from "../jobs/actionRegistry.ts";
import type { JobRunRecord } from "../jobs/records.ts";
import type {
    JobRepositoryReader,
    ScheduleRecordWithRelations,
} from "../jobs/repository.ts";
import type {
    TaskHeartbeatCandidateSnapshot,
    TaskRepositoryReader,
} from "../tasks/repositoryTypes.ts";

type HeartbeatTasks = CacheHeartbeatResult["tasks"];
type HeartbeatDashboardJobs = CacheHeartbeatResult["dashboardJobs"];
type HeartbeatTaskCron = NonNullable<
    Extract<
        HeartbeatTasks,
        { readonly state: "available" }
    >["items"][number]["automation"]
>["cron"];
type PresentDashboardJob = Extract<
    HeartbeatDashboardJobs,
    { readonly state: "available" }
>["items"][number] & { readonly state: "present" };

/** @returns The bounded content-free task projection for cache-read automation. */
export function projectCacheHeartbeatTasks(
    snapshot: TaskHeartbeatCandidateSnapshot,
    readCron: (cronJobId: string) => HeartbeatTaskCron = () => ({
        state: "unavailable",
    })
): HeartbeatTasks {
    const items = snapshot.rows
        .map((row) => {
            const relevance = cacheHeartbeatTaskRelevanceValues.filter((value) => {
                switch (value) {
                    case "automation-linked": {
                        return row.automation !== undefined;
                    }
                    case "agent-priority": {
                        return (
                            row.assignee === "mira-2026" &&
                            (row.priority === "medium" || row.priority === "high")
                        );
                    }
                    case "owner-blocked": {
                        return row.assignee === "rajohan" && row.status === "blocked";
                    }
                }
            });
            return {
                ...(row.automation === undefined
                    ? {}
                    : {
                          automation: {
                              cron: readCron(row.automation.cronJobId),
                              recurring: row.automation.recurring,
                          },
                      }),
                id: row.id,
                priority: row.priority,
                relevance,
                status: row.status,
            };
        })
        .toSorted((left, right) => compareStrings(left.id, right.id));
    return {
        items,
        state: "available",
        totalCount: snapshot.totalCount,
        truncated: snapshot.totalCount > items.length,
    };
}

/**
 * Reads one short task snapshot, then refreshes cron outside its transaction boundary.
 * A task-read failure cannot suppress the independent cron refresh.
 * @param readSnapshot Synchronous task snapshot boundary that owns any short transaction.
 * @param refreshCron Process-owned cron refresh performed after the task read closes.
 * @param readCron Identity-private lookup against the resulting cron snapshot.
 * @returns The projected tasks, or an unavailable task projection after a read failure.
 */
export async function readCacheHeartbeatTasksWithCronRefresh(
    readSnapshot: () => TaskHeartbeatCandidateSnapshot,
    refreshCron: () => Promise<void>,
    readCron: (cronJobId: string) => HeartbeatTaskCron
): Promise<HeartbeatTasks> {
    const snapshotRead = (() => {
        try {
            return { snapshot: readSnapshot(), state: "available" as const };
        } catch {
            return { state: "unavailable" as const };
        }
    })();
    await refreshCron();
    return snapshotRead.state === "unavailable"
        ? { state: "unavailable" }
        : projectCacheHeartbeatTasks(snapshotRead.snapshot, readCron);
}

/** @returns A bounded task projection using an unavailable cron reader by default. */
export function readCacheHeartbeatTasks(
    repository: Pick<TaskRepositoryReader, "readHeartbeatCandidates">,
    readCron?: (cronJobId: string) => HeartbeatTaskCron
): HeartbeatTasks {
    return projectCacheHeartbeatTasks(repository.readHeartbeatCandidates(), readCron);
}

function projectActiveRun(run: JobRunRecord): PresentDashboardJob["activeRun"] {
    if (run.state !== "queued" && run.state !== "running") {
        throw new Error("Heartbeat active Dashboard run is terminal");
    }
    return {
        ...(run.firstStartedAt === null
            ? {}
            : { firstStartedAtMs: getTime(run.firstStartedAt) }),
        queuedAtMs: getTime(run.queuedAt),
        state: run.state,
        updatedAtMs: getTime(run.updatedAt),
    };
}

function projectLatestRun(run: JobRunRecord): PresentDashboardJob["latestRun"] {
    return {
        ...(run.finishedAt === null ? {} : { finishedAtMs: getTime(run.finishedAt) }),
        ...(run.firstStartedAt === null
            ? {}
            : { firstStartedAtMs: getTime(run.firstStartedAt) }),
        queuedAtMs: getTime(run.queuedAt),
        state: run.state,
        ...(run.terminalCode === null ? {} : { terminalCode: run.terminalCode }),
        triggerType: run.triggerType,
        updatedAtMs: getTime(run.updatedAt),
    };
}

function historicalRunTimestamps(relation: ScheduleRecordWithRelations): number[] {
    return [relation.activeRun, relation.latestRun].flatMap((run) =>
        run === undefined
            ? []
            : [
                  getTime(run.queuedAt),
                  getTime(run.updatedAt),
                  ...(run.firstStartedAt === null ? [] : [getTime(run.firstStartedAt)]),
                  ...(run.finishedAt === null ? [] : [getTime(run.finishedAt)]),
              ]
    );
}

export interface CacheHeartbeatDashboardJobsRead {
    readonly dashboardJobs: HeartbeatDashboardJobs;
    readonly generatedAtMs: number;
}

/**
 * Projects the complete release-owned schedule registry without action payloads or identities.
 * @param repository Synchronous Dashboard-job read boundary.
 * @param candidateGeneratedAtMs Response clock already clamped to other observations.
 * @param definitions Reviewed release-owned definitions, injectable only for focused tests.
 * @returns Canonical missing/present rows and a clock covering all exposed lifecycle times.
 */
export function readCacheHeartbeatDashboardJobs(
    repository: Pick<JobRepositoryReader, "findSchedule">,
    candidateGeneratedAtMs: number,
    definitions: readonly JobActionDefinition[] = jobActionDefinitions
): CacheHeartbeatDashboardJobsRead {
    const rows = definitions
        .map((definition) => ({
            definition,
            relation: repository.findSchedule(definition.scheduleId),
        }))
        .toSorted((left, right) =>
            compareStrings(left.definition.scheduleId, right.definition.scheduleId)
        );
    const generatedAtMs = Math.max(
        candidateGeneratedAtMs,
        ...rows.flatMap(({ relation }) =>
            relation === undefined ? [] : historicalRunTimestamps(relation)
        )
    );
    return {
        dashboardJobs: {
            items: rows.map(({ definition, relation }) => {
                if (
                    relation === undefined ||
                    relation.schedule.actionKey !== definition.actionKey
                ) {
                    return {
                        defaultEnabled: definition.defaultEnabled,
                        id: definition.scheduleId,
                        state: "missing" as const,
                    };
                }
                return {
                    ...(relation.activeRun === undefined
                        ? {}
                        : { activeRun: projectActiveRun(relation.activeRun) }),
                    defaultEnabled: definition.defaultEnabled,
                    ...(relation.activeDisableIntent === undefined
                        ? {}
                        : {
                              disableIntent: {
                                  ...(relation.activeDisableIntent.expiresAt === null
                                      ? {}
                                      : {
                                            expiresAtMs: getTime(
                                                relation.activeDisableIntent.expiresAt
                                            ),
                                        }),
                                  valid:
                                      relation.activeDisableIntent.expiresAt === null ||
                                      getTime(relation.activeDisableIntent.expiresAt) >
                                          generatedAtMs,
                              },
                          }),
                    enabled: relation.schedule.enabled,
                    id: definition.scheduleId,
                    ...(relation.latestRun === undefined
                        ? {}
                        : { latestRun: projectLatestRun(relation.latestRun) }),
                    nextRunAtMs:
                        relation.schedule.enabled && relation.schedule.nextRunAt !== null
                            ? getTime(relation.schedule.nextRunAt)
                            : null,
                    state: "present" as const,
                };
            }),
            state: "available",
        },
        generatedAtMs,
    };
}
