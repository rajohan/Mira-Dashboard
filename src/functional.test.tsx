import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, renderHook, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, jest } from "bun:test";
import { createElement, type ReactNode } from "react";

import type { ChatHistoryMessage } from "./components/features/chat/chatTypes";
import {
    chatErrorMessage,
    dataUrlToBase64,
    dedupeMessages,
    displayMimeType,
    isRecoveredAssistantText,
    mergeWithRecentOptimisticMessages,
    messageDeleteKey,
    messageIdentity,
} from "./components/features/chat/chatUtilities";
import {
    buildSlashCommandSuggestions,
    slashCommandCanonicalName,
} from "./components/features/chat/slashCommands";
import { NotificationBell } from "./components/layout/NotificationBell";
import { apiFetch, UnauthorizedError } from "./hooks/useApi";
import { useKopiaBackup, useRunKopiaBackup, useWalgBackup } from "./hooks/useBackups";
import { useFileContent, useFiles, useSaveFile } from "./hooks/useFiles";
import { useLogContent, useLogFiles } from "./hooks/useLogs";
import type { NotificationItem } from "./hooks/useNotifications";
import {
    useProductionCheckout,
    usePullRequestDeployments,
    usePullRequests,
} from "./hooks/usePullRequests";
import {
    useRunScheduledJobNow,
    useScheduledJobRuns,
    useScheduledJobs,
    useUpdateScheduledJob,
} from "./hooks/useScheduledJobs";
import { handleSocketMessage } from "./lib/socket/socketMessageRouter";
import { Tasks } from "./pages/Tasks";
import { authActions, authStore } from "./stores/authStore";
import type { Task } from "./types/task";
import {
    formatCronLastStatus,
    formatCronTimestamp,
    getCronJobId,
    getCronJobName,
    getCronStateValue,
    getCronStatusVariant,
    isCronExpressionValid,
    sortCronJobs,
} from "./utils/cronUtilities";
import {
    getFileExtension,
    getLanguage,
    getSyntaxClass,
    isBinaryFile,
    isCodeFile,
    isImageFile,
    isJsonFile,
    isMarkdownFile,
} from "./utils/fileUtilities";
import {
    appTimeOfDayToUtcTimeOfDay,
    formatSize,
    formatTokenCount,
    formatTokens,
    formatUptime,
    formatUtcTimeOfDayInAppTimeZone,
    getTokenPercent,
} from "./utils/format";
import {
    formatLogTime,
    getLevelColor,
    getSubsystemColor,
    parseLogLine,
} from "./utils/logUtilities";
import {
    formatSessionType,
    getTypeSortOrder,
    sortSessionsByTypeAndActivity,
} from "./utils/sessionUtilities";
import { getColumnId, getPriority, isTaskMatchSearch } from "./utils/taskUtilities";

function task(overrides: Partial<Task> & Pick<Task, "number" | "title">): Task {
    return {
        number: overrides.number,
        title: overrides.title,
        body: overrides.body ?? "",
        state: overrides.state ?? "OPEN",
        labels: overrides.labels ?? [],
        assignees: overrides.assignees ?? [{ login: "mira-2026", name: "Mira" }],
        createdAt: overrides.createdAt ?? "2026-06-19T08:00:00.000Z",
        updatedAt: overrides.updatedAt ?? "2026-06-19T08:00:00.000Z",
        url: overrides.url ?? `/tasks/${overrides.number}`,
        automation: overrides.automation,
    };
}

function createApi(tasks: Task[]) {
    return jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";

        if (url === "/api/tasks" && method === "GET") {
            return Response.json(tasks);
        }

        if (url === "/api/tasks" && method === "POST") {
            const payload = JSON.parse(String(init?.body ?? "{}")) as {
                title: string;
                body: string;
                labels: string[];
                assignee: string;
            };
            const created = task({
                number: tasks.length + 1,
                title: payload.title,
                body: payload.body,
                labels: payload.labels.map((name) => ({ name })),
                assignees: [{ login: payload.assignee, name: payload.assignee }],
                updatedAt: "2026-06-19T09:00:00.000Z",
            });
            tasks.unshift(created);
            return Response.json(created, { status: 201 });
        }

        throw new Error(`Unexpected frontend API call: ${method} ${url}`);
    });
}

function notification(
    overrides: Partial<NotificationItem> & Pick<NotificationItem, "id" | "title">
): NotificationItem {
    return {
        id: overrides.id,
        title: overrides.title,
        description: overrides.description ?? "",
        type: overrides.type ?? "info",
        source: overrides.source,
        dedupeKey: overrides.dedupeKey,
        metadata: overrides.metadata ?? {},
        isRead: overrides.isRead ?? false,
        createdAt: overrides.createdAt ?? "2026-06-23T08:00:00.000Z",
        updatedAt: overrides.updatedAt ?? "2026-06-23T08:00:00.000Z",
        occurredAt: overrides.occurredAt ?? "2026-06-23T08:00:00.000Z",
    };
}

function createNotificationsApi(notifications: NotificationItem[]) {
    return jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";

        if (url === "/api/notifications" && method === "GET") {
            return Response.json({
                items: notifications,
                readCount: notifications.filter((item) => item.isRead).length,
                unreadCount: notifications.filter((item) => !item.isRead).length,
            });
        }

        const markReadMatch = /^\/api\/notifications\/(\d+)\/read$/u.exec(url);
        if (markReadMatch && method === "POST") {
            const id = Number(markReadMatch[1]);
            notifications.splice(
                0,
                notifications.length,
                ...notifications.map((item) =>
                    item.id === id ? { ...item, isRead: true } : item
                )
            );
            return Response.json({ isOk: true });
        }

        if (url === "/api/notifications/mark-all-read" && method === "POST") {
            notifications.splice(
                0,
                notifications.length,
                ...notifications.map((item) => ({ ...item, isRead: true }))
            );
            return Response.json({ isOk: true });
        }

        if (url === "/api/notifications/clear-read" && method === "POST") {
            const before = notifications.length;
            notifications.splice(
                0,
                notifications.length,
                ...notifications.filter((item) => !item.isRead)
            );
            return Response.json({ deleted: before - notifications.length, isOk: true });
        }

        const deleteMatch = /^\/api\/notifications\/(\d+)$/u.exec(url);
        if (deleteMatch && method === "DELETE") {
            const id = Number(deleteMatch[1]);
            const before = notifications.length;
            notifications.splice(
                0,
                notifications.length,
                ...notifications.filter((item) => item.id !== id)
            );
            return Response.json({ deleted: before - notifications.length, isOk: true });
        }

        throw new Error(`Unexpected notification API call: ${method} ${url}`);
    });
}

function getButtonByText(text: string, index = 0): HTMLButtonElement {
    const button = screen.getAllByText(text)[index]?.closest("button");
    if (!(button instanceof HTMLButtonElement)) {
        throw new TypeError(`Button not found for text: ${text}`);
    }
    return button;
}

function renderWithQueryClient(children: ReactNode) {
    const queryClient = new QueryClient({
        defaultOptions: {
            queries: { retry: false },
            mutations: { retry: false },
        },
    });

    const view = render(
        createElement(QueryClientProvider, { client: queryClient }, children)
    );

    return {
        ...view,
        queryClient,
    };
}

function renderHookWithQueryClient<Result>(callback: () => Result) {
    const queryClient = new QueryClient({
        defaultOptions: {
            queries: { retry: false },
            mutations: { retry: false },
        },
    });
    const wrapper = ({ children }: { children: ReactNode }) =>
        createElement(QueryClientProvider, { client: queryClient }, children);

    return {
        ...renderHook(callback, { wrapper }),
        queryClient,
    };
}

function chatMessage(
    overrides: Partial<ChatHistoryMessage> & Pick<ChatHistoryMessage, "role">
): ChatHistoryMessage {
    return {
        role: overrides.role,
        content: overrides.content ?? overrides.text ?? "",
        text: overrides.text ?? "",
        images: overrides.images,
        attachments: overrides.attachments,
        thinking: overrides.thinking,
        toolCalls: overrides.toolCalls,
        toolResult: overrides.toolResult,
        timestamp: overrides.timestamp,
        local: overrides.local,
        runId: overrides.runId,
    };
}

describe("Mira Dashboard frontend behavior", () => {
    beforeEach(() => {
        authActions.clearSession();
    });

    afterEach(() => {
        authActions.clearSession();
    });

    it("handles API authorization failures through the shared auth boundary", async () => {
        authActions.setSession({
            authenticated: true,
            isBootstrapRequired: false,
            user: { id: 1, username: "raymond" },
        });
        const unauthorizedEvents: Event[] = [];
        addEventListener("openclaw:unauthorized", (event) => {
            unauthorizedEvents.push(event);
        });
        Object.defineProperty(globalThis, "fetch", {
            configurable: true,
            value: jest.fn(async () =>
                Response.json({ error: "Unauthorized" }, { status: 401 })
            ),
            writable: true,
        });

        await expect(apiFetch("/tasks")).rejects.toBeInstanceOf(UnauthorizedError);

        expect(authStore.state.isAuthenticated).toBe(false);
        expect(unauthorizedEvents).toHaveLength(1);
    });

    it("parses successful, empty, and failed API responses consistently", async () => {
        const fetchMock = jest.fn(
            async (input: RequestInfo | URL, init?: RequestInit) => {
                const url = String(input);
                const method = init?.method ?? "GET";

                if (url === "/api/health" && method === "GET") {
                    return Response.json({ status: "isOk" });
                }

                if (url === "/api/restart" && method === "POST") {
                    return new Response(undefined, { status: 204 });
                }

                if (url === "/api/tasks" && method === "POST") {
                    return Response.json({ error: "title is required" }, { status: 400 });
                }

                if (url === "/api/broken" && method === "GET") {
                    return new Response("not-json", { status: 500 });
                }

                throw new Error(`Unexpected API call: ${method} ${url}`);
            }
        );
        Object.defineProperty(globalThis, "fetch", {
            configurable: true,
            value: fetchMock,
            writable: true,
        });

        await expect(apiFetch("/health")).resolves.toEqual({ status: "isOk" });
        await expect(apiFetch("/restart", { method: "POST" })).resolves.toBeUndefined();
        await expect(
            apiFetch("/tasks", { body: JSON.stringify({}), method: "POST" })
        ).rejects.toThrow("title is required");
        await expect(apiFetch("/broken")).rejects.toThrow("Unknown error");
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/health",
            expect.objectContaining({
                credentials: "include",
                headers: expect.objectContaining({ "Content-Type": "application/json" }),
            })
        );
    });

    it("routes socket messages into dashboard connection state", () => {
        expect(handleSocketMessage({})).toBeUndefined();
        expect(handleSocketMessage({ type: "state", gatewayConnected: false })).toBe(
            false
        );
        expect(handleSocketMessage({ type: "state" })).toBe(true);
        expect(handleSocketMessage({ type: "connected" })).toBe(true);
        expect(handleSocketMessage({ type: "disconnected" })).toBe(false);
        expect(
            handleSocketMessage({
                payload: { data: { sessions: [{ id: "session-1", key: "session-1" }] } },
                type: "response",
            })
        ).toBeUndefined();
        expect(
            handleSocketMessage({
                event: "agents.list",
                payload: [{ id: "mira-2026", status: "online" }],
                type: "event",
            })
        ).toBeUndefined();
        expect(
            handleSocketMessage({
                line: "2026-06-23T10:00:00.000Z info dashboard ready",
                type: "log",
            })
        ).toBeUndefined();
    });

    it("fetches log, file, job, backup, and pull request APIs through dashboard hooks", async () => {
        const fetchMock = jest.fn(
            async (input: RequestInfo | URL, init?: RequestInit) => {
                const url = String(input);
                const method = init?.method ?? "GET";

                if (url === "/api/logs/info" && method === "GET") {
                    return Response.json({
                        logs: [
                            { name: "openclaw.log", size: 123 },
                            { name: " ".repeat(3), size: 1 },
                            { size: 2 },
                        ],
                    });
                }

                if (
                    url === "/api/logs/content?file=openclaw.log&lines=50" &&
                    method === "GET"
                ) {
                    return Response.json({ content: "info line\nerror line" });
                }

                if (url === "/api/files?path=src" && method === "GET") {
                    return Response.json({
                        files: [{ path: "src/main.tsx", name: "main.tsx", type: "file" }],
                    });
                }

                if (url === "/api/files/src%2Fmain.tsx" && method === "GET") {
                    return Response.json({
                        path: "src/main.tsx",
                        content: "render app",
                        isBinary: false,
                    });
                }

                if (url === "/api/config-files/openclaw.json" && method === "GET") {
                    return Response.json({
                        path: "config:openclaw.json",
                        content: "{}",
                        isBinary: false,
                    });
                }

                if (url === "/api/files/src%2Fmain.tsx" && method === "PUT") {
                    expect(JSON.parse(String(init?.body))).toEqual({
                        content: "updated",
                    });
                    return new Response(undefined, { status: 204 });
                }

                if (url === "/api/jobs" && method === "GET") {
                    return Response.json({
                        jobs: [
                            {
                                id: "job-1",
                                name: "Job One",
                                description: "Runs things",
                                enabled: true,
                                scheduleType: "interval",
                                intervalSeconds: 60,
                                actionKey: "test",
                                actionPayload: {},
                                createdAt: "2026-06-23T08:00:00.000Z",
                                updatedAt: "2026-06-23T08:00:00.000Z",
                                isRunning: false,
                            },
                        ],
                    });
                }

                if (url === "/api/jobs/job-1/runs" && method === "GET") {
                    return Response.json({
                        runs: [
                            {
                                id: 1,
                                jobId: "job-1",
                                status: "success",
                                triggerType: "manual",
                                startedAt: "2026-06-23T08:00:00.000Z",
                                output: { ok: true },
                            },
                        ],
                    });
                }

                if (url === "/api/jobs/job-1" && method === "PATCH") {
                    expect(JSON.parse(String(init?.body))).toEqual({
                        patch: { enabled: false },
                    });
                    return Response.json({ isOk: true, job: { id: "job-1" } });
                }

                if (url === "/api/jobs/job-1/run" && method === "POST") {
                    return Response.json({
                        isOk: true,
                        run: {
                            id: 2,
                            jobId: "job-1",
                            status: "success",
                            triggerType: "manual",
                            startedAt: "2026-06-23T08:00:00.000Z",
                            output: {},
                        },
                    });
                }

                if (url === "/api/backups/kopia" && method === "GET") {
                    return Response.json({
                        job: { id: "kopia-1", type: "kopia", status: "done" },
                    });
                }

                if (url === "/api/backups/walg" && method === "GET") {
                    return Response.json({});
                }

                if (url === "/api/backups/kopia/run" && method === "POST") {
                    return Response.json({
                        isOk: true,
                        job: { id: "kopia-2", type: "kopia", status: "running" },
                    });
                }

                if (url === "/api/pull-requests" && method === "GET") {
                    return Response.json({
                        pullRequests: [
                            {
                                number: 189,
                                title: "Functional tests",
                                url: "/pull/189",
                                headRefName: "tests",
                                baseRefName: "main",
                                author: { login: "mira-2026" },
                                createdAt: "2026-06-23T08:00:00.000Z",
                                updatedAt: "2026-06-23T08:00:00.000Z",
                                isDraft: false,
                            },
                        ],
                    });
                }

                if (url === "/api/pull-requests/deployments" && method === "GET") {
                    return Response.json({
                        deployments: [
                            {
                                id: "deploy-1",
                                status: "isOk",
                                startedAt: "2026-06-23T08:00:00.000Z",
                                updatedAt: "2026-06-23T08:01:00.000Z",
                            },
                        ],
                    });
                }

                if (
                    url === "/api/pull-requests/production-checkout" &&
                    method === "GET"
                ) {
                    return Response.json({
                        checkout: {
                            root: "/srv/app",
                            expectedRoot: "/srv/app",
                            worktreeRoot: "/srv/app",
                            branch: "main",
                            expectedBranch: "main",
                            head: "abc123",
                            isClean: true,
                            isProductionRoot: true,
                            isSafeForDeploy: true,
                        },
                    });
                }

                throw new Error(`Unexpected hook API call: ${method} ${url}`);
            }
        );
        Object.defineProperty(globalThis, "fetch", {
            configurable: true,
            value: fetchMock,
            writable: true,
        });

        const logFiles = renderHookWithQueryClient(() => useLogFiles());
        await waitFor(() => expect(logFiles.result.current.data).toHaveLength(1));
        expect(logFiles.result.current.data?.[0]?.name).toBe("openclaw.log");

        const logContent = renderHookWithQueryClient(() =>
            useLogContent("openclaw.log", 50)
        );
        await waitFor(() =>
            expect(logContent.result.current.data).toBe("info line\nerror line")
        );

        const files = renderHookWithQueryClient(() => useFiles("src"));
        await waitFor(() =>
            expect(files.result.current.data?.[0]?.path).toBe("src/main.tsx")
        );

        const fileContent = renderHookWithQueryClient(() =>
            useFileContent("src/main.tsx")
        );
        await waitFor(() =>
            expect(fileContent.result.current.data?.content).toBe("render app")
        );

        const configContent = renderHookWithQueryClient(() =>
            useFileContent("config:openclaw.json")
        );
        await waitFor(() =>
            expect(configContent.result.current.data?.content).toBe("{}")
        );

        const saveFile = renderHookWithQueryClient(() => useSaveFile());
        await saveFile.result.current.mutateAsync({
            path: "src/main.tsx",
            content: "updated",
        });

        const jobs = renderHookWithQueryClient(() => useScheduledJobs());
        await waitFor(() => expect(jobs.result.current.data?.[0]?.id).toBe("job-1"));

        const jobRuns = renderHookWithQueryClient(() => useScheduledJobRuns("job-1"));
        await waitFor(() =>
            expect(jobRuns.result.current.data?.[0]?.status).toBe("success")
        );

        const updateJob = renderHookWithQueryClient(() => useUpdateScheduledJob());
        await updateJob.result.current.mutateAsync({
            id: "job-1",
            patch: { enabled: false },
        });

        const runJob = renderHookWithQueryClient(() => useRunScheduledJobNow());
        await expect(runJob.result.current.mutateAsync({ id: "job-1" })).resolves.toEqual(
            expect.objectContaining({ isOk: true })
        );

        const kopia = renderHookWithQueryClient(() => useKopiaBackup());
        await waitFor(() => expect(kopia.result.current.data?.job?.id).toBe("kopia-1"));

        const walg = renderHookWithQueryClient(() => useWalgBackup());
        await waitFor(() => expect(walg.result.current.data?.job).toBeUndefined());

        const runKopia = renderHookWithQueryClient(() => useRunKopiaBackup());
        await expect(runKopia.result.current.mutateAsync()).resolves.toEqual(
            expect.objectContaining({ isOk: true })
        );

        const pullRequests = renderHookWithQueryClient(() => usePullRequests());
        await waitFor(() =>
            expect(pullRequests.result.current.data?.[0]?.number).toBe(189)
        );

        const deployments = renderHookWithQueryClient(() => usePullRequestDeployments());
        await waitFor(() =>
            expect(deployments.result.current.data?.[0]?.id).toBe("deploy-1")
        );

        const production = renderHookWithQueryClient(() => useProductionCheckout());
        await waitFor(() =>
            expect(production.result.current.data?.isSafeForDeploy).toBe(true)
        );
    });

    it("drives notification filtering and mutations through the bell menu", async () => {
        const notifications = [
            notification({
                id: 1,
                title: "Cache refresh failed",
                description: "Needs attention",
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
        ];
        const fetchMock = createNotificationsApi(notifications);
        Object.defineProperty(globalThis, "fetch", {
            configurable: true,
            value: fetchMock,
            writable: true,
        });
        const user = userEvent.setup();

        renderWithQueryClient(createElement(NotificationBell));

        await user.click(
            await screen.findByRole("button", {
                name: /open notifications, 1 unread/i,
            })
        );
        expect(await screen.findByText("Cache refresh failed")).toBeInTheDocument();
        expect(screen.getByText("Backup complete")).toBeInTheDocument();

        await user.click(screen.getByRole("menuitemradio", { name: "Unread" }));
        expect(screen.getByText("Cache refresh failed")).toBeInTheDocument();
        expect(screen.queryByText("Backup complete")).not.toBeInTheDocument();

        await user.click(getButtonByText("Mark read"));
        await waitFor(() =>
            expect(fetchMock).toHaveBeenCalledWith(
                "/api/notifications/1/read",
                expect.objectContaining({ method: "POST" })
            )
        );

        await user.click(screen.getByRole("menuitemradio", { name: "All" }));
        await waitFor(() =>
            expect(screen.getByText("Backup complete")).toBeInTheDocument()
        );

        await user.click(getButtonByText("Clear"));
        await waitFor(() =>
            expect(fetchMock).toHaveBeenCalledWith(
                "/api/notifications/1",
                expect.objectContaining({ method: "DELETE" })
            )
        );

        await user.click(getButtonByText("Clear read"));
        await waitFor(() =>
            expect(fetchMock).toHaveBeenCalledWith(
                "/api/notifications/clear-read",
                expect.objectContaining({ method: "POST" })
            )
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
        expect(parseLogLine("")).toBeUndefined();
        expect(formatLogTime("not-a-date")).toBe("--:--:--");
        expect(getLevelColor("error")).toContain("text-red");
        expect(getSubsystemColor("ws")).toContain("amber");

        expect(getFileExtension("README.MD")).toBe("md");
        expect(isMarkdownFile("notes.markdown")).toBe(true);
        expect(isJsonFile("config.json5")).toBe(true);
        expect(isCodeFile("main.tsx")).toBe(true);
        expect(isImageFile("avatar.webp")).toBe(true);
        expect(isBinaryFile("archive.zip")).toBe(true);
        expect(getLanguage("query.graphql")).toBe("graphql");
        expect(getSyntaxClass("config.yaml")).toBe("text-purple-400");

        expect(isCronExpressionValid("*/15 0-23 * * 1-5")).toBe(true);
        expect(isCronExpressionValid("60 * * * *")).toBe(false);
        const sortedCronJobs = sortCronJobs([
            { id: "b", name: "Beta", enabled: false },
            { jobId: "a", name: "Alpha", enabled: true },
        ] as never);
        expect(sortedCronJobs.map((job) => getCronJobName(job))).toEqual([
            "Alpha",
            "Beta",
        ]);
        expect(getCronJobId({ jobId: "job-id" } as never)).toBe("job-id");
        expect(
            getCronStateValue({ state: { lastStatus: "ok" } } as never, "lastStatus")
        ).toBe("ok");
        expect(formatCronTimestamp("bad")).toBe("—");
        expect(formatCronLastStatus(" success ")).toBe("SUCCESS");
        expect(getCronStatusVariant("failed")).toBe("error");

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
        expect(formatUptime(90_061)).toBe("1d 1h");
        expect(formatTokens(12_345, 200_000)).toBe("12.3k / 200k");
        expect(formatTokenCount(1_250_000)).toBe("1.25M");
        expect(getTokenPercent(60, 120)).toBe(50);
        expect(formatUtcTimeOfDayInAppTimeZone("bad")).toBe("--:--");
        expect(appTimeOfDayToUtcTimeOfDay("bad")).toBe("bad");
    });

    it("keeps chat utility behavior stable for slash commands, diagnostics, and optimistic messages", () => {
        expect(chatErrorMessage(new Error("  failed  "), "fallback")).toBe("failed");
        expect(chatErrorMessage("failed", "fallback")).toBe("fallback");
        expect(dataUrlToBase64("data:text/plain;base64,SGVsbG8=")).toBe("SGVsbG8=");
        expect(displayMimeType(new File(["hello"], "hello.txt"))).toBe(
            "application/octet-stream"
        );

        expect(slashCommandCanonicalName("/abort")).toBe("/stop");
        expect(
            buildSlashCommandSuggestions("/model gpt", [
                { id: "openai/gpt-5.5" },
                { label: "ollama/glm-5" },
            ])
        ).toContainEqual(
            expect.objectContaining({
                value: "/model openai/gpt-5.5",
                title: "openai/gpt-5.5",
            })
        );
        expect(buildSlashCommandSuggestions("hello", [])).toEqual([]);

        const toolResult = chatMessage({
            role: "tool",
            text: "",
            timestamp: "2026-06-23T08:00:00.000Z",
            toolResult: { id: "tool-1", name: "exec", content: "done" },
        });
        expect(messageIdentity(toolResult)).toContain("tool-result::tool-1::exec");
        expect(messageDeleteKey(toolResult)).toContain("tool-result::tool-1::exec");

        const duplicateMessages = dedupeMessages([
            chatMessage({ role: "assistant", text: "same" }),
            chatMessage({ role: "assistant", text: "same" }),
            chatMessage({ role: "user", text: "different" }),
        ]);
        expect(duplicateMessages.map((message) => message.text)).toEqual([
            "same",
            "different",
        ]);

        expect(
            isRecoveredAssistantText(
                "This is a sufficiently long assistant response",
                "sufficiently long assistant"
            )
        ).toBe(true);

        const previousMessages = [
            chatMessage({
                role: "user",
                text: "optimistic",
                local: true,
                timestamp: new Date().toISOString(),
            }),
        ];
        const nextMessages = [
            chatMessage({
                role: "assistant",
                text: "remote",
                timestamp: new Date(Date.now() + 1000).toISOString(),
            }),
            chatMessage({ role: "assistant", text: "no timestamp" }),
        ];
        expect(
            mergeWithRecentOptimisticMessages(previousMessages, nextMessages).map(
                (message) => message.text
            )
        ).toEqual(["optimistic", "remote", "no timestamp"]);
    });

    it("renders the task board from the API and creates a task through the real hooks", async () => {
        const tasks = [
            task({
                number: 1,
                title: "Ship Bun test reset",
                labels: [{ name: "priority-high" }, { name: "in-progress" }],
            }),
        ];
        const fetchMock = createApi(tasks);
        Object.defineProperty(globalThis, "fetch", {
            configurable: true,
            value: fetchMock,
            writable: true,
        });
        const user = userEvent.setup();

        renderWithQueryClient(createElement(Tasks));

        expect(await screen.findByText("Ship Bun test reset")).toBeInTheDocument();
        expect(screen.getByText("In Progress")).toBeInTheDocument();

        await user.click(screen.getByRole("button", { name: /new task/i }));
        await user.type(screen.getByLabelText("Title"), "Write useful tests");
        await user.type(
            screen.getByLabelText("Description (optional)"),
            "Cover behavior"
        );
        await user.click(
            within(screen.getByRole("dialog")).getByRole("button", { name: "Raymond" })
        );
        await user.click(screen.getByRole("button", { name: /^Create Task$/i }));

        await waitFor(() =>
            expect(fetchMock).toHaveBeenCalledWith(
                "/api/tasks",
                expect.objectContaining({ method: "POST" })
            )
        );
        expect(await screen.findByText("Write useful tests")).toBeInTheDocument();
    });

    it("keeps task classification and search aligned with dashboard behavior", () => {
        const unlabelled = task({ number: 2, title: "Default priority" });
        const lowPriority = task({
            number: 4,
            title: "Low priority task",
            labels: [{ name: "priority-low" }],
        });
        const blocked = task({
            number: 3,
            title: "Waiting on deploy",
            labels: [{ name: "blocked" }],
            automation: {
                type: "cron",
                recurring: true,
                cronJobId: "daily-check",
                scheduleSummary: "Every 1h",
            },
        });

        expect(getPriority(unlabelled.labels)).toBe("medium");
        expect(getPriority(lowPriority.labels)).toBe("low");
        expect(getColumnId(blocked)).toBe("blocked");
        expect(isTaskMatchSearch(blocked, "daily-check")).toBe(true);
        expect(isTaskMatchSearch(blocked, "#3")).toBe(true);
        expect(isTaskMatchSearch(blocked, "not-present")).toBe(false);
    });
});
