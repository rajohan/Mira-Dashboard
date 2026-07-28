import { describe, expect, it } from "bun:test";

import { parseApiErrorResponse } from "../../contracts/apiErrors";
import { parseExecRequest } from "../../contracts/exec";
import {
    parseJobExecutionsResponse,
    parseScheduledJobsResponse,
    parseScheduledJobUpdateRequest,
} from "../../contracts/jobs";
import { parseCreateReportInput } from "../../contracts/reports";
import { ContractValidationError } from "../../contracts/runtime";
import { parseCreateTaskRequest, parseUpdateTaskRequest } from "../../contracts/tasks";

function captureContractError(operation: () => unknown): ContractValidationError {
    try {
        operation();
    } catch (error) {
        expect(error).toBeInstanceOf(ContractValidationError);
        return error as ContractValidationError;
    }
    throw new Error("Expected contract validation to fail");
}

describe("shared runtime contracts", () => {
    it("normalizes valid task input without losing intentional body whitespace", () => {
        expect(
            parseCreateTaskRequest({
                assignee: "mira-2026",
                automation: {
                    cronJobId: "cron-1",
                    model: " ",
                    recurring: true,
                    scheduleSummary: "",
                    sessionTarget: "  ",
                    thinking: "",
                    type: "cron",
                },
                body: "  keep markdown spacing  ",
                labels: ["P2", "backend"],
                title: "  Add observability  ",
            })
        ).toEqual({
            assignee: "mira-2026",
            automation: {
                cronJobId: "cron-1",
                recurring: true,
                type: "cron",
            },
            body: "  keep markdown spacing  ",
            labels: ["P2", "backend"],
            title: "Add observability",
        });
    });

    it("rejects unknown and mistyped task fields with stable issue paths", () => {
        expect(
            captureContractError(() => parseUpdateTaskRequest({ titel: "misspelled" }))
                .issues
        ).toEqual([{ message: "is not allowed", path: "body.titel" }]);
        expect(
            captureContractError(() =>
                parseCreateTaskRequest({ labels: "P2", title: "Task" })
            ).issues
        ).toEqual([{ message: "must be an array of strings", path: "body.labels" }]);
    });

    it("validates exec and scheduled-job transport shapes before service logic", () => {
        const clearedDisableIntent = JSON.parse("null") as null;
        expect(
            parseExecRequest({
                args: ["-lc", "pwd"],
                command: "bash",
                cwd: "/tmp",
            })
        ).toEqual({
            args: ["-lc", "pwd"],
            command: "bash",
            cwd: "/tmp",
        });
        expect(
            captureContractError(() =>
                parseExecRequest({ command: "pwd", shell: "true" })
            ).issues
        ).toEqual([{ message: "must be a boolean", path: "body.shell" }]);
        expect(
            parseScheduledJobUpdateRequest({
                patch: {
                    disableIntent: {
                        comment: "maintenance",
                        mode: "until",
                        until: "2026-07-29T10:00:00+02:00",
                    },
                    enabled: false,
                },
            })
        ).toEqual({
            patch: {
                disableIntent: {
                    comment: "maintenance",
                    mode: "until",
                    until: "2026-07-29T08:00:00.000Z",
                },
                enabled: false,
            },
        });
        expect(
            parseScheduledJobUpdateRequest({
                patch: {
                    disableIntent: clearedDisableIntent,
                    enabled: false,
                },
            })
        ).toEqual({
            patch: {
                disableIntent: clearedDisableIntent,
                enabled: false,
            },
        });
    });

    it("validates scheduled-job and queue responses before frontend state accepts them", () => {
        expect(
            parseScheduledJobsResponse({
                jobs: [
                    {
                        actionKey: "cache.refresh",
                        actionPayload: { key: "git" },
                        createdAt: "2026-07-28T10:00:00.000Z",
                        description: "Refresh cache",
                        enabled: true,
                        id: "cache-refresh",
                        intervalSeconds: 3600,
                        isQueued: false,
                        isRunning: false,
                        name: "Cache refresh",
                        resourceClass: "network",
                        scheduleType: "interval",
                        timeoutMs: 60_000,
                        updatedAt: "2026-07-28T10:00:00.000Z",
                    },
                ],
            }).jobs[0]
        ).toMatchObject({
            actionKey: "cache.refresh",
            actionPayload: { key: "git" },
            id: "cache-refresh",
            resourceClass: "network",
            scheduleType: "interval",
        });

        expect(
            parseJobExecutionsResponse({
                executions: [
                    {
                        actionKey: "cache.refresh",
                        attempt: 1,
                        availableAt: "2026-07-28T10:00:00.000Z",
                        cancellable: true,
                        displayName: "Cache refresh",
                        id: "019fa8b1-0000-7000-8000-000000000001",
                        queuedAt: "2026-07-28T10:00:00.000Z",
                        resourceClass: "network",
                        status: "queued",
                        triggerType: "manual",
                    },
                ],
                summary: {
                    activeResourceClasses: ["network"],
                    queued: 1,
                    running: 0,
                    workerCapacity: 2,
                    workerCount: 1,
                    workerOnline: true,
                },
            }).summary
        ).toEqual({
            activeResourceClasses: ["network"],
            queued: 1,
            running: 0,
            workerCapacity: 2,
            workerCount: 1,
            workerOnline: true,
        });

        expect(
            captureContractError(() =>
                parseScheduledJobsResponse({
                    jobs: [
                        {
                            actionKey: "cache.refresh",
                            actionPayload: {},
                            createdAt: "2026-07-28T10:00:00.000Z",
                            description: "Refresh cache",
                            enabled: true,
                            id: "cache-refresh",
                            intervalSeconds: 3600,
                            isQueued: false,
                            isRunning: false,
                            name: "Cache refresh",
                            resourceClass: "unbounded",
                            scheduleType: "interval",
                            timeoutMs: 60_000,
                            updatedAt: "2026-07-28T10:00:00.000Z",
                        },
                    ],
                })
            ).issues
        ).toEqual([
            {
                message:
                    "must be one of: interactive, light, network, host-heavy, exclusive",
                path: "response.jobs[0].resourceClass",
            },
        ]);
    });

    it("normalizes report timestamps and rejects malformed metadata", () => {
        expect(
            parseCreateReportInput({
                bodyMd: "Body",
                metadata: { source: "test" },
                occurredAt: "2026-07-28T12:00:00+02:00",
                title: "Report",
                type: "custom",
            })
        ).toEqual({
            bodyMd: "Body",
            metadata: { source: "test" },
            occurredAt: "2026-07-28T10:00:00.000Z",
            status: "ok",
            title: "Report",
            type: "custom",
        });
        expect(
            captureContractError(() =>
                parseCreateReportInput({
                    bodyMd: "Body",
                    metadata: [],
                    title: "Report",
                    type: "custom",
                })
            ).issues
        ).toEqual([{ message: "must be an object", path: "body.metadata" }]);
    });

    it("accepts only the nested standardized API error contract", () => {
        expect(
            parseApiErrorResponse({
                error: {
                    code: "invalid_request",
                    details: { field: "title" },
                    message: "Title is required",
                    requestId: "request-1",
                },
            })
        ).toEqual({
            code: "invalid_request",
            details: { field: "title" },
            message: "Title is required",
            requestId: "request-1",
        });
        expect(
            parseApiErrorResponse({
                code: "invalid_request",
                error: "Title is required",
            })
        ).toBeUndefined();
    });
});
