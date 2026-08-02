import { describe, expect, it } from "bun:test";

import {
    parseAccountSecuritySummary,
    parseMfaStepUpResponse,
    parsePasswordReauthenticationResponse,
    parseTotpEnrollmentRequest,
    parseTotpConfirmationResponse,
    parseWebAuthnRegistrationResponse,
} from "../../../contracts/accountSecurity";
import { parseApiErrorResponse } from "../../../contracts/apiErrors";
import { parseBackupStatusResponse } from "../../../contracts/backups";
import { canonicalChatImageDisplayUrl } from "../../../contracts/chat/canonicalMessage";
import { normalizeOpenClawHistoryMessage } from "../../../contracts/chat/openClawHistoryNormalizer";
import { withCanonicalOpenClawEvents } from "../../../contracts/chat/openClawRuntimeAdapter";
import {
    OPENCLAW_RUNTIME_SNAPSHOT_SCHEMA_VERSION,
    parseOpenClawRuntimeEnvelope,
    parseOpenClawRuntimeSnapshot,
} from "../../../contracts/chat/transport";
import {
    parsePullRequestApproveRequest,
    parsePullRequestPreviewStartRequest,
    parsePullRequestStackCreateRequest,
} from "../../../contracts/delivery";
import { parseExecRequest } from "../../../contracts/exec";
import { parseFileContent, parseFilesResponse } from "../../../contracts/files";
import {
    parseJobExecutionsResponse,
    parseJobWorkerClaimsPatch,
    parseScheduledJobsResponse,
    parseScheduledJobUpdateRequest,
} from "../../../contracts/jobs";
import {
    parseLogRotationRunResult,
    parseLogRotationStatus,
} from "../../../contracts/logRotation";
import {
    moltbookPostFromPayload,
    parseMoltbookFeed,
    parseMoltbookProfile,
} from "../../../contracts/moltbook";
import { parseNotificationsResponse } from "../../../contracts/notifications";
import {
    parseOpenClawConfig,
    parseOpenClawConfigUpdateRequest,
    parseOpenClawSkillsResponse,
} from "../../../contracts/openClawConfig";
import { parseCreateReportInput } from "../../../contracts/reports";
import { ContractValidationError } from "../../../contracts/runtime";
import { parseSocketEnvelope } from "../../../contracts/socket";
import { parseCreateTaskRequest, parseUpdateTaskRequest } from "../../../contracts/tasks";

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
    it("requires stable canonical chat events while preserving provider format metadata", () => {
        const common = {
            runtimeRecordedAt: Date.parse("2026-07-30T08:00:00.000Z"),
            runtimeSequence: 4,
            type: "event" as const,
        };
        const codex = withCanonicalOpenClawEvents({
            ...common,
            event: "chat",
            payload: {
                message: { content: "Done", role: "assistant" },
                runId: "codex-run",
                sessionKey: "agent:main:main",
                state: "final",
            },
        });
        const synthetic = withCanonicalOpenClawEvents({
            ...common,
            event: "session.message",
            payload: {
                message: {
                    content: [{ text: "Done", type: "text" }],
                    model: "syn:large:text",
                    provider: "synthetic",
                    role: "assistant",
                    stopReason: "stop",
                },
                model: "gpt-5.6-sol",
                modelProvider: "openai",
                provider: "openai",
                runId: "synthetic-run",
                sessionKey: "agent:main:main",
            },
        });
        const syntheticUser = withCanonicalOpenClawEvents({
            ...common,
            event: "session.message",
            payload: {
                message: {
                    content: "Continue",
                    role: "user",
                },
                model: "gpt-5.6-sol",
                modelProvider: "openai",
                runId: "synthetic-run",
                sessionKey: "agent:main:main",
            },
        });
        const topLevelSyntheticUser = withCanonicalOpenClawEvents({
            ...common,
            event: "session.message",
            payload: {
                content: "Continue",
                model: "gpt-5.6-sol",
                modelProvider: "openai",
                role: "user",
                runId: "synthetic-run",
                sessionKey: "agent:main:main",
            },
        });

        expect(parseOpenClawRuntimeEnvelope(codex).canonicalEvents).toEqual(
            codex.canonicalEvents
        );
        expect(parseSocketEnvelope(codex).canonicalEvents).toEqual(codex.canonicalEvents);
        expect(codex.canonicalEvents.at(-1)).toMatchObject({
            id: "openclaw:agent%3Amain%3Amain:64:finish",
            lifecycle: "completed",
            outcome: "completed",
            provider: { format: "openclaw-chat" },
            schemaVersion: 1,
            sequence: 64,
        });
        expect(synthetic.canonicalEvents.at(-1)).toMatchObject({
            id: "openclaw:agent%3Amain%3Amain:65:finish",
            lifecycle: "completed",
            outcome: "completed",
            provider: {
                format: "openclaw-session-message",
                model: "syn:large:text",
                provider: "synthetic",
            },
            schemaVersion: 1,
            sequence: 65,
        });
        expect(syntheticUser.canonicalEvents[0]?.provider).toMatchObject({
            format: "openclaw-session-message",
            model: undefined,
            provider: undefined,
        });
        expect(topLevelSyntheticUser.canonicalEvents[0]?.provider).toMatchObject({
            format: "openclaw-session-message",
            model: undefined,
            provider: undefined,
        });
        expect(
            withCanonicalOpenClawEvents(codex).canonicalEvents.map((event) => event.id)
        ).toEqual(codex.canonicalEvents.map((event) => event.id));

        const rawEnvelope: Record<string, unknown> = { ...codex };
        Reflect.deleteProperty(rawEnvelope, "canonicalEvents");
        expect(
            captureContractError(() => parseOpenClawRuntimeEnvelope(rawEnvelope))
                .issues[0]?.path
        ).toBe("runtimeEvent.canonicalEvents");
        expect(() =>
            parseOpenClawRuntimeSnapshot({
                completed: true,
                events: [codex],
                schemaVersion: OPENCLAW_RUNTIME_SNAPSHOT_SCHEMA_VERSION - 1,
                throughSequence: 4,
            })
        ).toThrow(ContractValidationError);
    });

    it("does not rebase external Dashboard-shaped media URLs in a browser", () => {
        const previousLocation = location.href;
        try {
            location.assign("https://dashboard.test/");
            const externalMediaUrl =
                "https://files.example.test/api/media?path=report.png";
            expect(
                canonicalChatImageDisplayUrl(
                    "https://files.example.test/api/chat/media/outgoing/session/file/full",
                    "image/png"
                )
            ).toBeUndefined();
            expect(
                normalizeOpenClawHistoryMessage({
                    content: [
                        {
                            attachment: {
                                label: "report.png",
                                mimeType: "image/png",
                                url: externalMediaUrl,
                            },
                            type: "attachment",
                        },
                    ],
                    role: "assistant",
                }).attachments?.[0]?.url
            ).toBe(externalMediaUrl);
        } finally {
            location.assign(previousLocation);
        }
    });

    it("accepts provider-null Moltbook avatars and normalizes feed display data", () => {
        const feed = parseMoltbookFeed({
            hasMore: false,
            posts: [
                {
                    author: {
                        avatar_url: null,
                        display_name: "Raymond",
                        name: "raymond",
                    },
                    created_at: "2026-07-30T08:00:00.000Z",
                    id: "post-1",
                    submolt_name: "dashboard",
                    title: "Null avatar",
                },
            ],
        });
        expect(moltbookPostFromPayload(feed.posts[0]!)).toMatchObject({
            author: {
                avatar_url: undefined,
                display_name: "Raymond",
                name: "raymond",
            },
            id: "post-1",
        });
        expect(
            parseMoltbookProfile({
                avatar_url: null,
                comments_count: 0,
                description: "",
                display_name: "Mira",
                follower_count: 0,
                following_count: 0,
                karma: 0,
                name: "mira",
                posts_count: 0,
            }).avatar_url
        ).toBeNull();
    });

    it("keeps the worker claims mutation body strict", () => {
        expect(parseJobWorkerClaimsPatch({ paused: true })).toEqual({
            paused: true,
        });
        expect(
            captureContractError(() =>
                parseJobWorkerClaimsPatch({ pause: true })
            ).issues.map((issue) => issue.path)
        ).toEqual(["body.paused", "body.pause"]);
    });

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
        ).toEqual([
            {
                message: 'Invalid key: Expected never but received "titel"',
                path: "body.titel",
            },
        ]);
        expect(
            captureContractError(() =>
                parseCreateTaskRequest({ labels: "P2", title: "Task" })
            ).issues
        ).toEqual([
            {
                message: 'Invalid type: Expected Array but received "P2"',
                path: "body.labels",
            },
        ]);
    });

    it("rejects arrays for strict and extensible request objects", () => {
        for (const parser of [
            parsePullRequestApproveRequest,
            parseTotpEnrollmentRequest,
            parseOpenClawConfigUpdateRequest,
        ]) {
            expect(captureContractError(() => parser([])).issues).toEqual([
                {
                    message: "must be an object",
                    path: "body",
                },
            ]);
        }
    });

    it("validates exact-head stack merge and linear stack creation requests", () => {
        expect(
            parsePullRequestApproveRequest({
                deploy: true,
                expectedHeadSha: "a".repeat(40),
                expectedStackHeads: [
                    { headSha: "9".repeat(40), number: 352 },
                    { headSha: "a".repeat(40), number: 353 },
                ],
                mergeStack: true,
            })
        ).toEqual({
            deploy: true,
            expectedHeadSha: "a".repeat(40),
            expectedStackHeads: [
                { headSha: "9".repeat(40), number: 352 },
                { headSha: "a".repeat(40), number: 353 },
            ],
            mergeStack: true,
        });
        expect(parsePullRequestStackCreateRequest({ pullRequests: [352, 353] })).toEqual({
            pullRequests: [352, 353],
        });
        expect(
            parsePullRequestPreviewStartRequest({
                expectedHeadSha: "b".repeat(40),
            })
        ).toEqual({ expectedHeadSha: "b".repeat(40) });
        expect(() =>
            parsePullRequestStackCreateRequest({ pullRequests: [352] })
        ).toThrow();
        expect(() =>
            parsePullRequestApproveRequest({
                expectedHeadSha: "not-a-full-sha",
                mergeStack: true,
            })
        ).toThrow();
        expect(() =>
            parsePullRequestApproveRequest({
                expectedHeadSha: "a".repeat(40),
                expectedStackHeads: [{ headSha: "short", number: 352 }],
                mergeStack: true,
            })
        ).toThrow();
        expect(() => parsePullRequestApproveRequest({ deploy: false })).toThrow();
        expect(() => parsePullRequestPreviewStartRequest({})).toThrow();
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
        ).toEqual([
            {
                message: 'Invalid type: Expected boolean but received "true"',
                path: "body.shell",
            },
        ]);
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
                    disableIntent: null,
                    enabled: false,
                },
            })
        ).toEqual({
            patch: {
                disableIntent: null,
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
                    'Invalid type: Expected ("interactive" | "light" | "network" | "host-heavy" | "exclusive") but received "unbounded"',
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

    it("validates account, notification, and backup responses at the HTTP boundary", () => {
        expect(
            parseAccountSecuritySummary({
                factors: {
                    methods: ["totp"],
                    recoveryCodesRemaining: 8,
                    totpFactors: [
                        {
                            confirmedAt: "2026-07-28T10:00:00.000Z",
                            createdAt: "2026-07-28T09:59:00.000Z",
                            id: "factor-1",
                            label: "Phone",
                        },
                    ],
                    webAuthnCredentials: [],
                },
                recentVerification: {
                    mfa: true,
                    mfaRemainingMs: 30_000,
                    password: false,
                },
                recommendation: {
                    minimumSecurityKeys: 2,
                    needsBackupSecurityKey: false,
                },
                sessions: [
                    {
                        authMethod: "totp",
                        authenticatedAt: "2026-07-28T10:00:00.000Z",
                        createdAt: "2026-07-28T10:00:00.000Z",
                        expiresAt: "2026-08-28T10:00:00.000Z",
                        isCurrent: true,
                        lastSeenAt: "2026-07-28T10:01:00.000Z",
                        sessionId: "session-1",
                    },
                ],
                totp: { available: true },
                webAuthn: { available: true, rpId: "dashboard.example.test" },
            }).sessions[0]
        ).toMatchObject({
            authMethod: "totp",
            isCurrent: true,
            sessionId: "session-1",
        });

        expect(
            parseNotificationsResponse({
                items: [
                    {
                        createdAt: "2026-07-28T10:00:00.000Z",
                        description: "Ready",
                        id: 1,
                        isRead: false,
                        metadata: { sourceId: 4 },
                        occurredAt: "2026-07-28T10:00:00.000Z",
                        title: "Deployment",
                        type: "success",
                        updatedAt: "2026-07-28T10:00:00.000Z",
                    },
                ],
                readCount: 0,
                unreadCount: 1,
            }).items[0]
        ).toMatchObject({ id: 1, type: "success" });

        expect(
            parseBackupStatusResponse({
                job: {
                    id: "backup-1",
                    startedAt: 100,
                    status: "running",
                    stderr: "",
                    stdout: "",
                    type: "walg",
                },
            }).job
        ).toMatchObject({ id: "backup-1", status: "running", type: "walg" });

        expect(
            captureContractError(() =>
                parseAccountSecuritySummary({
                    factors: {
                        methods: ["sms"],
                        recoveryCodesRemaining: 0,
                        totpFactors: [],
                        webAuthnCredentials: [],
                    },
                    recentVerification: { mfa: false, password: false },
                    recommendation: {
                        minimumSecurityKeys: 2,
                        needsBackupSecurityKey: false,
                    },
                    sessions: [],
                    totp: { available: true },
                    webAuthn: {
                        available: false,
                        reason: "not_configured",
                    },
                })
            ).issues[0]
        ).toEqual({
            message:
                'Invalid type: Expected ("recovery" | "totp" | "webauthn") but received "sms"',
            path: "accountSecurity.factors.methods[0]",
        });
    });

    it("accepts exact route-specific account-security mutation responses", () => {
        const verifiedAt = "2026-07-28T10:00:00.000Z";

        expect(
            parsePasswordReauthenticationResponse({
                isOk: true,
                verifiedAt,
            })
        ).toEqual({ isOk: true, verifiedAt });
        expect(
            parseMfaStepUpResponse({
                isOk: true,
                method: "totp",
                verifiedAt,
            })
        ).toEqual({ isOk: true, method: "totp", verifiedAt });
        expect(
            parseTotpConfirmationResponse({
                factorId: "factor-1",
                isOk: true,
                recoveryCodes: ["recovery-1"],
                sessionRotated: true,
            })
        ).toMatchObject({ factorId: "factor-1", isOk: true });
        expect(
            parseWebAuthnRegistrationResponse({
                credential: {
                    backedUp: false,
                    createdAt: verifiedAt,
                    deviceType: "singleDevice",
                    id: "credential-1",
                    label: "Primary key",
                },
                isOk: true,
                recoveryCodes: ["recovery-1"],
                sessionRotated: true,
            })
        ).toMatchObject({
            credential: { id: "credential-1" },
            isOk: true,
        });

        expect(
            captureContractError(() =>
                parsePasswordReauthenticationResponse({ isOk: true })
            ).issues[0]?.path
        ).toBe("passwordReauthentication.verifiedAt");
        expect(
            captureContractError(() => parseMfaStepUpResponse({ isOk: true })).issues.map(
                (issue) => issue.path
            )
        ).toEqual(["mfaStepUp.method", "mfaStepUp.verifiedAt"]);
    });

    it("validates file, OpenClaw, and log-rotation responses", () => {
        expect(
            parseFilesResponse({
                files: [
                    {
                        modified: "2026-07-28T10:00:00.000Z",
                        name: "README.md",
                        path: "README.md",
                        size: 42,
                        type: "file",
                    },
                ],
                root: "/workspace",
            }).files[0]
        ).toMatchObject({ name: "README.md", type: "file" });
        expect(
            parseFileContent({
                content: "# Readme",
                isBinary: false,
                modified: "2026-07-28T10:00:00.000Z",
                path: "README.md",
                size: 8,
            })
        ).toMatchObject({ isBinary: false, path: "README.md" });

        expect(
            parseOpenClawConfig({
                __hash: "config-hash",
                agents: { list: [{ id: "main", unknownExternalField: true }] },
            })
        ).toMatchObject({ __hash: "config-hash" });
        expect(
            parseOpenClawSkillsResponse({
                skills: [
                    {
                        enabled: true,
                        name: "github",
                        path: "skills.entries.github",
                        source: "builtin",
                    },
                ],
            }).skills[0]
        ).toMatchObject({ name: "github", source: "builtin" });

        const summary = {
            checkedFiles: 2,
            checkedGroups: 1,
            compressedFiles: 0,
            deletedArchives: 0,
            errors: [],
            finishedAt: "2026-07-28T10:00:01.000Z",
            groups: [
                {
                    checkedFiles: 2,
                    compressedFiles: 0,
                    deletedArchives: 0,
                    name: "dashboard",
                    rotatedFiles: 1,
                    skippedFiles: 1,
                },
            ],
            isDryRun: false,
            isOk: true,
            rotatedFiles: 1,
            skippedFiles: 1,
            startedAt: "2026-07-28T10:00:00.000Z",
            warnings: [],
        };
        expect(
            parseLogRotationStatus({ isSuccess: true, lastRun: summary }).lastRun
        ).toMatchObject({ checkedFiles: 2, isOk: true });
        expect(
            parseLogRotationRunResult({
                isSuccess: true,
                result: summary,
                stderr: "",
            }).result.rotatedFiles
        ).toBe(1);
    });
});
