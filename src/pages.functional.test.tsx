import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, jest } from "bun:test";
import { createElement, type ReactNode } from "react";

import {
    createChatVisibility,
    createLocalSystemMessage,
    finalMessageFromPayload,
    hasRecoveredStreamHistory,
    isCommandMessagePayload,
    isRecord,
    isSameSessionKey,
    mergeStreamMessage,
    mergeStreamText,
    normalizeAssistantPayload,
    parseAgentSessionKey,
    shouldShowStreamRow,
    uniqueStrings,
    visibleHistoryMessages,
} from "./components/features/chat/chatRuntime";
import { OpenClawSocketProvider } from "./hooks/useOpenClawSocket";
import { Agents } from "./pages/Agents";
import {
    hasNewerAssistantMessageInHistory,
    nextHistoryBottomState,
    nextHistoryLoadSendError,
    readDeletedMessageKeys,
    scheduleBottomFollowWhenNeeded,
    sessionTimestampMs,
    writeDeletedMessageKeys,
} from "./pages/Chat";
import { Dashboard } from "./pages/Dashboard";
import { Database } from "./pages/Database";
import { Docker } from "./pages/Docker";
import { Files } from "./pages/Files";
import { Jobs } from "./pages/Jobs";
import { Logs } from "./pages/Logs";
import { Moltbook } from "./pages/Moltbook";
import { PullRequests } from "./pages/PullRequests";
import { Sessions } from "./pages/Sessions";
import {
    errorMessage,
    numberFromDuration,
    optionalFormValue,
    Settings,
} from "./pages/Settings";
import {
    isTerminalOutputAtBottom,
    scrollTerminalOutputToBottom,
    scrollTerminalOutputToBottomAndReport,
    Terminal,
} from "./pages/Terminal";
import { authActions } from "./stores/authStore";

type FakeWebSocketListener = (event?: { data?: string }) => void;

class FakeWebSocket {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;

    private readonly listeners = new Map<string, FakeWebSocketListener[]>();
    readonly sent: string[] = [];
    readyState = FakeWebSocket.CONNECTING;

    addEventListener(type: string, listener: FakeWebSocketListener) {
        this.listeners.set(type, [...(this.listeners.get(type) || []), listener]);
    }

    send(data: string) {
        this.sent.push(data);
    }

    close() {
        this.readyState = FakeWebSocket.CLOSED;
        const closeListeners = this.listeners.get("close") || [];
        for (const listener of closeListeners) {
            listener();
        }
    }
}

function apiResponse(url: string, method: string) {
    if (method !== "GET") {
        return Response.json({ isOk: true, jobId: "job-1" });
    }

    if (url === "/api/agents/status") {
        return Response.json({
            agents: [
                {
                    id: "mira-2026",
                    name: "Mira",
                    status: "active",
                    model: "codex",
                    currentTask: "Testing pages",
                    lastActivity: "2026-06-24T08:00:00.000Z",
                },
                { id: "ops", name: "Ops", status: "idle", model: "codex" },
                {
                    id: "researcher",
                    name: "Researcher",
                    status: "offline",
                    model: "codex",
                },
            ],
        });
    }

    if (url === "/api/agents/task-history?limit=8") {
        return Response.json({
            items: [
                {
                    id: 1,
                    agentId: "mira-2026",
                    task: "Testing pages",
                    startedAt: "2026-06-24T08:00:00.000Z",
                    endedAt: "2026-06-24T08:05:00.000Z",
                },
            ],
        });
    }

    if (url === "/api/metrics") {
        return Response.json({
            cpu: { count: 4, loadAvg: [0.1, 0.2, 0.3], loadPercent: 5 },
            memory: { total: 100, used: 40, free: 60, percent: 40 },
            disk: { total: 1000, used: 250, free: 750, percent: 25 },
            network: { downloadMbps: 1, uploadMbps: 2 },
            system: { uptime: 120, hostname: "dashboard-test", platform: "linux" },
            tokens: {
                total: 42,
                byModel: { codex: 42 },
                sessionsByModel: { codex: 1 },
                byAgent: [{ label: "Mira", model: "codex", tokens: 42, type: "MAIN" }],
            },
            timestamp: 1_719_216_000_000,
        });
    }

    if (url === "/api/cache/weather.spydeberg") {
        return Response.json({
            key: "weather.spydeberg",
            status: "fresh",
            source: "weather",
            consecutiveFailures: 0,
            data: {
                location: "Spydeberg",
                temperatureC: 20,
                feelsLikeC: 19,
                humidityPercent: 52,
                windKph: 8,
                description: "Clear",
                forecast: [
                    { date: "2026-06-24", temperatureMaxC: 22, description: "Clear" },
                    { date: "2026-06-25", temperatureMaxC: 19, description: "Rain" },
                ],
            },
            meta: {},
        });
    }

    if (url === "/api/cache/quotas.summary") {
        return Response.json({
            key: "quotas.summary",
            status: "fresh",
            source: "quota",
            consecutiveFailures: 0,
            data: {
                checkedAt: 1_719_216_000_000,
                openai: { fiveHourLeftPercent: 90, weeklyLeftPercent: 80 },
                openrouter: {
                    usage: 1,
                    usageMonthly: 1,
                    remaining: 9,
                    totalCredits: 10,
                    percentUsed: 10,
                },
                elevenlabs: { status: "ok", remainingCharacters: 1000 },
                synthetic: {
                    rollingFiveHourLimit: { percentUsed: 10 },
                    weeklyTokenLimit: { percentUsed: 20 },
                },
            },
            meta: {},
        });
    }

    if (url === "/api/cache/heartbeat") {
        return Response.json({
            generatedAt: "2026-06-24T08:00:00.000Z",
            count: 1,
            entries: [
                {
                    key: "weather.spydeberg",
                    source: "weather",
                    status: "fresh",
                    updatedAt: "2026-06-24T08:00:00.000Z",
                    consecutiveFailures: 0,
                    data: {},
                    meta: {},
                },
            ],
        });
    }

    if (url === "/api/cache/git.workspace") {
        return Response.json({
            key: "git.workspace",
            status: "fresh",
            source: "git",
            consecutiveFailures: 0,
            data: {
                repos: [
                    {
                        key: "dashboard",
                        name: "Mira Dashboard",
                        branch: "test/broaden-fullstack-coverage",
                        remote: "origin",
                        dirty: true,
                        statusSummary: {
                            staged: 0,
                            modified: 1,
                            deleted: 0,
                            untracked: 0,
                            renamed: 0,
                            conflicted: 0,
                            total: 1,
                        },
                    },
                    {
                        key: "workspace",
                        name: "Workspace",
                        branch: "main",
                        remote: "origin",
                        dirty: false,
                        statusSummary: {
                            staged: 0,
                            modified: 0,
                            deleted: 0,
                            untracked: 0,
                            renamed: 0,
                            conflicted: 0,
                            total: 0,
                        },
                    },
                ],
                dirtyRepos: ["dashboard"],
                dirtyCount: 1,
                missingRepos: [],
                checkedAt: "2026-06-24T08:00:00.000Z",
            },
            meta: {},
        });
    }

    if (url === "/api/backups/kopia" || url === "/api/backups/walg") {
        return Response.json({
            job: {
                id: `${url.split("/").at(-1)}-job`,
                type: url.split("/").at(-1),
                status: "done",
                startedAt: "2026-06-24T08:00:00.000Z",
                endedAt: "2026-06-24T08:01:00.000Z",
            },
        });
    }

    if (url === "/api/cron/jobs") {
        return Response.json({
            jobs: [
                {
                    name: "heartbeat",
                    command: "openclaw heartbeat",
                    schedule: "*/30 * * * *",
                    enabled: true,
                    lastRun: "2026-06-24T08:00:00.000Z",
                    lastStatus: "success",
                },
            ],
        });
    }

    if (url === "/api/ops/log-rotation/status") {
        return Response.json({
            status: "ok",
            checkedAt: "2026-06-24T08:00:00.000Z",
            policies: [],
            runs: [],
        });
    }

    if (url === "/api/database/overview") {
        return Response.json({
            overview: {
                totalDatabaseSizeBytes: 1024,
                totalBackends: 2,
                averageCacheHitRatio: 99,
                connections: { n8n: 2 },
                pgStatStatementsEnabled: true,
                torrentCounts: { comet: 1, bitmagnet: 1 },
                pgbouncer: {
                    clientConnections: 1,
                    serverConnections: 1,
                    waitingClients: 0,
                    maxWait: 0,
                    avgQueryTime: 1,
                    avgTransactionTime: 1,
                },
            },
            databases: [
                {
                    datname: "n8n",
                    size_pretty: "1 MB",
                    size_bytes: "1024",
                    numbackends: "2",
                    xact_commit: "10",
                    xact_rollback: "0",
                    blks_hit: "100",
                    blks_read: "1",
                    cache_hit_ratio: "99",
                },
            ],
            deadTuples: [],
            topQueries: [
                {
                    query: "select 1",
                    calls: "1",
                    total_exec_time: "1",
                    mean_exec_time: "1",
                    rows: "1",
                    shared_blks_hit: "1",
                    shared_blks_read: "0",
                },
            ],
            pgbouncerPools: [],
            pgbouncerStats: [],
        });
    }

    if (url === "/api/docker/containers") {
        return Response.json({
            containers: [
                {
                    id: "abc123",
                    name: "dashboard",
                    image: "mira-dashboard:latest",
                    state: "running",
                    status: "Up",
                    created: "2026-06-24T08:00:00.000Z",
                    ports: [],
                    mounts: [],
                    networks: ["mira"],
                    labels: {},
                    restartCount: 0,
                },
            ],
        });
    }

    if (url === "/api/docker/images") {
        return Response.json({
            images: [
                {
                    id: "img1",
                    repository: "mira-dashboard",
                    tag: "latest",
                    size: 1,
                    created: "2026-06-24T08:00:00.000Z",
                    inUseBy: ["dashboard"],
                },
            ],
        });
    }

    if (url === "/api/docker/volumes") {
        return Response.json({
            volumes: [
                {
                    name: "dashboard-data",
                    driver: "local",
                    mountpoint: "/var/lib/docker/volumes/dashboard-data",
                    labels: {},
                    scope: "local",
                    size: 1024,
                    usedBy: ["dashboard"],
                },
            ],
        });
    }

    if (url === "/api/docker/updater/services") {
        return Response.json({
            services: [
                {
                    id: 1,
                    serviceName: "dashboard",
                    composeProject: "mira",
                    image: "mira-dashboard:latest",
                    currentVersion: "1.0.0",
                    latestVersion: "1.0.1",
                    status: "update_available",
                },
            ],
        });
    }

    if (url === "/api/docker/updater/events?limit=25") {
        return Response.json({ events: [] });
    }

    if (url === "/api/files") {
        return Response.json({
            files: [
                { name: "src", path: "src", type: "directory", children: [] },
                { name: "README.md", path: "README.md", type: "file", size: 100 },
            ],
        });
    }

    if (url === "/api/files/README.md") {
        return Response.json({
            path: "README.md",
            content: "# Dashboard",
            isBinary: false,
        });
    }

    if (url === "/api/jobs") {
        return Response.json({
            jobs: [
                {
                    id: "heartbeat",
                    name: "Heartbeat",
                    enabled: true,
                    scheduleType: "interval",
                    intervalSeconds: 1800,
                    actionKey: "heartbeat",
                    actionPayload: {},
                    createdAt: "2026-06-24T08:00:00.000Z",
                    updatedAt: "2026-06-24T08:00:00.000Z",
                    isRunning: false,
                },
            ],
        });
    }

    if (url === "/api/jobs/heartbeat/runs") {
        return Response.json({
            runs: [
                { id: 1, jobId: "heartbeat", status: "success", triggerType: "manual" },
            ],
        });
    }

    if (url === "/api/logs/info") {
        return Response.json({ logs: [{ name: "openclaw.log", size: 100 }] });
    }

    if (url === "/api/logs/content?file=openclaw.log&lines=200") {
        return Response.json({
            content: "2026-06-24T08:00:00.000Z info dashboard ready",
        });
    }

    if (url === "/api/cache/moltbook.home") {
        return Response.json({
            key: "moltbook.home",
            status: "fresh",
            source: "moltbook",
            consecutiveFailures: 0,
            data: {
                pendingRequestCount: 1,
                unreadMessageCount: 2,
                activityOnYourPosts: [],
                nextActions: ["reply"],
            },
            meta: {},
        });
    }

    if (
        url === "/api/cache/moltbook.feed.hot" ||
        url === "/api/cache/moltbook.feed.new"
    ) {
        return Response.json({
            key: "moltbook.feed.hot",
            status: "fresh",
            source: "moltbook",
            consecutiveFailures: 0,
            data: {
                posts: [
                    {
                        post_id: "post-1",
                        title: "Dashboard testing",
                        content_preview: "Coverage",
                        author_name: "mira",
                        created_at: "2026-06-24T08:00:00.000Z",
                        submolt_name: "agents",
                        upvotes: 3,
                        downvotes: 0,
                        comment_count: 1,
                    },
                ],
            },
            meta: {},
        });
    }

    if (url === "/api/cache/moltbook.profile") {
        return Response.json({
            key: "moltbook.profile",
            status: "fresh",
            source: "moltbook",
            consecutiveFailures: 0,
            data: { profile: { username: "mira", display_name: "Mira" } },
            meta: {},
        });
    }

    if (url === "/api/cache/moltbook.my-content") {
        return Response.json({
            key: "moltbook.my-content",
            status: "fresh",
            source: "moltbook",
            consecutiveFailures: 0,
            data: { posts: [], comments: [] },
            meta: {},
        });
    }

    if (url === "/api/pull-requests") {
        return Response.json({
            pullRequests: [
                {
                    number: 190,
                    title: "Expand backend coverage",
                    url: "https://github.com/rajohan/Mira-Dashboard/pull/190",
                    headRefName: "test/backend",
                    baseRefName: "main",
                    author: { login: "mira-2026" },
                    createdAt: "2026-06-24T08:00:00.000Z",
                    updatedAt: "2026-06-24T08:05:00.000Z",
                    isDraft: false,
                    reviewDecision: "APPROVED",
                    mergeStateStatus: "CLEAN",
                },
            ],
        });
    }

    if (url === "/api/pull-requests/deployments") {
        return Response.json({ deployments: [] });
    }

    if (url === "/api/pull-requests/production-checkout") {
        return Response.json({
            checkout: {
                root: "/home/ubuntu/projects/mira-dashboard",
                expectedRoot: "/home/ubuntu/projects/mira-dashboard",
                worktreeRoot: "/home/ubuntu/projects/mira-dashboard",
                branch: "main",
                expectedBranch: "main",
                head: "abc123",
                isClean: true,
                isProductionRoot: true,
                isSafeForDeploy: true,
            },
        });
    }

    if (url === "/api/config") {
        return Response.json({
            agents: { list: [{ id: "ops", heartbeat: { every: "30m" } }] },
            session: { reset: { idleMinutes: 60 } },
            models: {},
            tools: {},
        });
    }

    if (url === "/api/skills") {
        return Response.json({
            skills: [{ name: "task-tracking", description: "Tasks", enabled: true }],
        });
    }

    if (url === "/api/cache/system.host") {
        return Response.json({
            key: "system.host",
            status: "fresh",
            source: "system",
            consecutiveFailures: 0,
            data: { version: { current: "2026.6.9", latest: "2026.6.9" } },
            meta: {},
        });
    }

    if (url === "/api/exec/job-1") {
        return Response.json({
            job: { id: "job-1", status: "done", stdout: "ok", stderr: "", code: 0 },
        });
    }

    throw new Error(`Unexpected page API call: ${method} ${url}`);
}

function renderPage(children: ReactNode, options: { withSocket?: boolean } = {}) {
    const queryClient = new QueryClient({
        defaultOptions: {
            queries: { retry: false, staleTime: Infinity },
            mutations: { retry: false },
        },
    });
    const content = options.withSocket
        ? createElement(OpenClawSocketProvider, undefined, children)
        : children;

    return {
        ...render(createElement(QueryClientProvider, { client: queryClient }, content)),
        queryClient,
    };
}

describe("Mira Dashboard pages", () => {
    beforeEach(() => {
        authActions.clearSession();
        Object.defineProperties(globalThis, {
            fetch: {
                configurable: true,
                value: jest.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
                    apiResponse(String(input), init?.method ?? "GET")
                ),
                writable: true,
            },
            WebSocket: {
                configurable: true,
                value: FakeWebSocket,
                writable: true,
            },
        });
    });

    afterEach(() => {
        authActions.clearSession();
        localStorage.clear();
    });

    it("renders the main data pages from their API contracts", async () => {
        const pages: Array<[ReactNode, string, { withSocket?: boolean }?]> = [
            [createElement(Agents), "Active (1)"],
            [createElement(Dashboard), "Spydeberg", { withSocket: true }],
            [createElement(Database), "n8n"],
            [createElement(Docker), "dashboard"],
            [createElement(Files), "README.md"],
            [createElement(Jobs), "Heartbeat"],
            [createElement(Logs), "openclaw.log", { withSocket: true }],
            [createElement(Moltbook), "Dashboard testing"],
            [createElement(PullRequests), "Expand backend coverage"],
            [createElement(Settings), "Model Configuration"],
            [createElement(Terminal), "~"],
        ];

        for (const [page, expectedText, options] of pages) {
            const view = renderPage(page, options);
            await waitFor(() => {
                expect(screen.queryAllByText(expectedText).length).toBeGreaterThan(0);
            });
            view.unmount();
            view.queryClient.clear();
        }
    });

    it("renders sessions page connection state with a socket provider", async () => {
        renderPage(createElement(Sessions), { withSocket: true });

        await waitFor(() => {
            expect(screen.getByText("Connecting to OpenClaw...")).toBeInTheDocument();
        });
    });

    it("keeps chat page storage and history helpers deterministic", () => {
        expect(readDeletedMessageKeys("agent:main:main")).toEqual(new Set());

        writeDeletedMessageKeys("agent:main:main", new Set(["message-1"]));
        expect(readDeletedMessageKeys("agent:main:main")).toEqual(new Set(["message-1"]));
        localStorage.setItem("openclaw:deleted:agent:main:main", "{bad json");
        expect(readDeletedMessageKeys("agent:main:main")).toEqual(new Set());

        expect(sessionTimestampMs("2026-06-24T08:00:00.000Z")).toBeGreaterThan(0);
        expect(sessionTimestampMs(NaN)).toBeUndefined();
        expect(
            hasNewerAssistantMessageInHistory(
                [
                    {
                        role: "assistant",
                        text: "done",
                        content: "done",
                        timestamp: "2026-06-24T08:01:00.000Z",
                    },
                ],
                "2026-06-24T08:00:00.000Z"
            )
        ).toBe(true);
        expect(nextHistoryBottomState(false, true, false)).toBe(true);
        expect(nextHistoryBottomState(false, false, false)).toBe(false);
        expect(nextHistoryLoadSendError("old", true, "new")).toBe("old");
        expect(nextHistoryLoadSendError(undefined, false, "new")).toBe("new");

        const scheduled: string[] = [];
        scheduleBottomFollowWhenNeeded(true, () => {
            scheduled.push("bottom");
        });
        scheduleBottomFollowWhenNeeded(false, () => {
            scheduled.push("skipped");
        });
        expect(scheduled).toEqual(["bottom"]);
    });

    it("keeps chat runtime stream helpers aligned with page behavior", () => {
        expect(mergeStreamText("", "hello")).toBe("hello");
        expect(mergeStreamText("hello", "hello world")).toBe("hello world");
        expect(mergeStreamText("hello", "lo")).toBe("hello");
        expect(mergeStreamText("hello", " world")).toBe("hello world");
        expect(mergeStreamText("hello", " ".repeat(3))).toBe("hello");

        expect(uniqueStrings(["a", undefined, "a", "b"])).toEqual(["a", "b"]);
        expect(parseAgentSessionKey("agent:Main:Session")).toEqual({
            agentId: "main",
            rest: "session",
        });
        expect(parseAgentSessionKey("session-only")).toBeUndefined();
        expect(isSameSessionKey("agent:main:main", "main")).toBe(true);
        expect(isSameSessionKey("agent:main:main", "agent:MAIN:main")).toBe(true);
        expect(isSameSessionKey("", "agent:main:main")).toBe(false);

        expect(normalizeAssistantPayload("hi")).toMatchObject({
            role: "assistant",
            text: "hi",
        });
        expect(normalizeAssistantPayload({ role: "user", content: "hi" })).toMatchObject({
            role: "user",
            text: "hi",
        });
        expect(finalMessageFromPayload({ runId: "run-1", text: "done" })).toMatchObject({
            role: "assistant",
            runId: "run-1",
            text: "done",
        });

        const merged = mergeStreamMessage(
            {
                role: "assistant",
                content: "old",
                text: "old",
                images: [{ data: "a", type: "image" }],
                attachments: [
                    {
                        fileName: "old.txt",
                        id: "old",
                        kind: "text",
                        mimeType: "text/plain",
                    },
                ],
            },
            {
                role: "assistant",
                content: "new",
                text: "new",
                toolResult: { content: "tool" },
            },
            "new",
            "run-2"
        );
        expect(merged).toMatchObject({
            role: "assistant",
            text: "new",
            runId: "run-2",
            images: [{ data: "a", type: "image" }],
            attachments: [
                {
                    fileName: "old.txt",
                    id: "old",
                    kind: "text",
                    mimeType: "text/plain",
                },
            ],
            toolResult: { content: "tool" },
        });

        expect(isRecord({ ok: true })).toBe(true);
        expect(isRecord([])).toBe(false);
        expect(isCommandMessagePayload({ command: true })).toBe(true);
        expect(isCommandMessagePayload({ command: false })).toBe(false);
        expect(createLocalSystemMessage("local")).toMatchObject({
            role: "system",
            text: "local",
            local: true,
        });
        expect(
            hasRecoveredStreamHistory(
                [{ role: "assistant", content: "hello world", text: "hello world" }],
                "hello"
            )
        ).toBe(true);

        const visibility = createChatVisibility(false, false);
        expect(
            visibleHistoryMessages(
                [
                    { role: "assistant", content: "visible" },
                    { role: "tool", content: "hidden" },
                ],
                visibility
            )
        ).toHaveLength(1);
        expect(shouldShowStreamRow("", undefined, visibility)).toBe(false);
        expect(shouldShowStreamRow("typing", undefined, visibility)).toBe(true);
        expect(
            shouldShowStreamRow(
                "",
                { role: "assistant", content: "visible", text: "visible" },
                visibility
            )
        ).toBe(true);
    });

    it("keeps settings and terminal page helpers stable", () => {
        expect(numberFromDuration(30, 5)).toBe(30);
        expect(numberFromDuration("2m", 5)).toBe(120);
        expect(numberFromDuration("bad", 5)).toBe(5);
        expect(errorMessage(new Error(" failed "), "fallback")).toBe("failed");
        expect(errorMessage("bad", "fallback")).toBe("fallback");
        expect(optionalFormValue("  value  ")).toBe("value");
        expect(optionalFormValue(" ".repeat(3))).toBeUndefined();

        const output = { clientHeight: 100, scrollHeight: 130, scrollTop: 1 };
        expect(isTerminalOutputAtBottom(output)).toBe(true);
        expect(scrollTerminalOutputToBottom(output)).toBe(true);
        expect(output.scrollTop).toBe(130);
        expect(scrollTerminalOutputToBottom(undefined)).toBe(false);

        const callbacks: string[] = [];
        expect(
            scrollTerminalOutputToBottomAndReport(output, () => {
                callbacks.push("scrolled");
            })
        ).toBe(true);
        expect(callbacks).toEqual(["scrolled"]);
    });
});
