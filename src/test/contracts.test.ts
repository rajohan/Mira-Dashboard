import { describe, expect, it } from "bun:test";

import { parseApiErrorResponse } from "../../contracts/apiErrors";
import { parseExecRequest } from "../../contracts/exec";
import { parseScheduledJobUpdateRequest } from "../../contracts/jobs";
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
                    recurring: true,
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
