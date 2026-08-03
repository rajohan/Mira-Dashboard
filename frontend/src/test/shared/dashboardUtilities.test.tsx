import { afterEach, beforeEach, describe, expect, it, jest } from "bun:test";

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement } from "react";

import { normalizeOpenClawHistoryMessage } from "../../../../contracts/chat/openClawHistoryNormalizer";
import { requestBodyText, requestUrl } from "../../../../test/support/fetch";
import {
    base64ToText,
    dataUrlToBase64,
    displayMimeType,
    readFileAsDataUrl,
} from "../../components/features/chat/chatAttachmentUtilities";
import {
    isRecoveredAssistantText,
    messageDeleteKey,
    messageIdentity,
} from "../../components/features/chat/chatMessageIdentity";
import {
    dedupeMessages,
    mergeWithRecentOptimisticMessages,
} from "../../components/features/chat/chatMessageReconciliation";
import {
    attachmentKind,
    chatImageDownloadUrl,
    chatImageUrl,
    chatTransportAttachments,
    extractImages,
    extractThinkingBlocks,
    extractToolCalls,
    normalizeText,
    optimisticAttachmentDisplay,
} from "../../components/features/chat/chatTypes";
import {
    buildSlashCommandSuggestions,
    slashCommandCanonicalName,
} from "../../components/features/chat/slashCommands";
import {
    formatBytes as formatDatabaseBytes,
    formatNumber as formatDatabaseNumber,
    postgresMaintenanceAttention,
    truncateQuery,
} from "../../components/features/database/databaseUtilities";
import {
    formatBytes as formatDockerBytes,
    formatDockerMemory,
    formatFullVersionDisplay,
    formatTimestamp,
    formatUpdaterTransition,
    formatVersionDisplay,
} from "../../components/features/docker/dockerFormatters";
import { TaskOverlay } from "../../components/features/tasks/TaskOverlay";
import { NotificationBell } from "../../components/layout/NotificationBell";
import {
    useClearKopiaBackupAttention,
    useClearWalgBackupAttention,
    useRunWalgBackup,
} from "../../hooks/useBackups";
import {
    useCreateNotification,
    useMarkAllNotificationsRead,
} from "../../hooks/useNotifications";
import { hasQuotaStatus } from "../../hooks/useQuotas";
import { scheduledJobKeys } from "../../hooks/useScheduledJobs";
import { uninstallAuthSessionRotationSync } from "../../lib/authBoundary";
import { messageFromError } from "../../lib/errorMessage";
import { resetUserActivityForTests } from "../../lib/userActivity";
import { compareLogEntriesByLineId } from "../../pages/logPageUtilities";
import { Reports } from "../../pages/Reports";
import { authActions } from "../../stores/authStore";
import {
    formatCronLastStatus,
    formatCronTimestamp,
    getCronJobId,
    getCronJobName,
    getCronStateValue,
    getCronStatusVariant,
    isCronExpressionValid,
    sortCronJobs,
} from "../../utils/cronUtilities";
import {
    APP_TIME_ZONE,
    appTimeZoneParts,
    appTimeZoneShortMonth,
    appTimeZoneShortWeekday,
    appZonedUtcDate,
    currentIsoString,
    currentYear,
    isoStringFromDate,
    timestampFromDateString,
} from "../../utils/date";
import {
    getFileExtension,
    getLanguage,
    getSyntaxClass,
    isBinaryFile,
    isCodeFile,
    isImageFile,
    isJsonFile,
    isMarkdownFile,
} from "../../utils/fileUtilities";
import {
    appDateTimeToTimestamp,
    appTimeOfDayToUtcTimeOfDay,
    formatDate,
    formatDateStamp,
    formatDuration,
    formatLoad,
    formatOsloClock,
    formatOsloDate,
    formatOsloTime,
    formatSize,
    formatTokenCount,
    formatTokens,
    formatUptime,
    formatUtcTimeOfDayInAppTimeZone,
    formatWeekdayShort,
    getTokenPercent,
} from "../../utils/format";
import {
    formatLogTime,
    getLevelColor,
    getSubsystemColor,
    parseLogLine,
} from "../../utils/logUtilities";
import {
    formatSessionType,
    getTypeSortOrder,
    sortSessionsByTypeAndActivity,
} from "../../utils/sessionUtilities";
import { createFrontendBehaviorHarness } from "../support/frontendBehaviorHarness";
describe("Dashboard shared utilities and reports", () => {
    const {
        chatMessage,
        createNotificationsApi,
        getButtonByText,
        inlineRasterImage,
        notification,
        renderHookWithQueryClient,
        renderWithQueryClientAndRouter,
        task,
    } = createFrontendBehaviorHarness();
    beforeEach(() => {
        authActions.clearSession();
        resetUserActivityForTests();
    });
    afterEach(() => {
        uninstallAuthSessionRotationSync();
        authActions.clearSession();
        resetUserActivityForTests();
    });
    it("drives backup attention, notification creation, quota guards, overlay, and date format behavior", () => {
        const fetchMock = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
            return Promise.try(() => {
                const url = requestUrl(input);
                const method = init?.method ?? "GET";
                if (url === "/api/backups/walg/run" && method === "POST") {
                    return Response.json({
                        isOk: true,
                        job: {
                            id: "walg-1",
                            type: "walg",
                            status: "running",
                            stdout: "",
                            stderr: "",
                            startedAt: 1,
                        },
                    });
                }
                if (
                    url === "/api/backups/kopia/clear-needs-attention" &&
                    method === "POST"
                ) {
                    return Response.json({
                        isOk: true,
                        cleared: {
                            id: "kopia-attention",
                            type: "kopia",
                            status: "needs_attention",
                            stdout: "warn",
                            stderr: "",
                            startedAt: 1,
                        },
                    });
                }
                if (
                    url === "/api/backups/walg/clear-needs-attention" &&
                    method === "POST"
                ) {
                    return Response.json({
                        isOk: true,
                        cleared: {
                            id: "walg-attention",
                            type: "walg",
                            status: "needs_attention",
                            stdout: "warn",
                            stderr: "",
                            startedAt: 1,
                        },
                    });
                }
                if (url === "/api/notifications" && method === "POST") {
                    expect(JSON.parse(requestBodyText(init?.body))).toEqual({
                        title: "Functional coverage",
                        description: "Created from a hook",
                        source: "tests",
                    });
                    return Response.json({
                        isOk: true,
                        id: 123,
                    });
                }
                if (url === "/api/notifications/mark-all-read" && method === "POST") {
                    return Response.json({
                        isOk: true,
                    });
                }
                throw new Error(`Unexpected extended hook API call: ${method} ${url}`);
            });
        });
        Object.defineProperty(globalThis, "fetch", {
            configurable: true,
            value: fetchMock,
            writable: true,
        });
        const runWalg = renderHookWithQueryClient(() => useRunWalgBackup());
        runWalg.queryClient.setQueryData(scheduledJobKeys.list(), {
            jobs: [],
        });
        runWalg.queryClient.setQueryData(scheduledJobKeys.runs("backup.walg"), {
            runs: [],
        });
        expect(runWalg.result.current.mutateAsync()).resolves.toMatchObject({
            job: {
                id: "walg-1",
                status: "running",
            },
        });
        expect(
            runWalg.queryClient.getQueryState(scheduledJobKeys.list())?.isInvalidated
        ).toBe(true);
        expect(
            runWalg.queryClient.getQueryState(scheduledJobKeys.runs("backup.walg"))
                ?.isInvalidated
        ).toBe(true);
        const clearKopia = renderHookWithQueryClient(() =>
            useClearKopiaBackupAttention()
        );
        expect(clearKopia.result.current.mutateAsync()).resolves.toMatchObject({
            cleared: {
                id: "kopia-attention",
            },
        });
        const clearWalg = renderHookWithQueryClient(() => useClearWalgBackupAttention());
        expect(clearWalg.result.current.mutateAsync()).resolves.toMatchObject({
            cleared: {
                id: "walg-attention",
            },
        });
        const createNotification = renderHookWithQueryClient(() =>
            useCreateNotification()
        );
        expect(
            createNotification.result.current.mutateAsync({
                title: "Functional coverage",
                description: "Created from a hook",
                source: "tests",
            })
        ).resolves.toEqual({
            isOk: true,
            id: 123,
        });
        const markAllRead = renderHookWithQueryClient(() =>
            useMarkAllNotificationsRead()
        );
        expect(markAllRead.result.current.mutateAsync()).resolves.toEqual({
            isOk: true,
        });
        expect(
            hasQuotaStatus({
                status: "error",
                note: "offline",
            })
        ).toBe(true);
        expect(
            hasQuotaStatus({
                status: "fresh",
            })
        ).toBe(false);
        expect(hasQuotaStatus()).toBe(false);
        render(
            createElement(TaskOverlay, {
                task: task({
                    number: 9,
                    title: "Recurring overlay task",
                    labels: [
                        {
                            name: "priority-low",
                        },
                    ],
                    automation: {
                        type: "cron",
                        recurring: true,
                        cronJobId: "cron-9",
                    },
                }),
            })
        );
        expect(screen.getByText("#9")).toBeInTheDocument();
        expect(screen.getByText("LOW")).toBeInTheDocument();
        expect(screen.getByText("Recurring")).toBeInTheDocument();
        const osloDate = new Date("2026-06-23T12:34:56.000Z");
        expect(formatDate(osloDate)).toBe("23.06.2026, 14:34");
        expect(formatOsloClock(osloDate)).toBe("14:34");
        expect(formatDateStamp(osloDate)).toBe("2026-06-23");
        expect(formatOsloTime(osloDate)).toBe("14:34:56");
        expect(formatOsloDate(osloDate)).toContain("Tuesday 23. Jun 2026");
        expect(formatDuration()).toBe("Unknown");
        expect(formatLoad([0.1234, 2])).toBe("0.12, 2.00");
        expect(formatTokenCount(999)).toBe("999");
        expect(getTokenPercent(undefined, 100)).toBe(0);
        expect(getTokenPercent(150, 100)).toBe(100);
    });
    it("drives notification filtering and mutations through the bell menu", async () => {
        const notifications = [
            notification({
                id: 1,
                title: "Cache refresh failed",
                description: "Needs attention",
                metadata: {
                    reportId: 42,
                },
                type: "warning",
                occurredAt: "2026-06-23T10:00:00.000Z",
            }),
            notification({
                id: 2,
                title: "Backup complete",
                isRead: true,
                type: "success",
                occurredAt: "2026-06-23T09:00:00.000Z",
            }),
            notification({
                id: 3,
                title: "Workspace sync failed",
                isRead: true,
                type: "error",
                occurredAt: "2026-06-23T08:00:00.000Z",
            }),
        ];
        const fetchMock = createNotificationsApi(notifications);
        Object.defineProperty(globalThis, "fetch", {
            configurable: true,
            value: fetchMock,
            writable: true,
        });
        const user = userEvent.setup();
        renderWithQueryClientAndRouter(createElement(NotificationBell));
        await user.click(
            await screen.findByRole("button", {
                name: /open notifications, 1 unread/i,
            })
        );
        expect(await screen.findByText("Cache refresh failed")).toBeInTheDocument();
        expect(screen.getByText("Backup complete")).toBeInTheDocument();
        expect(screen.getByText("Workspace sync failed")).toBeInTheDocument();
        expect(screen.getByText("error")).toHaveClass("bg-red-500/20", "text-red-400");
        expect(screen.getByText("Open report").closest("a")?.getAttribute("href")).toBe(
            "/reports?reportId=42"
        );
        await user.click(
            screen.getByRole("menuitemradio", {
                name: "Error",
            })
        );
        expect(screen.getByText("Workspace sync failed")).toBeInTheDocument();
        expect(screen.queryByText("Cache refresh failed")).not.toBeInTheDocument();
        expect(screen.queryByText("Backup complete")).not.toBeInTheDocument();
        await user.click(
            screen.getByRole("menuitemradio", {
                name: "Unread",
            })
        );
        expect(screen.getByText("Cache refresh failed")).toBeInTheDocument();
        expect(screen.queryByText("Backup complete")).not.toBeInTheDocument();
        await user.click(getButtonByText("Mark read"));
        await waitFor(() =>
            expect(fetchMock).toHaveBeenCalledWith(
                "/api/notifications/1/read",
                expect.objectContaining({
                    method: "POST",
                })
            )
        );
        await user.click(
            screen.getByRole("menuitemradio", {
                name: "All",
            })
        );
        expect(await screen.findByText("Backup complete")).toBeInTheDocument();
        await user.click(getButtonByText("Clear"));
        await waitFor(() =>
            expect(fetchMock).toHaveBeenCalledWith(
                "/api/notifications/1",
                expect.objectContaining({
                    method: "DELETE",
                })
            )
        );
        await user.click(getButtonByText("Clear all read"));
        await waitFor(() =>
            expect(fetchMock).toHaveBeenCalledWith(
                "/api/notifications/clear-read",
                expect.objectContaining({
                    body: "{}",
                    method: "POST",
                })
            )
        );
        await waitFor(() =>
            expect(screen.queryByText("Backup complete")).not.toBeInTheDocument()
        );
    });
    it("renders dashboard reports and switches report filters", async () => {
        const fetchMock = jest.fn((input: RequestInfo | URL) => {
            return Promise.try(() => {
                const url = requestUrl(input);
                const [path, query = ""] = url.split("?", 2);
                const reportType = new URLSearchParams(query).get("type");
                if (path === "/api/reports" && reportType === "heartbeat") {
                    return Response.json({
                        items: [
                            {
                                id: 11,
                                type: "heartbeat",
                                status: "warning",
                                title: "Heartbeat warning",
                                bodyMd: "Git check needs attention.",
                                summary: "Git check needs attention.",
                                source: "openclaw",
                                sourceJobId: "ops-check",
                                dedupeKey: "heartbeat:warning:git",
                                metadata: {},
                                createdAt: "2026-06-23T07:00:00.000Z",
                                updatedAt: "2026-06-23T07:00:00.000Z",
                                occurredAt: "2026-06-23T07:00:00.000Z",
                            },
                        ],
                    });
                }
                if (path === "/api/reports") {
                    return Response.json({
                        items: [
                            {
                                id: 10,
                                type: "daily_brief",
                                status: "ok",
                                title: "Daily brief",
                                bodyMd: "# Brief\n\n- Review PRs",
                                summary: "Review PRs",
                                source: "openclaw",
                                sourceJobId: "daily-brief",
                                dedupeKey: "brief:2026-06-23",
                                metadata: {},
                                createdAt: "2026-06-23T06:00:00.000Z",
                                updatedAt: "2026-06-23T06:00:00.000Z",
                                occurredAt: "2026-06-23T06:00:00.000Z",
                            },
                        ],
                    });
                }
                return Response.json({
                    items: [],
                });
            });
        });
        Object.defineProperty(globalThis, "fetch", {
            configurable: true,
            value: fetchMock,
            writable: true,
        });
        const user = userEvent.setup();
        renderWithQueryClientAndRouter(createElement(Reports), "/reports");
        expect(await screen.findAllByText("Daily brief")).not.toHaveLength(0);
        expect(await screen.findAllByText("Review PRs")).not.toHaveLength(0);
        await user.click(
            screen.getByRole("button", {
                name: /heartbeat/i,
            })
        );
        await waitFor(() =>
            expect(fetchMock).toHaveBeenCalledWith(
                "/api/reports?type=heartbeat",
                expect.any(Object)
            )
        );
        expect(await screen.findAllByText("Heartbeat warning")).not.toHaveLength(0);
        await waitFor(() =>
            expect(screen.getAllByText("Git check needs attention.")).toHaveLength(2)
        );
    });
    it("loads linked dashboard report details outside the first report page", async () => {
        const fetchMock = jest.fn((input: RequestInfo | URL) => {
            return Promise.try(() => {
                const url = requestUrl(input);
                const [path, query = ""] = url.split("?", 2);
                const reportType = new URLSearchParams(query).get("type");
                if (path === "/api/reports" && reportType === "heartbeat") {
                    return Response.json({
                        items: [
                            {
                                id: 11,
                                type: "heartbeat",
                                status: "warning",
                                title: "Linked page heartbeat",
                                bodyMd: "",
                                summary: "Heartbeat summary.",
                                source: "openclaw",
                                sourceJobId: "ops-check",
                                dedupeKey: "heartbeat:warning:cache",
                                metadata: {},
                                createdAt: "2026-06-23T10:00:00.000Z",
                                updatedAt: "2026-06-23T10:00:00.000Z",
                                occurredAt: "2026-06-23T10:00:00.000Z",
                            },
                        ],
                    });
                }
                if (path === "/api/reports") {
                    return Response.json({
                        items: [
                            {
                                id: 10,
                                type: "daily_brief",
                                status: "ok",
                                title: "Newest brief",
                                bodyMd: "Newest body.",
                                summary: "Newest summary.",
                                source: "openclaw",
                                sourceJobId: "daily-brief",
                                dedupeKey: "brief:latest",
                                metadata: {},
                                createdAt: "2026-06-23T09:00:00.000Z",
                                updatedAt: "2026-06-23T09:00:00.000Z",
                                occurredAt: "2026-06-23T09:00:00.000Z",
                            },
                        ],
                    });
                }
                if (url === "/api/reports/99") {
                    return Response.json({
                        report: {
                            id: 99,
                            type: "daily_summary",
                            status: "ok",
                            title: "Linked old summary",
                            bodyMd: "Linked body.",
                            summary: "Linked summary.",
                            source: "openclaw",
                            sourceJobId: "daily-summary",
                            dedupeKey: "summary:old",
                            metadata: {},
                            createdAt: "2026-06-20T20:00:00.000Z",
                            updatedAt: "2026-06-20T20:00:00.000Z",
                            occurredAt: "2026-06-20T20:00:00.000Z",
                        },
                    });
                }
                return Response.json({
                    items: [],
                });
            });
        });
        Object.defineProperty(globalThis, "fetch", {
            configurable: true,
            value: fetchMock,
            writable: true,
        });
        const user = userEvent.setup();
        renderWithQueryClientAndRouter(createElement(Reports), "/reports?reportId=99");
        expect(await screen.findAllByText("Linked old summary")).not.toHaveLength(0);
        expect(screen.getByText("Linked body.")).toBeInTheDocument();
        await user.click(
            screen.getByRole("button", {
                name: /heartbeat/i,
            })
        );
        expect(await screen.findAllByText("Linked page heartbeat")).not.toHaveLength(0);
        await waitFor(() =>
            expect(screen.queryByText("Linked old summary")).not.toBeInTheDocument()
        );
    });
    it("keeps log, file, cron, session, and format utilities aligned with UI behavior", () => {
        const structured = parseLogLine(
            '{"_meta":{"logLevelName":"WARN","date":"2026-06-23T08:00:00.000Z"},"0":"[agent/main] Ready"}',
            1
        );
        expect(structured).toMatchObject({
            level: "warn",
            subsystem: "main",
            msg: "Ready",
        });
        expect(parseLogLine("gateway: connected", 2)).toMatchObject({
            subsystem: "gateway",
            msg: "connected",
        });
        expect(parseLogLine("[agent/main] Ready", 3)).toMatchObject({
            subsystem: "main",
            msg: "Ready",
        });
        expect(
            parseLogLine(
                String.raw`{"0":"{\"module\":\"worker\",\"message\":\"Nested ready\"}"}`,
                4
            )
        ).toMatchObject({
            subsystem: "worker",
            msg: "Nested ready",
        });
        expect(parseLogLine('{"level":"debug","message":{"ok":true}}', 5)).toMatchObject({
            level: "debug",
            msg: '{"ok":true}',
        });
        expect(parseLogLine("fallback: connected")).toMatchObject({
            id: expect.stringContaining("fallback:"),
            lineId: expect.stringContaining("fallback:"),
            subsystem: "fallback",
            msg: "connected",
        });
        expect(
            compareLogEntriesByLineId(
                {
                    lineId: "10",
                },
                {
                    lineId: "20",
                }
            )
        ).toBeLessThan(0);
        expect(
            compareLogEntriesByLineId(
                {
                    lineId: "20",
                },
                {
                    lineId: "10",
                }
            )
        ).toBeGreaterThan(0);
        expect(
            compareLogEntriesByLineId(
                {
                    lineId: "10",
                },
                {}
            )
        ).toBeLessThan(0);
        expect(
            compareLogEntriesByLineId(
                {},
                {
                    lineId: "10",
                }
            )
        ).toBeGreaterThan(0);
        expect(
            compareLogEntriesByLineId(
                {
                    lineId: " ",
                },
                {
                    lineId: "10",
                }
            )
        ).toBeGreaterThan(0);
        expect(compareLogEntriesByLineId({}, {})).toBe(0);
        expect(parseLogLine("")).toBeUndefined();
        expect(formatLogTime("not-a-date")).toBe("--:--:--");
        expect(formatLogTime()).toBe("");
        expect(getLevelColor("fatal")).toContain("text-red");
        expect(getLevelColor("error")).toContain("text-red");
        expect(getLevelColor("warn")).toContain("yellow");
        expect(getLevelColor("trace")).toContain("primary-500");
        expect(getLevelColor("unknown")).toContain("primary-400");
        expect(getSubsystemColor()).toBe("");
        expect(getSubsystemColor("exec")).toContain("green");
        expect(getSubsystemColor("tools")).toContain("orange");
        expect(getSubsystemColor("agent")).toContain("purple");
        expect(getSubsystemColor("gateway")).toContain("cyan");
        expect(getSubsystemColor("cron")).toContain("pink");
        expect(getSubsystemColor("session")).toContain("indigo");
        expect(getSubsystemColor("http")).toContain("teal");
        expect(getSubsystemColor("memory")).toContain("emerald");
        expect(getSubsystemColor("ws")).toContain("amber");
        expect(getSubsystemColor("other")).toContain("purple");
        expect(getFileExtension("README.MD")).toBe("md");
        expect(isMarkdownFile("notes.markdown")).toBe(true);
        expect(isJsonFile("config.json5")).toBe(true);
        expect(isCodeFile("main.tsx")).toBe(true);
        expect(isImageFile("avatar.webp")).toBe(true);
        expect(isBinaryFile("archive.zip")).toBe(true);
        expect(getLanguage("query.graphql")).toBe("graphql");
        expect(getSyntaxClass("config.yaml")).toBe("text-purple-400");
        expect(isCronExpressionValid("*/15 0-23 * * 1-5")).toBe(true);
        expect(isCronExpressionValid("0,30 9,18 * 1-12 0,7")).toBe(true);
        expect(isCronExpressionValid("5-55/10 * * * *")).toBe(true);
        expect(isCronExpressionValid("* * * *")).toBe(false);
        expect(isCronExpressionValid("60 * * * *")).toBe(false);
        expect(isCronExpressionValid("*/0 * * * *")).toBe(false);
        expect(isCronExpressionValid("30-10 * * * *")).toBe(false);
        expect(isCronExpressionValid("0,,30 * * * *")).toBe(false);
        const sortedCronJobs = sortCronJobs([
            {
                id: "b",
                name: "Beta",
                enabled: false,
            },
            {
                jobId: "a",
                name: "Alpha",
                enabled: true,
            },
        ] as never);
        expect(sortedCronJobs.map((job) => getCronJobName(job))).toEqual([
            "Alpha",
            "Beta",
        ]);
        expect(
            getCronJobId({
                jobId: "job-id",
            })
        ).toBe("job-id");
        expect(
            getCronStateValue(
                {
                    state: {
                        lastStatus: "ok",
                    },
                },
                "lastStatus"
            )
        ).toBe("ok");
        expect(formatCronTimestamp("bad")).toBe("—");
        expect(formatCronLastStatus(" success ")).toBe("SUCCESS");
        expect(formatCronLastStatus()).toBe("UNKNOWN");
        expect(getCronStatusVariant("completed")).toBe("success");
        expect(getCronStatusVariant("in_progress")).toBe("warning");
        expect(getCronStatusVariant("failed")).toBe("error");
        expect(getCronStatusVariant("not-started")).toBe("default");
        const sortedSessions = sortSessionsByTypeAndActivity([
            {
                key: "cron",
                type: "cron",
                updatedAt: 3,
                displayLabel: "Cron",
            },
            {
                key: "agent:main:main",
                type: "main",
                updatedAt: 1,
                displayLabel: "Main",
            },
            {
                key: "sub",
                type: "subagent",
                agentType: "researcher",
                updatedAt: 2,
                displayLabel: "Research",
            },
        ] as never);
        expect(sortedSessions.map((session) => session.key)).toEqual([
            "agent:main:main",
            "sub",
            "cron",
        ]);
        expect(formatSessionType(sortedSessions[1]!)).toBe("RESEARCHER");
        expect(getTypeSortOrder("unknown")).toBe(4);
        expect(formatSize(1536)).toBe("1.5 KB");
        expect(formatSize(-1)).toBe("Unknown");
        expect(formatSize(Infinity)).toBe("Unknown");
        expect(formatSize(0)).toBe("0 B");
        expect(formatSize(1024 ** 4)).toBe("1.0 TB");
        expect(formatLoad([0.1234, 2, 15.678])).toBe("0.12, 2.00, 15.68");
        expect(formatUptime(90_061)).toBe("1d 1h");
        expect(formatUptime(7261)).toBe("2h 1m");
        expect(formatUptime(59)).toBe("0m");
        expect(formatTokens(12_345, 200_000)).toBe("12.3k / 200k");
        expect(formatTokenCount(1_250_000)).toBe("1.25M");
        expect(formatTokenCount(12_500)).toBe("12.5K");
        expect(formatTokenCount(999)).toBe("999");
        expect(getTokenPercent(60, 120)).toBe(50);
        expect(getTokenPercent(undefined, 120)).toBe(0);
        expect(getTokenPercent(60, 0)).toBe(0);
        expect(getTokenPercent(150, 120)).toBe(100);
        expect(formatDate("bad")).toBe("bad");
        expect(formatOsloClock("bad")).toBe("--:--");
        expect(formatDateStamp(new Date("bad"))).toBe("unknown-date");
        expect(formatOsloTime(new Date("bad"))).toBe("--:--:--");
        expect(formatOsloDate(new Date("bad"))).toBe("Unknown date");
        expect(formatWeekdayShort(new Date("bad"))).toBe("---");
        expect(formatDuration()).toBe("Unknown");
        expect(formatUtcTimeOfDayInAppTimeZone("bad")).toBe("--:--");
        expect(formatUtcTimeOfDayInAppTimeZone("12:30", "2026-01-15T00:00:00.000Z")).toBe(
            "13:30"
        );
        expect(appTimeOfDayToUtcTimeOfDay("bad")).toBe("bad");
        expect(appTimeOfDayToUtcTimeOfDay("13:30", "2026-01-15T00:00:00.000Z")).toBe(
            "12:30"
        );
        expect(appDateTimeToTimestamp(2026, 6, 23, 14, 34)).toBe(
            Date.parse("2026-06-23T12:34:00.000Z")
        );
        expect(appDateTimeToTimestamp(2026, 2, 30, 14, 34)).toBeUndefined();
        expect(appDateTimeToTimestamp(2026, 3, 29, 2, 30)).toBeUndefined();
    });
    it("keeps chat utility behavior stable for slash commands, diagnostics, and optimistic messages", () => {
        expect(messageFromError(new Error("  failed  "), "fallback")).toBe("failed");
        expect(messageFromError("failed", "fallback")).toBe("failed");
        expect(
            messageFromError(
                {
                    error: {
                        message: "nested API failure",
                    },
                },
                "fallback"
            )
        ).toBe("nested API failure");
        expect(messageFromError({}, "fallback")).toBe("fallback");
        expect(messageFromError("[object Object]", "fallback")).toBe("fallback");
        expect(dataUrlToBase64("data:text/plain;base64,SGVsbG8=")).toBe("SGVsbG8=");
        expect(dataUrlToBase64("SGVsbG8=")).toBe("SGVsbG8=");
        expect(base64ToText("SGVsbG8=")).toBe("Hello");
        expect(base64ToText("***")).toBeUndefined();
        expect(readFileAsDataUrl(new File(["hello"], "hello.txt"))).resolves.toMatch(
            /^data:/
        );
        expect(displayMimeType(new File(["hello"], "hello.txt"))).toBe("text/plain");
        expect(displayMimeType(new File(["image"], "photo.PNG"))).toBe("image/png");
        expect(
            displayMimeType(
                new File(["image"], "photo.png", {
                    type: "application/octet-stream",
                })
            )
        ).toBe("image/png");
        expect(displayMimeType(new File(["vector"], "diagram.svg"))).toBe(
            "image/svg+xml"
        );
        expect(displayMimeType(new File(["unknown"], "payload.bin"))).toBe(
            "application/octet-stream"
        );
        expect(
            displayMimeType(
                new File(["hello"], "hello.txt", {
                    type: "text/plain",
                })
            )
        ).toBe("text/plain");
        expect(slashCommandCanonicalName("/abort")).toBe("/stop");
        expect(
            buildSlashCommandSuggestions("/model gpt", [
                {
                    id: "openai/gpt-5.5",
                },
                {
                    label: "ollama/glm-5",
                },
            ])
        ).toContainEqual(
            expect.objectContaining({
                value: "/model openai/gpt-5.5",
                title: "openai/gpt-5.5",
            })
        );
        expect(buildSlashCommandSuggestions("hello", [])).toEqual([]);
        expect(buildSlashCommandSuggestions("/think", [])).toContainEqual(
            expect.objectContaining({
                requiresArgument: false,
                value: "/think ",
            })
        );
        expect(buildSlashCommandSuggestions("/bash", [])).toContainEqual(
            expect.objectContaining({
                requiresArgument: true,
                value: "/bash ",
            })
        );
        const toolResult = chatMessage({
            role: "tool",
            text: "",
            timestamp: "2026-06-23T08:00:00.000Z",
            toolResult: {
                id: "tool-1",
                name: "exec",
                content: "done",
            },
        });
        expect(messageIdentity(toolResult)).toContain("tool-result::tool-1::exec");
        expect(messageDeleteKey(toolResult)).toStartWith(
            "tool::2026-06-23T08:00:00.000Z::no-run::v2:"
        );
        expect(messageDeleteKey(toolResult)).not.toContain("done");
        const textToolMessage = chatMessage({
            role: "assistant",
            text: "Checking",
            timestamp: "2026-06-23T08:00:01.000Z",
            toolCalls: [
                {
                    id: "tool-a",
                    name: "exec",
                },
            ],
        });
        expect(messageDeleteKey(textToolMessage)).not.toContain("Checking");
        expect(messageDeleteKey(textToolMessage)).not.toContain("tool-a");
        expect(
            messageDeleteKey({
                ...textToolMessage,
                toolCalls: [
                    {
                        id: "tool-b",
                        name: "exec",
                    },
                ],
            })
        ).not.toBe(messageDeleteKey(textToolMessage));
        const textMediaMessage = chatMessage({
            attachments: [
                {
                    fileName: "first.txt",
                    id: "first",
                    kind: "file",
                    mimeType: "text/plain",
                },
            ],
            role: "assistant",
            text: "Generated file",
            timestamp: "2026-06-23T08:00:02.000Z",
        });
        expect(
            messageDeleteKey({
                ...textMediaMessage,
                attachments: [
                    {
                        fileName: "second.txt",
                        id: "second",
                        kind: "file",
                        mimeType: "text/plain",
                    },
                ],
            })
        ).not.toBe(messageDeleteKey(textMediaMessage));
        const duplicateMessages = dedupeMessages([
            chatMessage({
                role: "assistant",
                text: "same",
            }),
            chatMessage({
                role: "assistant",
                text: "same",
            }),
            chatMessage({
                role: "user",
                text: "different",
            }),
        ]);
        expect(duplicateMessages.map((message) => message.text)).toEqual([
            "same",
            "different",
        ]);
        const distinctUrlOnlyImages = dedupeMessages([
            chatMessage({
                images: [
                    {
                        image_url: {
                            url: "https://files.example.test/first.png",
                        },
                        mimeType: "image/png",
                        type: "image_url",
                    },
                ],
                role: "assistant",
                runId: "run-images",
                text: "",
            }),
            chatMessage({
                images: [
                    {
                        image_url: {
                            url: "https://files.example.test/second.png",
                        },
                        mimeType: "image/png",
                        type: "image_url",
                    },
                ],
                role: "assistant",
                runId: "run-images",
                text: "",
            }),
        ]);
        expect(distinctUrlOnlyImages).toHaveLength(2);
        const duplicateUserMessages = dedupeMessages([
            chatMessage({
                role: "user",
                text: "same question",
            }),
            chatMessage({
                local: true,
                role: "user",
                text: "same question",
            }),
        ]);
        expect(duplicateUserMessages).toHaveLength(1);
        expect(duplicateUserMessages[0]?.text).toBe("same question");
        const intentionalRepeatedUserMessages = dedupeMessages([
            chatMessage({
                role: "user",
                text: "same question",
            }),
            chatMessage({
                role: "user",
                text: "same question",
            }),
        ]);
        expect(intentionalRepeatedUserMessages).toHaveLength(2);
        const duplicatePersistedUserEvent = dedupeMessages([
            chatMessage({
                role: "user",
                runId: "run-restart",
                text: "same question",
                timestamp: "2026-07-30T09:00:00.000Z",
            }),
            chatMessage({
                role: "user",
                runId: "run-restart",
                text: "same question",
                timestamp: "2026-07-30T09:00:00.000Z",
            }),
        ]);
        expect(duplicatePersistedUserEvent).toHaveLength(1);
        const duplicateRuntimeUserEvent = dedupeMessages([
            chatMessage({
                role: "user",
                runId: "run-restart",
                runtimeKey: "user:before-restart",
                text: "same question",
                timestamp: "2026-07-30T09:00:00.000Z",
            }),
            chatMessage({
                role: "user",
                runId: "run-restart",
                runtimeKey: "user:after-restart",
                text: "same question",
                timestamp: "2026-07-30T09:00:00.000Z",
            }),
        ]);
        expect(duplicateRuntimeUserEvent).toHaveLength(1);
        const repeatedPersistedUserTurns = dedupeMessages([
            chatMessage({
                role: "user",
                runId: "run-restart",
                text: "same question",
                timestamp: "2026-07-30T09:00:00.000Z",
            }),
            chatMessage({
                role: "user",
                runId: "run-restart",
                text: "same question",
                timestamp: "2026-07-30T09:00:01.000Z",
            }),
        ]);
        expect(repeatedPersistedUserTurns).toHaveLength(2);
        const oneOptimisticCopyOfRepeatedUserMessages = dedupeMessages([
            chatMessage({
                role: "user",
                text: "same question",
            }),
            chatMessage({
                role: "user",
                text: "same question",
            }),
            chatMessage({
                local: true,
                role: "user",
                text: "same question",
            }),
        ]);
        expect(oneOptimisticCopyOfRepeatedUserMessages).toHaveLength(2);
        const queuedRepeatedUserMessages = dedupeMessages([
            chatMessage({
                role: "user",
                text: "repeat",
            }),
            chatMessage({
                role: "user",
                text: "different",
            }),
            chatMessage({
                role: "user",
                text: "repeat",
            }),
        ]);
        expect(queuedRepeatedUserMessages.map((message) => message.text)).toEqual([
            "repeat",
            "different",
            "repeat",
        ]);
        const repeatedResponseMessages = dedupeMessages([
            chatMessage({
                role: "assistant",
                text: "same",
            }),
            chatMessage({
                role: "user",
                text: "repeat",
            }),
            chatMessage({
                role: "assistant",
                text: "same",
            }),
        ]);
        expect(repeatedResponseMessages.map((message) => message.text)).toEqual([
            "same",
            "repeat",
            "same",
        ]);
        expect(
            isRecoveredAssistantText(
                "This is a sufficiently long assistant response",
                "sufficiently long assistant"
            )
        ).toBe(true);
        expect(isRecoveredAssistantText("", "assistant")).toBe(false);
        expect(isRecoveredAssistantText("short", "short")).toBe(true);
        expect(isRecoveredAssistantText("short", "different")).toBe(false);
        const previousMessages = [
            chatMessage({
                role: "user",
                text: "optimistic",
                local: true,
                timestamp: new Date().toISOString(),
            }),
            chatMessage({
                role: "system",
                text: "local system",
            }),
            chatMessage({
                role: "assistant",
                text: "This assistant response was recovered from local state",
                local: true,
                timestamp: new Date().toISOString(),
            }),
        ];
        const nextMessages = [
            chatMessage({
                role: "assistant",
                text: "assistant response was recovered",
                timestamp: new Date(Date.now() + 1000).toISOString(),
            }),
            chatMessage({
                role: "assistant",
                text: "no timestamp",
            }),
        ];
        expect(
            mergeWithRecentOptimisticMessages(previousMessages, nextMessages).map(
                (message) => message.text
            )
        ).toEqual([
            "optimistic",
            "assistant response was recovered",
            "no timestamp",
            "local system",
        ]);
        const repeatedTurnMessages = mergeWithRecentOptimisticMessages(
            [
                chatMessage({
                    role: "user",
                    text: "OK",
                }),
                chatMessage({
                    role: "assistant",
                    text: "Earlier answer",
                }),
                chatMessage({
                    local: true,
                    role: "user",
                    text: "OK",
                    timestamp: new Date().toISOString(),
                }),
            ],
            [
                chatMessage({
                    role: "user",
                    text: "OK",
                }),
                chatMessage({
                    role: "assistant",
                    text: "Earlier answer",
                }),
            ]
        );
        expect(
            repeatedTurnMessages.filter(
                (message) => message.role === "user" && message.text === "OK"
            )
        ).toHaveLength(2);
        const repeatedAnswerWithCurrentDiagnostics = mergeWithRecentOptimisticMessages(
            [
                chatMessage({
                    role: "user",
                    text: "first",
                }),
                chatMessage({
                    role: "assistant",
                    text: "OK",
                }),
                chatMessage({
                    role: "user",
                    text: "second",
                }),
                chatMessage({
                    local: true,
                    role: "assistant",
                    text: "OK",
                    thinking: [
                        {
                            text: "current turn reasoning",
                        },
                    ],
                    timestamp: new Date().toISOString(),
                }),
            ],
            [
                chatMessage({
                    role: "user",
                    text: "first",
                }),
                chatMessage({
                    role: "assistant",
                    text: "OK",
                }),
                chatMessage({
                    role: "user",
                    text: "second",
                }),
            ]
        );
        expect(repeatedAnswerWithCurrentDiagnostics.at(-1)).toMatchObject({
            local: true,
            role: "assistant",
            text: "OK",
            thinking: [
                {
                    text: "current turn reasoning",
                },
            ],
        });
    });
    it("stores opaque delete keys while scoping runtime rows", () => {
        const existingHistoryMessage = chatMessage({
            role: "assistant",
            runId: "run-1",
            text: "answer",
            timestamp: "2026-06-23T08:00:00.000Z",
        });
        const historyKey = messageDeleteKey(existingHistoryMessage);
        const runtimeKey = messageDeleteKey({
            ...existingHistoryMessage,
            runtimeKey: "runtime-assistant",
        });
        expect(historyKey).toStartWith("assistant::2026-06-23T08:00:00.000Z::run-1::v2:");
        expect(runtimeKey).toStartWith(
            "assistant::2026-06-23T08:00:00.000Z::run-1::runtime-assistant::v2:"
        );
        expect(historyKey).not.toContain("answer");
        expect(runtimeKey).not.toContain("answer");
    });
    it("rejects same-origin API images outside canonical media paths", () => {
        const previousLocation = location.href;
        try {
            location.assign("https://dashboard.test/");
            expect([
                chatImageUrl({
                    image_url: {
                        url: "https://dashboard.test/api/settings",
                    },
                    type: "image_url",
                }),
                chatImageUrl({
                    image_url: {
                        url: "/api/chat/media/outgoing/../../../settings",
                    },
                    type: "image_url",
                }),
            ]).toEqual([undefined, undefined]);
        } finally {
            location.assign(previousLocation);
        }
    });
    it("bounds absolute same-origin managed image URLs", () => {
        const previousLocation = location.href;
        try {
            location.assign("https://dashboard.test/");
            const managedUrl =
                "https://dashboard.test/api/chat/media/outgoing/agent%3Amain%3Amain/123e4567-e89b-42d3-a456-426614174000/full";
            expect(
                chatImageUrl({
                    image_url: {
                        url: managedUrl,
                    },
                    type: "image_url",
                })
            ).toBe(`${managedUrl}?preview=image`);
        } finally {
            location.assign(previousLocation);
        }
    });
    it("keeps external image URLs click-only", () => {
        const externalImage = {
            image_url: {
                url: "https://files.example.test/generated.png",
            },
            type: "image_url" as const,
        };
        expect(chatImageDownloadUrl(externalImage)).toBe(
            "https://files.example.test/generated.png"
        );
        expect(chatImageUrl(externalImage)).toBeUndefined();
    });
    it("validates dimensions from every supported embedded raster header", () => {
        const gifBytes = new Uint8Array(10);
        gifBytes.set(Array.from("GIF89a", (character) => character.codePointAt(0) ?? 0));
        gifBytes.set([3, 0, 2, 0], 6);
        const jpegBytes = new Uint8Array([
            255, 216, 0, 255, 224, 0, 2, 255, 192, 0, 17, 8, 0, 2, 0, 3,
        ]);
        const extendedWebpBytes = new Uint8Array(30);
        extendedWebpBytes.set(
            Array.from("RIFF0000WEBPVP8X", (character) => character.codePointAt(0) ?? 0)
        );
        extendedWebpBytes.set([2, 0, 0, 1, 0, 0], 24);
        const losslessWebpBytes = new Uint8Array(25);
        losslessWebpBytes.set(
            Array.from("RIFF0000WEBPVP8L", (character) => character.codePointAt(0) ?? 0)
        );
        losslessWebpBytes.set([47, 2, 4, 0, 0], 20);
        const lossyWebpBytes = new Uint8Array(30);
        lossyWebpBytes.set(
            Array.from("RIFF0000WEBPVP8 ", (character) => character.codePointAt(0) ?? 0)
        );
        lossyWebpBytes.set([157, 1, 42, 3, 0, 2, 0], 23);
        for (const image of [
            inlineRasterImage("image/gif", gifBytes),
            inlineRasterImage("image/jpeg", jpegBytes),
            inlineRasterImage("image/webp", extendedWebpBytes),
            inlineRasterImage("image/webp", losslessWebpBytes),
            inlineRasterImage("image/webp", lossyWebpBytes),
        ]) {
            expect(chatImageUrl(image.image)).toBe(image.url);
        }
        expect(
            chatImageUrl({
                data: "data:image/png;base64,%not-base64%",
                mimeType: "image/png",
                type: "image",
            })
        ).toBeUndefined();
    });
    it("normalizes chat content blocks, attachments, hidden tool media, and formatter helpers", () => {
        const contentBlocks = [
            {
                type: "text",
                text: "hello",
            },
            {
                type: "thinking",
                thinking: "considering",
            },
            {
                type: "toolCall",
                id: "call-1",
                name: "exec",
                arguments: {
                    cmd: "pwd",
                },
            },
            {
                type: "image",
                data: "abc",
                mimeType: "image/png",
            },
        ];
        expect(extractImages(contentBlocks)).toHaveLength(1);
        expect(extractThinkingBlocks(contentBlocks)).toEqual([
            {
                text: "considering",
            },
        ]);
        expect(extractToolCalls(contentBlocks)).toEqual([
            {
                id: "call-1",
                name: "exec",
                arguments: {
                    cmd: "pwd",
                },
            },
        ]);
        expect(normalizeText(contentBlocks)).toBe("hello\n\n[image]");
        const managedImage = {
            image_url: {
                url: "/api/chat/media/outgoing/agent%3Amain%3Amain/123e4567-e89b-42d3-a456-426614174000/full",
            },
            mimeType: "image/png",
            type: "image_url",
        } as const;
        expect(chatImageUrl(managedImage)).toBe(
            `${managedImage.image_url.url}?preview=image`
        );
        const managedImageWithFragment = {
            ...managedImage,
            image_url: {
                url: `${managedImage.image_url.url}#thumbnail`,
            },
        } as const;
        expect(chatImageUrl(managedImageWithFragment)).toBe(
            `${managedImage.image_url.url}?preview=image#thumbnail`
        );
        expect(
            chatImageUrl({
                image_url: {
                    url: "/api/settings",
                },
                mimeType: "image/png",
                type: "image_url",
            })
        ).toBeUndefined();
        const managedSvgImage = {
            ...managedImage,
            image_url: {
                url: "/api/chat/media/outgoing/agent%3Amain%3Amain/123e4567-e89b-42d3-a456-426614174001/full",
            },
            mimeType: "image/svg+xml; charset=utf-8",
        } as const;
        expect(chatImageUrl(managedSvgImage)).toBe(
            `${managedSvgImage.image_url.url}?preview=image`
        );
        expect(
            chatImageUrl({
                image_url: {
                    url: "/api/media?path=%2Ftmp%2Furl-only-logo.svg",
                },
                type: "image_url",
            })
        ).toBe("/api/media?path=%2Ftmp%2Furl-only-logo.svg&preview=image");
        const onePixelPng =
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl4sAAAAASUVORK5CYII=";
        expect(
            chatImageUrl({
                data: onePixelPng,
                mimeType: "image/png",
                type: "image",
            })
        ).toBe(`data:image/png;base64,${onePixelPng}`);
        const oversizedPngHeader = new Uint8Array(24);
        oversizedPngHeader.set([137, 80, 78, 71], 0);
        oversizedPngHeader.set([0, 0, 78, 32], 16);
        oversizedPngHeader.set([0, 0, 0, 1], 20);
        const oversizedPngData = btoa(String.fromCodePoint(...oversizedPngHeader));
        expect(
            chatImageUrl({
                data: oversizedPngData,
                mimeType: "image/png",
                type: "image",
            })
        ).toBeUndefined();
        expect(extractImages([managedImage])).toEqual([managedImage]);
        expect(normalizeText([managedImage])).toBe("[image]");
        expect(attachmentKind("image/png")).toBe("image");
        expect(attachmentKind("application/json")).toBe("text");
        expect(attachmentKind("application/json; charset=utf-8")).toBe("text");
        expect(attachmentKind("IMAGE/SVG+XML; charset=utf-8")).toBe("image");
        expect(attachmentKind("application/pdf")).toBe("file");
        const sendAttachment = {
            id: "att-1",
            file: new File(["hello"], "hello.txt", {
                type: "text/plain",
            }),
            fileName: "hello.txt",
            mimeType: "text/plain",
            sizeBytes: 5,
            contentBase64: "aGVsbG8=",
            kind: "text" as const,
        };
        expect(chatTransportAttachments([sendAttachment])).toEqual([
            {
                type: "text",
                mimeType: "text/plain",
                fileName: "hello.txt",
                content: "aGVsbG8=",
            },
        ]);
        expect(optimisticAttachmentDisplay([sendAttachment])[0]).toMatchObject({
            id: "att-1",
            fileName: "hello.txt",
            kind: "text",
        });
        const normalized = normalizeOpenClawHistoryMessage({
            role: "assistant",
            content: `Here\nMEDIA:images/result.png\n<file name="note.txt" mime="text/plain">hello</file>`,
            timestamp: 1_782_172_800_000,
        });
        expect(normalized.text).toBe("Here");
        expect(normalized.timestamp).toBe("2026-06-23T00:00:00.000Z");
        expect(normalized.attachments?.map((attachment) => attachment.fileName)).toEqual([
            "result.png",
            "note.txt",
        ]);
        expect(
            normalizeOpenClawHistoryMessage({
                content: "still working",
                role: "assistant",
                stopReason: "toolUse",
            }).isFinal
        ).toBeUndefined();
        expect(
            normalizeOpenClawHistoryMessage({
                content: "done",
                role: "assistant",
                stopReason: "stop",
            }).isFinal
        ).toBe(true);
        const normalizedMediaReferences = normalizeOpenClawHistoryMessage({
            MediaPaths: ["/tmp/data.csv", "/tmp/readme.md", "/tmp/logo.svg"],
            content: "",
            role: "user",
        });
        expect(normalizedMediaReferences.attachments).toMatchObject([
            {
                fileName: "data.csv",
                kind: "text",
                mimeType: "text/csv",
                url: "/api/media?path=%2Ftmp%2Fdata.csv",
            },
            {
                fileName: "readme.md",
                kind: "text",
                mimeType: "text/markdown",
            },
            {
                dataUrl: "/api/media?path=%2Ftmp%2Flogo.svg&preview=image",
                fileName: "logo.svg",
                kind: "image",
                mimeType: "image/svg+xml",
            },
        ]);
        const normalizedManagedAttachment = normalizeOpenClawHistoryMessage({
            content: [
                {
                    attachment: {
                        label: "report.csv",
                        mimeType: "text/csv",
                        url: "/api/chat/media/outgoing/agent%3Amain%3Amain/123e4567-e89b-42d3-a456-426614174000/full",
                    },
                    type: "attachment",
                },
            ],
            role: "assistant",
        });
        expect(normalizedManagedAttachment.attachments?.[0]).toMatchObject({
            fileName: "report.csv",
            kind: "text",
            url: "/api/chat/media/outgoing/agent%3Amain%3Amain/123e4567-e89b-42d3-a456-426614174000/full",
        });
        const normalizedSignedAttachment = normalizeOpenClawHistoryMessage({
            content: [
                {
                    attachment: {
                        url: "https://files.example.test/report.csv?token=signed-value",
                    },
                    type: "attachment",
                },
            ],
            role: "assistant",
        });
        expect(normalizedSignedAttachment.attachments?.[0]).toMatchObject({
            fileName: "report.csv",
            kind: "text",
            mimeType: "text/csv",
            url: "https://files.example.test/report.csv?token=signed-value",
        });
        const normalizedFriendlyLabelAttachment = normalizeOpenClawHistoryMessage({
            content: [
                {
                    attachment: {
                        label: "Sales report",
                        url: "https://files.example.test/report.csv?token=signed-value",
                    },
                    type: "attachment",
                },
            ],
            role: "assistant",
        });
        expect(normalizedFriendlyLabelAttachment.attachments?.[0]).toMatchObject({
            fileName: "Sales report",
            kind: "text",
            mimeType: "text/csv",
            url: "https://files.example.test/report.csv?token=signed-value",
        });
        const normalizedLocalProxyAttachment = normalizeOpenClawHistoryMessage({
            content: [
                {
                    attachment: {
                        url: "/api/media?path=%2Ftmp%2Fproxy-report.csv",
                    },
                    type: "attachment",
                },
            ],
            role: "assistant",
        });
        expect(normalizedLocalProxyAttachment.attachments?.[0]).toMatchObject({
            fileName: "proxy-report.csv",
            kind: "text",
            mimeType: "text/csv",
            url: "/api/media?path=%2Ftmp%2Fproxy-report.csv",
        });
        const previousLocation = location.href;
        try {
            location.assign("https://dashboard.test/");
            const absoluteLocalProxyUrl =
                "https://dashboard.test/api/media?path=%2Ftmp%2Fabsolute-report.csv";
            const normalizedAbsoluteLocalProxyAttachment =
                normalizeOpenClawHistoryMessage({
                    content: [
                        {
                            attachment: {
                                url: absoluteLocalProxyUrl,
                            },
                            type: "attachment",
                        },
                    ],
                    role: "assistant",
                });
            expect(normalizedAbsoluteLocalProxyAttachment.attachments?.[0]).toMatchObject(
                {
                    fileName: "absolute-report.csv",
                    kind: "text",
                    mimeType: "text/csv",
                    url: "/api/media?path=%2Ftmp%2Fabsolute-report.csv",
                }
            );
        } finally {
            location.assign(previousLocation);
        }
        const normalizedManagedSvgAttachment = normalizeOpenClawHistoryMessage({
            content: [
                {
                    attachment: {
                        label: "logo.svg",
                        mimeType: "image/svg+xml; charset=utf-8",
                        url: "/api/chat/media/outgoing/agent%3Amain%3Amain/123e4567-e89b-42d3-a456-426614174002/full",
                    },
                    type: "attachment",
                },
            ],
            role: "assistant",
        });
        expect(normalizedManagedSvgAttachment.attachments?.[0]).toMatchObject({
            dataUrl:
                "/api/chat/media/outgoing/agent%3Amain%3Amain/123e4567-e89b-42d3-a456-426614174002/full?preview=image",
            fileName: "logo.svg",
            kind: "image",
            url: "/api/chat/media/outgoing/agent%3Amain%3Amain/123e4567-e89b-42d3-a456-426614174002/full",
        });
        expect(formatDatabaseNumber(123_456)).toBe("123,456");
        expect(formatDatabaseNumber(Number.NaN)).toBe("0");
        expect(formatDatabaseBytes(0)).toBe("0 B");
        expect(formatDatabaseBytes(1536)).toBe("1.5 KB");
        expect(truncateQuery("short", 12)).toBe("short");
        expect(truncateQuery("select " + "x".repeat(20), 12)).toBe("select xxxxx...");
        expect(
            postgresMaintenanceAttention({
                status: "not_assessed",
                hintCount: 4,
                requiresBloatReview: false,
                isBloatAssessmentIncomplete: true,
                unassessedTableCount: 2,
                unassessedPhysicalBytes: 2_147_483_648,
                slowQueryCount: 2,
                highDeadTupleTableCount: 2,
                physicalTableBytes: 0,
                estimatedReclaimableBytes: 0,
                estimatedReclaimablePercent: 0,
                reviewThresholdBytes: 5_368_709_120,
                reviewMinimumBytes: 1_073_741_824,
                reviewThresholdPercent: 25,
            })
        ).toEqual([
            "2 large tables exceed the dead-tuple threshold. Review autovacuum",
            "2 queries average at least 500 ms. Review query performance",
            "Bloat could not be assessed for 2.0 GB across 2 tables",
        ]);
        expect(formatDockerBytes(0)).toBe("0 B");
        expect(formatDockerBytes(1024 ** 2)).toBe("1.0 MB");
        expect(formatDockerMemory()).toBe("—");
        expect(formatDockerMemory("512MiB / 1GiB")).toBe("512 MB / 1.0 GB");
        expect(formatDockerMemory("bad")).toBe("bad");
        expect(formatTimestamp("not-a-date")).toBe("not-a-date");
        expect(formatTimestamp()).toBe("—");
        expect(formatVersionDisplay(undefined, "sha256:abcdef1234567890")).toBe(
            "sha256:abcde"
        );
        expect(formatVersionDisplay()).toBe("—");
        expect(formatFullVersionDisplay("v1", "digest")).toBe("v1 (digest)");
        expect(formatFullVersionDisplay()).toBe("—");
        expect(
            formatUpdaterTransition({
                fromTag: "old",
                toTag: undefined,
                fromDigest: undefined,
                toDigest: "sha256:newdigest",
            })
        ).toBe("old → sha256:newdi");
        const osloParts = appTimeZoneParts(new Date("2026-06-23T12:34:56.000Z"));
        expect(osloParts.year).toBe(2026);
        expect(appTimeZoneShortWeekday(new Date("2026-06-23T12:00:00.000Z"))).toBe("Tue");
        expect(appTimeZoneShortMonth(new Date("2026-06-23T12:00:00.000Z"))).toBe("Jun");
        expect(
            appZonedUtcDate(new Date("2026-06-23T12:34:56.789Z")).getUTCFullYear()
        ).toBe(2026);
        expect(currentIsoString()).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
        expect(() => isoStringFromDate("bad")).toThrow(RangeError);
        expect(timestampFromDateString("bad")).toBeUndefined();
        expect(currentYear()).toBeGreaterThanOrEqual(2026);
        expect(APP_TIME_ZONE).toBe("Europe/Oslo");
    });
});
