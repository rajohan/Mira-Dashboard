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
import type { TaskRepositoryReader } from "../tasks/repositoryTypes.ts";

type HeartbeatTasks = CacheHeartbeatResult["tasks"];
type HeartbeatDashboardJobs = CacheHeartbeatResult["dashboardJobs"];
type PresentDashboardJob = Extract<
    HeartbeatDashboardJobs,
    { readonly state: "available" }
>["items"][number] & { readonly state: "present" };

/** @returns The bounded content-free task projection for cache-read automation. */
export function readCacheHeartbeatTasks(
    repository: Pick<TaskRepositoryReader, "readHeartbeatCandidates">
): HeartbeatTasks {
    const snapshot = repository.readHeartbeatCandidates();
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
                    : { automation: { recurring: row.automation.recurring } }),
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
