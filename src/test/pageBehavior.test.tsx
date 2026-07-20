import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
    createMemoryHistory,
    createRootRoute,
    createRoute,
    createRouter,
    RouterProvider,
} from "@tanstack/react-router";
import {
    act,
    cleanup,
    fireEvent,
    render,
    screen,
    waitFor,
    within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, jest } from "bun:test";
import { createElement, type ReactNode } from "react";

import { logsCollection } from "../collections/logs";
import { sessionsCollection } from "../collections/sessions";
import {
    addDeletedMessageKeys,
    didScheduleBottomFollow,
    isSessionActive,
    nextHistoryLoadSendError,
    nextRefreshedChatMessages,
    readDeletedMessageKeys,
    readStoredChatDiagnosticVisibility,
    sessionTimestampMs,
    shouldStayAtHistoryBottom,
    writeDeletedMessageKeys,
} from "../components/features/chat/chatPageUtilities";
import { OpenClawSocketProvider } from "../hooks/useOpenClawSocket";
import { Agents } from "../pages/Agents";
import { Chat } from "../pages/Chat";
import { Dashboard } from "../pages/Dashboard";
import { Database } from "../pages/Database";
import { Docker } from "../pages/Docker";
import { Files } from "../pages/Files";
import { Jobs } from "../pages/Jobs";
import { Logs } from "../pages/Logs";
import { Moltbook } from "../pages/Moltbook";
import { PullRequests } from "../pages/PullRequests";
import { Sessions } from "../pages/Sessions";
import {
    errorMessage,
    numberFromDuration,
    optionalFormValue,
    Settings,
} from "../pages/Settings";
import {
    isTerminalOutputAtBottom,
    scrollTerminalOutputToBottom,
    scrollTerminalOutputToBottomAndReport,
    Terminal,
} from "../pages/Terminal";
import { normalizeChatSearch } from "../router";
import { authActions } from "../stores/authStore";
import { parseLogLine } from "../utils/logUtilities";

type FakeWebSocketListener = (event?: { data?: string }) => void;

const originalGlobals = {
    cancelAnimationFrame,
    fetch,
    requestAnimationFrame,
    scrollIntoView: Element.prototype.scrollIntoView,
    WebSocket,
};

const animationFrameState = {
    id: 0,
    frames: new Map<number, FrameRequestCallback>(),
};
const terminalApiState = {
    expectedExecCwd: "/tmp",
    wasJobStopped: false,
};
const jobsApiState = {
    cronName: "heartbeat",
    heartbeatIntervalSeconds: 1800,
    heartbeatRuns: [
        {
            id: 1,
            jobId: "heartbeat",
            status: "success",
            triggerType: "manual",
            startedAt: "2026-06-24T08:00:00.000Z",
            finishedAt: "2026-06-24T08:01:00.000Z",
            output: { message: "ok" },
        },
    ],
};
const logsApiState = {
    openclawHundredLineRequests: 0,
    simulateOpenclawTruncation: false,
};

function requestAnimationFrameForTest(callback: FrameRequestCallback): number {
    const id = ++animationFrameState.id;
    animationFrameState.frames.set(id, callback);
    return id;
}

function cancelAnimationFrameForTest(handle: number): void {
    animationFrameState.frames.delete(handle);
}

function flushAnimationFrames(limit = 20): void {
    act(() => {
        for (
            let count = 0;
            count < limit && animationFrameState.frames.size > 0;
            count += 1
        ) {
            const frames = animationFrameState.frames.entries().toArray();
            animationFrameState.frames.clear();
            for (const [, callback] of frames) {
                callback(performance.now());
            }
        }
    });
}

function resetLogsCollectionForTest() {
    if (!logsCollection.isReady()) {
        return;
    }

    const keys = Array.from(logsCollection, ([key]) => String(key));
    if (keys.length === 0) {
        return;
    }

    logsCollection.utils.writeBatch(() => {
        logsCollection.utils.writeDelete(keys);
    });
}

function resetSessionsCollectionForTest() {
    if (!sessionsCollection.isReady()) {
        return;
    }

    const keys = Array.from(sessionsCollection, ([key]) => String(key));
    if (keys.length === 0) {
        return;
    }

    sessionsCollection.utils.writeBatch(() => {
        sessionsCollection.utils.writeDelete(keys);
    });
}

class FakeWebSocket {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;
    static instances: FakeWebSocket[] = [];

    private readonly listeners = new Map<string, FakeWebSocketListener[]>();
    readonly respondedRequestIds = new Set<string>();
    readonly sent: string[] = [];
    readonly url: string;
    readyState = FakeWebSocket.CONNECTING;

    constructor(url: string) {
        this.url = url;
        FakeWebSocket.instances.push(this);
    }

    addEventListener(type: string, listener: FakeWebSocketListener) {
        this.listeners.set(type, [...(this.listeners.get(type) || []), listener]);
    }

    emit(type: string, event: { data?: string } = {}) {
        if (type === "open") {
            this.readyState = FakeWebSocket.OPEN;
        }
        const listeners = this.listeners.get(type) || [];
        for (const listener of listeners) {
            listener(event);
        }
    }

    send(data: string) {
        this.sent.push(data);
    }

    respondToLastRequest(payload: unknown = {}) {
        const request = JSON.parse(this.sent.at(-1) || "{}") as { id?: string };
        if (request.id) {
            this.respondedRequestIds.add(request.id);
        }
        this.emit("message", {
            data: JSON.stringify({
                type: "response",
                id: request.id,
                isOk: true,
                payload,
            }),
        });
    }

    close() {
        this.readyState = FakeWebSocket.CLOSED;
        this.emit("close");
    }
}

async function respondToSocketRequest(
    socket: FakeWebSocket,
    method: string,
    payload: unknown = {},
    isOk = true
) {
    const request = findSocketRequest(socket, method);

    if (!request?.id) {
        throw new Error(`No socket request found for ${method}`);
    }
    socket.respondedRequestIds.add(request.id);

    await act(async () => {
        socket.emit("message", {
            data: JSON.stringify({
                type: "response",
                id: request.id,
                isOk,
                payload,
            }),
        });
        await Promise.resolve();
    });
}

function findSocketRequest(socket: FakeWebSocket, method: string) {
    return socket.sent
        .toReversed()
        .map(
            (entry) =>
                JSON.parse(entry) as {
                    id?: string;
                    method?: string;
                    params?: unknown;
                    type?: string;
                }
        )
        .find(
            (entry) =>
                entry.type === "req" &&
                entry.method === method &&
                Boolean(entry.id && !socket.respondedRequestIds.has(entry.id))
        );
}

function parseRequestBody(init: RequestInit | undefined) {
    return JSON.parse(String(init?.body || "{}")) as Record<string, unknown>;
}

function apiResponse(url: string, method: string, init?: RequestInit) {
    if (method === "POST" && url === "/api/sessions/agent%3Amain%3Amain/action") {
        expect(parseRequestBody(init)).toEqual({ action: "compact" });
        return Response.json({ isSuccess: true });
    }

    if (method === "POST" && url === "/api/docker/containers/abc123/action") {
        expect(parseRequestBody(init)).toEqual({ action: "restart" });
        return Response.json({ output: "container action output" });
    }

    if (method === "POST" && url === "/api/docker/stack/action") {
        expect(parseRequestBody(init)).toEqual({ action: "restart" });
        return Response.json({ output: "stack restarted" });
    }

    if (method === "POST" && url === "/api/docker/prune") {
        const body = parseRequestBody(init);
        if (body.target !== "images" && body.target !== "volumes") {
            throw new Error(`Unexpected Docker prune target: ${String(body.target)}`);
        }
        return Response.json({ isSuccess: true, output: "pruned" });
    }

    if (method === "POST" && url === "/api/docker/updater/run") {
        return Response.json({
            isSuccess: true,
            steps: [{ isOk: true, stderr: "", stdout: "ok", step: "scan" }],
        });
    }

    if (method === "POST" && url === "/api/docker/updater/services/1/update") {
        return Response.json({
            isSuccess: true,
            result: {
                failed: [],
                isOk: true,
                mode: "manual",
                summary: { eligible: 1, failed: 0, updated: 1 },
                updated: [],
                workflow: "docker",
            },
            service: {},
            stderr: "manual stderr",
        });
    }

    if (method === "POST" && url === "/api/cache/docker.summary/refresh") {
        return Response.json({ entry: { key: "docker.summary" }, isOk: true });
    }

    if (method === "POST" && url === "/api/docker/exec/start") {
        expect(parseRequestBody(init)).toMatchObject({
            command: "echo hello",
            containerId: "abc123",
        });
        return Response.json({ jobId: "job-1" });
    }

    if (method === "POST" && url === "/api/docker/exec/job-1/stop") {
        return Response.json({ isSuccess: true });
    }

    if (method === "POST" && url === "/api/terminal/cd") {
        const body = parseRequestBody(init);
        if (body.path === "/tmp") {
            return Response.json({ isSuccess: true, newCwd: "/tmp" });
        }
        return Response.json({
            isSuccess: false,
            newCwd: String(body.cwd || "/home/ubuntu"),
            error: "Not a directory",
        });
    }

    if (method === "POST" && url === "/api/terminal/complete") {
        expect(parseRequestBody(init)).toMatchObject({ partial: "ec" });
        return Response.json({
            commonPrefix: "echo ",
            completions: [
                { completion: "echo ", display: "echo", type: "executable" },
                { completion: "echown ", display: "echown", type: "executable" },
            ],
        });
    }

    if (method === "POST" && url === "/api/exec/start") {
        const body = parseRequestBody(init);
        expect(body.command).toBe("bash");
        expect(body.args).toEqual(["-lc", "echo hello"]);
        expect(body.cwd).toBe(terminalApiState.expectedExecCwd);
        return Response.json({ jobId: "job-1" });
    }

    if (method === "POST" && url === "/api/exec/job-1/stop") {
        terminalApiState.wasJobStopped = true;
        return Response.json({ isSuccess: true });
    }

    if (method === "DELETE" && url === "/api/docker/images/img-unused") {
        return Response.json({ isSuccess: true });
    }

    if (method === "DELETE" && url === "/api/docker/volumes/unused-volume") {
        return Response.json({ isSuccess: true });
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

    if (url === "/api/agents/tasks/history?limit=7") {
        return Response.json({
            tasks: [
                {
                    id: 1,
                    agentId: "mira-2026",
                    task: "Testing pages",
                    status: "done",
                    completedAt: "2026-06-24T08:05:00.000Z",
                },
            ],
            timestamp: 1_719_216_000_000,
        });
    }

    if (url === "/api/metrics") {
        return Response.json({
            cpu: { count: 4, loadAvg: [0.1, 0.2, 0.3], loadPercent: 5 },
            memory: {
                total: 100,
                totalGB: 100,
                used: 40,
                usedGB: 40,
                free: 60,
                percent: 40,
            },
            disk: {
                total: 1000,
                totalGB: 1000,
                used: 250,
                usedGB: 250,
                free: 750,
                percent: 25,
            },
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
                    {
                        date: "2026-06-24",
                        maxTempC: 22,
                        minTempC: 12,
                        description: "Clear",
                    },
                    {
                        date: "2026-06-25",
                        maxTempC: 19,
                        minTempC: 10,
                        description: "Rain",
                    },
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
                openai: {
                    account: "raymond",
                    model: "codex",
                    fiveHourLeftPercent: 90,
                    weeklyLeftPercent: 80,
                    fiveHourReset: "13:45",
                    weeklyReset: "2026-06-25T10:00:00.000Z",
                    percentUsed: 10,
                    resetAt: "13:45",
                },
                openrouter: {
                    usage: 1,
                    usageMonthly: 1,
                    remaining: 9,
                    totalCredits: 10,
                    limit: 10,
                    limitRemaining: 9,
                    limitReset: "monthly",
                    percentUsed: 10,
                },
                elevenlabs: {
                    used: 100,
                    total: 1000,
                    remaining: 900,
                    tier: "creator",
                    percentUsed: 10,
                    resetAt: "2026-06-25T10:00:00.000Z",
                },
                synthetic: {
                    subscription: {
                        limit: 100,
                        requests: 10,
                        remaining: 90,
                        renewsAt: "2026-06-25T10:00:00.000Z",
                        percentUsed: 10,
                    },
                    searchHourly: {
                        limit: 100,
                        requests: 5,
                        remaining: 95,
                        renewsAt: "2026-06-24T09:00:00.000Z",
                        percentUsed: 5,
                    },
                    rollingFiveHourLimit: {
                        remaining: 90,
                        max: 100,
                        limited: false,
                        nextTickAt: "2026-06-24T09:00:00.000Z",
                        percentUsed: 10,
                    },
                    weeklyTokenLimit: {
                        percentRemaining: 80,
                        nextRegenAt: "2026-06-25T10:00:00.000Z",
                    },
                },
            },
            meta: {},
        });
    }

    if (url === "/api/cache/heartbeat" || url === "/api/cache/status") {
        return Response.json({
            generatedAt: "2026-06-24T08:00:00.000Z",
            count: 7,
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
                {
                    key: "quotas.summary",
                    source: "quota",
                    status: "fresh",
                    updatedAt: "2026-06-24T08:00:00.000Z",
                    consecutiveFailures: 0,
                    data: {},
                    meta: {},
                },
                {
                    key: "moltbook.home",
                    source: "moltbook",
                    status: "fresh",
                    updatedAt: "2026-06-24T08:00:00.000Z",
                    consecutiveFailures: 0,
                    data: {},
                    meta: {},
                },
                {
                    key: "git.workspace",
                    source: "git",
                    status: "fresh",
                    updatedAt: "2026-06-24T08:00:00.000Z",
                    consecutiveFailures: 0,
                    data: {},
                    meta: {},
                },
                {
                    key: "system.host",
                    source: "system",
                    status: "fresh",
                    updatedAt: "2026-06-24T08:00:00.000Z",
                    consecutiveFailures: 0,
                    data: {},
                    meta: {},
                },
                {
                    key: "docker.summary",
                    source: "backend",
                    status: "fresh",
                    updatedAt: "2026-06-24T08:00:00.000Z",
                    consecutiveFailures: 0,
                    data: {},
                    meta: {},
                },
                {
                    key: "database.summary",
                    source: "backend",
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
                        remote: "https://github.com/rajohan/Mira-Dashboard",
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

    if (url === "/api/cache/backup.kopia.status") {
        return Response.json({
            key: "backup.kopia.status",
            status: "fresh",
            source: "backup",
            consecutiveFailures: 0,
            data: {
                checkedAt: "2026-06-24T08:00:00.000Z",
                tool: "kopia",
                isOk: true,
                snapshotsByPath: [],
                stale: [],
            },
            meta: {},
        });
    }

    if (url === "/api/cache/backup.walg.status") {
        return Response.json({
            key: "backup.walg.status",
            status: "fresh",
            source: "backup",
            consecutiveFailures: 0,
            data: {
                checkedAt: "2026-06-24T08:00:00.000Z",
                tool: "walg",
                isOk: true,
                backupCount: 1,
                latest: {
                    backupName: "base_0001",
                    modified: "2026-06-24T08:00:00.000Z",
                    time: "2026-06-24T08:00:00.000Z",
                    walFileName: "000000010000000000000001",
                },
                stale: false,
            },
            meta: {},
        });
    }

    if (url === "/api/cron/jobs") {
        return Response.json({
            jobs: [
                {
                    id: "heartbeat",
                    name: jobsApiState.cronName,
                    command: "openclaw heartbeat",
                    schedule: { kind: "cron", expression: "*/30 * * * *" },
                    payload: { kind: "heartbeat" },
                    delivery: { mode: "session" },
                    enabled: true,
                    state: {
                        lastRunAtMs: 1_719_216_000_000,
                        nextRunAtMs: 1_719_217_800_000,
                        lastRunStatus: "success",
                    },
                },
            ],
        });
    }

    if (url === "/api/ops/log-rotation/status") {
        return Response.json({
            isSuccess: true,
            lastRun: {
                checkedFiles: 1,
                checkedGroups: 1,
                compressedFiles: 0,
                deletedArchives: 0,
                errors: [],
                finishedAt: "2026-06-24T08:01:00.000Z",
                groups: [],
                isDryRun: false,
                isOk: true,
                rotatedFiles: 0,
                skippedFiles: 0,
                startedAt: "2026-06-24T08:00:00.000Z",
                warnings: [],
            },
        });
    }

    if (url === "/api/cache/database.summary") {
        return Response.json({
            key: "database.summary",
            status: "fresh",
            source: "backend",
            consecutiveFailures: 0,
            updatedAt: "2026-06-24T08:00:00.000Z",
            meta: {},
            data: {
                checkedAt: "2026-06-24T08:00:00.000Z",
                overview: {
                    totalDatabaseSizeBytes: 1024,
                    totalBackends: 2,
                    averageCacheHitRatio: 99,
                    connections: { active: 1, idle: 1 },
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
                        datname: "metabase",
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
            },
        });
    }

    if (url === "/api/database/overview") {
        return Response.json({
            overview: {
                totalDatabaseSizeBytes: 1024,
                totalBackends: 2,
                averageCacheHitRatio: 99,
                connections: { active: 1, idle: 1 },
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
                    datname: "metabase",
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

    if (url === "/api/cache/docker.summary") {
        return Response.json({
            key: "docker.summary",
            status: "fresh",
            source: "backend",
            consecutiveFailures: 0,
            updatedAt: "2026-06-24T08:00:00.000Z",
            meta: {},
            data: {
                checkedAt: "2026-06-24T08:00:00.000Z",
                containers: [
                    {
                        command: "node server.js",
                        createdAt: "2026-06-24T08:00:00.000Z",
                        finishedAt: undefined,
                        health: "healthy",
                        id: "abc123",
                        image: "mira-dashboard:latest",
                        imageId: "sha256:image",
                        ipAddresses: { mira: "172.20.0.2" },
                        mounts: [],
                        name: "dashboard",
                        ports: ["3100/tcp"],
                        project: "mira",
                        restartCount: 0,
                        runningFor: "2 hours",
                        service: "dashboard",
                        startedAt: "2026-06-24T08:00:00.000Z",
                        state: "running",
                        stats: {
                            blockIO: "0 B / 0 B",
                            cpu: "3.5%",
                            memory: "128 MiB / 1 GiB",
                            memoryPercent: "12%",
                            netIO: "1 KB / 2 KB",
                            pids: "8",
                        },
                        status: "Up",
                    },
                ],
                images: [
                    {
                        containerName: "dashboard",
                        createdAt: "2026-06-24T08:00:00.000Z",
                        id: "img1",
                        inUseBy: ["dashboard"],
                        lastTagTime: "2026-06-24T08:00:00.000Z",
                        platform: "linux/amd64",
                        repository: "mira-dashboard",
                        size: 1024,
                        tag: "latest",
                    },
                    {
                        containerName: "",
                        createdAt: "2026-06-24T08:00:00.000Z",
                        id: "img-unused",
                        inUseBy: [],
                        lastTagTime: "2026-06-24T08:00:00.000Z",
                        platform: "linux/amd64",
                        repository: "unused",
                        size: 2048,
                        tag: "",
                    },
                ],
                volumes: [
                    {
                        name: "dashboard-data",
                        driver: "local",
                        mountpoint: "/var/lib/docker/volumes/dashboard-data",
                        labels: {},
                        scope: "local",
                        size: "1 KiB",
                        usedBy: ["dashboard"],
                    },
                    {
                        name: "unused-volume",
                        driver: "local",
                        mountpoint: "/var/lib/docker/volumes/unused-volume",
                        labels: {},
                        scope: "local",
                        size: "2 KiB",
                        usedBy: [],
                    },
                ],
                updaterServices: [
                    {
                        id: 1,
                        appSlug: "dashboard",
                        composeImageRef: "mira-dashboard:latest",
                        currentDigest: "sha256:old",
                        currentTag: "1.0.0",
                        enabled: true,
                        imageRepo: "mira-dashboard",
                        lastCheckedAt: "2026-06-24T08:00:00.000Z",
                        lastStatus: "update_available",
                        lastUpdatedAt: undefined,
                        latestDigest: "sha256:new",
                        latestTag: "1.0.1",
                        metadata: {},
                        pinMode: "tag",
                        policy: "notify",
                        serviceName: "dashboard",
                        updateAvailable: true,
                    },
                ],
                updaterEvents: [
                    {
                        appSlug: "dashboard",
                        createdAt: "2026-06-24T08:10:00.000Z",
                        details: {},
                        eventType: "update_available",
                        fromDigest: "sha256:old",
                        fromTag: "1.0.0",
                        id: 1,
                        managedServiceId: 1,
                        message: "update available",
                        serviceName: "dashboard",
                        toDigest: "sha256:new",
                        toTag: "1.0.1",
                    },
                ],
                updaterSummary: {
                    autoPolicy: 0,
                    enabled: 1,
                    failed: 0,
                    notifyPolicy: 1,
                    total: 1,
                    updateAvailable: 1,
                },
            },
        });
    }

    if (url === "/api/docker/containers") {
        return Response.json({
            containers: [
                {
                    command: "node server.js",
                    createdAt: "2026-06-24T08:00:00.000Z",
                    finishedAt: undefined,
                    health: "healthy",
                    id: "abc123",
                    image: "mira-dashboard:latest",
                    imageId: "sha256:image",
                    ipAddresses: { mira: "172.20.0.2" },
                    mounts: [],
                    name: "dashboard",
                    ports: ["3100/tcp"],
                    project: "mira",
                    restartCount: 0,
                    runningFor: "2 hours",
                    service: "dashboard",
                    startedAt: "2026-06-24T08:00:00.000Z",
                    state: "running",
                    stats: {
                        blockIO: "0 B / 0 B",
                        cpu: "3.5%",
                        memory: "128 MiB / 1 GiB",
                        memoryPercent: "12%",
                        netIO: "1 KB / 2 KB",
                        pids: "8",
                    },
                    status: "Up",
                },
            ],
        });
    }

    if (url === "/api/docker/containers/stats") {
        return Response.json({
            stats: [
                {
                    blockIO: "4 KB / 8 KB",
                    cpu: "8.5%",
                    id: "abc123",
                    memory: "256 MiB / 1 GiB",
                    memoryPercent: "25%",
                    netIO: "3 KB / 6 KB",
                    pids: "9",
                },
            ],
        });
    }

    if (url === "/api/docker/containers/abc123") {
        return Response.json({
            command: "node server.js",
            createdAt: "2026-06-24T08:00:00.000Z",
            env: ["NODE_ENV=production"],
            finishedAt: undefined,
            health: "healthy",
            id: "abc123",
            image: "mira-dashboard:latest",
            imageId: "sha256:image",
            ipAddresses: { mira: "172.20.0.2" },
            labels: { "com.docker.compose.service": "dashboard" },
            mounts: [
                {
                    destination: "/data",
                    mode: "rw",
                    readOnly: false,
                    source: "/var/lib/dashboard",
                    type: "bind",
                },
            ],
            name: "dashboard",
            networks: [
                {
                    gateway: "172.20.0.1",
                    ipAddress: "172.20.0.2",
                    macAddress: "02:42:ac:14:00:02",
                    name: "mira",
                },
            ],
            ports: ["3100/tcp"],
            project: "mira",
            restartCount: 0,
            runningFor: "2 hours",
            service: "dashboard",
            startedAt: "2026-06-24T08:00:00.000Z",
            state: "running",
            stats: {
                blockIO: "0 B / 0 B",
                cpu: "3.5%",
                memory: "128 MiB / 1 GiB",
                memoryPercent: "12%",
                netIO: "1 KB / 2 KB",
                pids: "8",
            },
            status: "Up",
        });
    }

    if (url === "/api/docker/containers/abc123/logs?tail=200") {
        return Response.json({ content: "dashboard log line" });
    }

    if (url === "/api/docker/containers/abc123/logs?tail=500") {
        return Response.json({ content: "more dashboard log lines" });
    }

    if (url === "/api/docker/images") {
        return Response.json({
            images: [
                {
                    containerName: "dashboard",
                    createdAt: "2026-06-24T08:00:00.000Z",
                    id: "img1",
                    inUseBy: ["dashboard"],
                    lastTagTime: "2026-06-24T08:00:00.000Z",
                    platform: "linux/amd64",
                    repository: "mira-dashboard",
                    size: 1024,
                    tag: "latest",
                },
                {
                    containerName: "",
                    createdAt: "2026-06-24T08:00:00.000Z",
                    id: "img-unused",
                    inUseBy: [],
                    lastTagTime: "2026-06-24T08:00:00.000Z",
                    platform: "linux/amd64",
                    repository: "unused",
                    size: 2048,
                    tag: "",
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
                    size: "1 KiB",
                    usedBy: ["dashboard"],
                },
                {
                    name: "unused-volume",
                    driver: "local",
                    mountpoint: "/var/lib/docker/volumes/unused-volume",
                    labels: {},
                    scope: "local",
                    size: "2 KiB",
                    usedBy: [],
                },
            ],
        });
    }

    if (url === "/api/docker/updater/services") {
        return Response.json({
            services: [
                {
                    id: 1,
                    appSlug: "dashboard",
                    composeImageRef: "mira-dashboard:latest",
                    currentDigest: "sha256:old",
                    currentTag: "1.0.0",
                    enabled: true,
                    imageRepo: "mira-dashboard",
                    lastCheckedAt: "2026-06-24T08:00:00.000Z",
                    lastStatus: "update_available",
                    lastUpdatedAt: undefined,
                    latestDigest: "sha256:new",
                    latestTag: "1.0.1",
                    metadata: {},
                    pinMode: "tag",
                    policy: "notify",
                    serviceName: "dashboard",
                    updateAvailable: true,
                },
            ],
            summary: {
                autoPolicy: 0,
                enabled: 1,
                failed: 0,
                notifyPolicy: 1,
                total: 1,
                updateAvailable: 1,
            },
        });
    }

    if (url === "/api/docker/updater/events?limit=25") {
        return Response.json({
            events: [
                {
                    appSlug: "dashboard",
                    createdAt: "2026-06-24T08:10:00.000Z",
                    details: {},
                    eventType: "update_available",
                    fromDigest: "sha256:old",
                    fromTag: "1.0.0",
                    id: 1,
                    managedServiceId: 1,
                    message: "update available",
                    serviceName: "dashboard",
                    toDigest: "sha256:new",
                    toTag: "1.0.1",
                },
            ],
        });
    }

    if (url === "/api/docker/exec/job-1") {
        return Response.json({
            code: undefined,
            containerId: "abc123",
            endedAt: undefined,
            jobId: "job-1",
            startedAt: 1_719_216_000_000,
            status: "running",
            stderr: "warn",
            stdout: "hello",
        });
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
                    intervalSeconds: jobsApiState.heartbeatIntervalSeconds,
                    actionKey: "heartbeat",
                    actionPayload: {},
                    createdAt: "2026-06-24T08:00:00.000Z",
                    updatedAt: "2026-06-24T08:00:00.000Z",
                    lastRun: jobsApiState.heartbeatRuns[0],
                    isRunning: false,
                },
            ],
        });
    }

    if (url === "/api/reports") {
        return Response.json({
            items: [
                {
                    bodyMd: "Heartbeat looks good.",
                    createdAt: "2026-06-24T08:05:00.000Z",
                    dedupeKey: "heartbeat:ok",
                    id: 1,
                    metadata: {},
                    occurredAt: "2026-06-24T08:05:00.000Z",
                    source: "openclaw",
                    sourceJobId: "heartbeat",
                    status: "ok",
                    summary: "Heartbeat looks good.",
                    title: "Heartbeat report",
                    type: "heartbeat",
                    updatedAt: "2026-06-24T08:05:00.000Z",
                },
            ],
        });
    }

    if (url === "/api/jobs/heartbeat/runs") {
        return Response.json({
            runs: jobsApiState.heartbeatRuns,
        });
    }

    if (method === "PATCH" && url === "/api/jobs/heartbeat") {
        const body = parseRequestBody(init) as {
            patch?: {
                cronExpression?: unknown;
                intervalSeconds?: unknown;
                scheduleType?: unknown;
                timeOfDay?: unknown;
            };
        };
        const clearedScheduleValue = JSON.parse("null") as null;
        jobsApiState.heartbeatIntervalSeconds = Number(body.patch?.intervalSeconds);
        expect(body).toEqual({
            patch: {
                cronExpression: clearedScheduleValue,
                intervalSeconds: 3600,
                scheduleType: "interval",
                timeOfDay: clearedScheduleValue,
            },
        });
        return Response.json({
            isOk: true,
            job: {
                id: "heartbeat",
                name: "Heartbeat",
                enabled: true,
                scheduleType: "interval",
                intervalSeconds: jobsApiState.heartbeatIntervalSeconds,
                actionKey: "heartbeat",
                actionPayload: {},
                createdAt: "2026-06-24T08:00:00.000Z",
                updatedAt: "2026-06-24T08:05:00.000Z",
                isRunning: false,
            },
        });
    }

    if (method === "POST" && url === "/api/jobs/heartbeat/run") {
        jobsApiState.heartbeatRuns = [
            {
                id: 2,
                jobId: "heartbeat",
                status: "success",
                triggerType: "manual",
                startedAt: "2026-06-24T08:05:00.000Z",
                finishedAt: "2026-06-24T08:06:00.000Z",
                output: { message: "manual ok" },
            },
            ...jobsApiState.heartbeatRuns,
        ];
        return Response.json({
            isOk: true,
            run: jobsApiState.heartbeatRuns[0],
        });
    }

    if (method === "POST" && url === "/api/cron/jobs/heartbeat/run") {
        return Response.json({ isOk: true });
    }

    if (method === "POST" && url === "/api/cron/jobs/heartbeat/toggle") {
        expect(parseRequestBody(init)).toEqual({ enabled: false });
        return Response.json({ isOk: true });
    }

    if (method === "POST" && url === "/api/cron/jobs/heartbeat/update") {
        const body = parseRequestBody(init) as {
            patch: {
                delivery: { mode: string };
                name: string;
                payload: { kind: string };
                schedule: { kind: string; expression: string };
            };
        };
        expect(body).toEqual({
            patch: {
                delivery: { mode: "session" },
                name: "heartbeat-updated",
                payload: { kind: "heartbeat" },
                schedule: { kind: "cron", expression: "*/30 * * * *" },
            },
        });
        jobsApiState.cronName = body.patch.name;
        return Response.json({ isOk: true });
    }

    if (method === "POST" && url === "/api/cron/jobs/heartbeat/delete") {
        return Response.json({ isOk: true });
    }

    if (url === "/api/logs/info") {
        return Response.json({
            logs: [
                { name: "openclaw.log", size: 100 },
                { name: "archived.log", size: 40 },
                { name: "blank.log", size: 2 },
            ],
        });
    }

    if (url === "/api/logs/content?file=openclaw.log&lines=100") {
        logsApiState.openclawHundredLineRequests += 1;
        if (logsApiState.simulateOpenclawTruncation) {
            return Response.json({
                content: JSON.stringify({
                    level: "info",
                    time: "2026-06-24T08:00:00.000Z",
                    msg: "truncated dashboard ready",
                }),
                lineIds: ["20"],
            });
        }

        return Response.json({
            content: [
                JSON.stringify({
                    level: "info",
                    time: "2026-06-24T08:00:00.000Z",
                    msg: "dashboard ready",
                }),
                JSON.stringify({
                    level: "error",
                    time: "2026-06-24T08:01:00.000Z",
                    msg: "failed backup",
                }),
            ].join("\n"),
            lineIds: ["200", "300"],
        });
    }

    if (url === "/api/logs/content?file=openclaw.log&lines=5000") {
        return Response.json({
            content: [
                JSON.stringify({
                    level: "warn",
                    time: "2026-06-24T07:59:00.000Z",
                    msg: "expanded tail only",
                }),
                JSON.stringify({
                    level: "info",
                    time: "2026-06-24T08:00:00.000Z",
                    msg: "dashboard ready",
                }),
                JSON.stringify({
                    level: "error",
                    time: "2026-06-24T08:01:00.000Z",
                    msg: "failed backup",
                }),
            ].join("\n"),
            lineIds: ["100", "200", "300"],
        });
    }

    if (url === "/api/logs/content?file=blank.log&lines=100") {
        return Response.json({
            content: "\n\n",
            lineIds: ["0", "1", "2"],
        });
    }

    if (url === "/api/logs/content?file=archived.log&lines=100") {
        return Response.json({
            content: JSON.stringify({
                level: "info",
                time: "2026-06-23T08:00:00.000Z",
                msg: "archived dashboard ready",
            }),
            lineIds: ["20"],
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
            data: {
                agent: {
                    name: "mira",
                    display_name: "Mira",
                    description: "Dashboard operator",
                    karma: 42,
                    follower_count: 7,
                    following_count: 3,
                    posts_count: 5,
                    comments_count: 9,
                    avatar_url: undefined,
                },
            },
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
                    mergeable: "isOk",
                    statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }],
                    additions: 12,
                    deletions: 3,
                    changedFiles: 2,
                    reviewerApproved: true,
                    body: String.raw`## Summary\nCoverage body`,
                },
                {
                    number: 191,
                    title: "Bump dashboard dependency",
                    url: "https://github.com/rajohan/Mira-Dashboard/pull/191",
                    headRefName: "dependabot/npm-and-yarn/pkg",
                    baseRefName: "main",
                    author: { login: "app/dependabot" },
                    createdAt: "2026-06-24T09:00:00.000Z",
                    updatedAt: "2026-06-24T09:05:00.000Z",
                    isDraft: false,
                    reviewDecision: "REVIEW_REQUIRED",
                    mergeStateStatus: "BEHIND",
                    mergeable: "MERGEABLE",
                    statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }],
                    additions: 4,
                    deletions: 1,
                    changedFiles: 1,
                    canReviewerApprove: true,
                    body: "Dependency update",
                },
            ],
        });
    }

    if (url === "/api/pull-requests/deployments") {
        return Response.json({
            deployments: [
                {
                    id: "deploy-1",
                    commit: "abc123",
                    commitTitle: "Deploy dashboard",
                    status: "isOk",
                    updatedAt: "2026-06-24T08:10:00.000Z",
                    note: "deployed",
                },
            ],
        });
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

    if (method === "POST" && url === "/api/pull-requests/190/approve") {
        expect(parseRequestBody(init)).toEqual({ deploy: false });
        return Response.json({
            isOk: true,
            message: "Merged PR #190",
            cleanup: { isOk: true, message: "Cleaned worktree" },
        });
    }

    if (method === "POST" && url === "/api/pull-requests/190/reject") {
        expect(parseRequestBody(init)).toEqual({});
        return Response.json({
            isOk: true,
            message: "Rejected PR #190",
        });
    }

    if (method === "POST" && url === "/api/pull-requests/191/review-approval") {
        expect(parseRequestBody(init)).toEqual({});
        return Response.json({ isOk: true, message: "Approved PR #191" });
    }

    if (method === "POST" && url === "/api/pull-requests/191/update-branch") {
        expect(parseRequestBody(init)).toEqual({});
        return Response.json({ isOk: true, message: "Branch update queued" });
    }

    if (method === "POST" && url === "/api/pull-requests/deploy") {
        return Response.json({
            isOk: true,
            deployment: {
                id: "deploy-2",
                commit: "def456",
                status: "restart-scheduled",
                updatedAt: "2026-06-24T08:15:00.000Z",
                note: "Deploy scheduled",
            },
        });
    }

    if (url === "/api/config") {
        if (method === "PUT") {
            const body = parseRequestBody(init);
            expect(body.__hash).toBe("config-hash-1");
            return Response.json({ isOk: true });
        }
        return Response.json({
            __hash: "config-hash-1",
            agents: { list: [{ id: "ops", heartbeat: { every: "30m" } }] },
            session: { reset: { idleMinutes: 60 } },
            channels: {
                webchat: { enabled: true, dmPolicy: "allow" },
            },
            auth: { profiles: { owner: {} } },
            commands: { ownerAllowFrom: ["rajohan"], restart: true },
            logging: { redactSensitive: "strict" },
            meta: {
                lastTouchedAt: "2026-06-25T18:00:00.000Z",
                lastTouchedVersion: "2026.6.10",
            },
            models: {},
            tools: {
                exec: { ask: "always", security: "deny" },
                web: { fetch: { enabled: true }, search: { enabled: true } },
            },
        });
    }

    if (method === "POST" && url === "/api/skills/task-tracking") {
        expect(parseRequestBody(init)).toEqual({
            __hash: "config-hash-1",
            enabled: false,
        });
        return Response.json({ isOk: true });
    }

    if (url === "/api/skills") {
        return Response.json({
            skills: [
                {
                    name: "task-tracking",
                    description: "Tasks",
                    enabled: true,
                    source: "workspace",
                },
            ],
        });
    }

    if (method === "POST" && url === "/api/backup") {
        return Response.json({
            createdAt: "2026-06-25T18:30:00.000Z",
            hash: "backup-hash",
            config: { model: "codex" },
        });
    }

    if (method === "POST" && url === "/api/restart") {
        return new Response(undefined, { status: 204 });
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
            jobId: "job-1",
            status: terminalApiState.wasJobStopped ? "done" : "running",
            stdout: terminalApiState.wasJobStopped ? "ok" : "",
            stderr: "",
            code: terminalApiState.wasJobStopped ? 0 : undefined,
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

function renderChatPage(initialEntry = "/chat") {
    const rootRoute = createRootRoute();
    const chatRoute = createRoute({
        getParentRoute: () => rootRoute,
        path: "/chat",
        validateSearch: normalizeChatSearch,
        component: Chat,
    });
    const router = createRouter({
        history: createMemoryHistory({ initialEntries: [initialEntry] }),
        routeTree: rootRoute.addChildren([chatRoute]),
    });
    const queryClient = new QueryClient({
        defaultOptions: {
            mutations: { retry: false },
            queries: { retry: false, staleTime: Infinity },
        },
    });

    return {
        ...render(
            <QueryClientProvider client={queryClient}>
                <OpenClawSocketProvider>
                    <RouterProvider router={router} />
                </OpenClawSocketProvider>
            </QueryClientProvider>
        ),
        queryClient,
        router,
    };
}

function clickElement(element: Element) {
    act(() => {
        fireEvent.click(element);
    });
    flushAnimationFrames();
}

async function flushQueuedTimers() {
    await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
    });
}

describe("Mira Dashboard pages", () => {
    beforeEach(() => {
        FakeWebSocket.instances = [];
        terminalApiState.expectedExecCwd = "/tmp";
        terminalApiState.wasJobStopped = false;
        logsApiState.openclawHundredLineRequests = 0;
        logsApiState.simulateOpenclawTruncation = false;
        jobsApiState.cronName = "heartbeat";
        jobsApiState.heartbeatIntervalSeconds = 1800;
        jobsApiState.heartbeatRuns = [
            {
                id: 1,
                jobId: "heartbeat",
                status: "success",
                triggerType: "manual",
                startedAt: "2026-06-24T08:00:00.000Z",
                finishedAt: "2026-06-24T08:01:00.000Z",
                output: { message: "ok" },
            },
        ];
        authActions.setSession({
            authenticated: true,
            isBootstrapRequired: false,
            user: { id: 1, username: "mira" },
        });
        Object.defineProperties(globalThis, {
            fetch: {
                configurable: true,
                value: jest.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
                    apiResponse(String(input), init?.method ?? "GET", init)
                ),
                writable: true,
            },
            WebSocket: {
                configurable: true,
                value: FakeWebSocket,
                writable: true,
            },
            requestAnimationFrame: {
                configurable: true,
                value: requestAnimationFrameForTest,
                writable: true,
            },
            cancelAnimationFrame: {
                configurable: true,
                value: cancelAnimationFrameForTest,
                writable: true,
            },
        });
        Element.prototype.scrollIntoView = jest.fn();
    });

    afterEach(() => {
        cleanup();
        resetLogsCollectionForTest();
        resetSessionsCollectionForTest();
        authActions.clearSession();
        localStorage.clear();
        animationFrameState.frames.clear();
        Object.defineProperties(globalThis, {
            fetch: {
                configurable: true,
                value: originalGlobals.fetch,
                writable: true,
            },
            WebSocket: {
                configurable: true,
                value: originalGlobals.WebSocket,
                writable: true,
            },
            requestAnimationFrame: {
                configurable: true,
                value: originalGlobals.requestAnimationFrame,
                writable: true,
            },
            cancelAnimationFrame: {
                configurable: true,
                value: originalGlobals.cancelAnimationFrame,
                writable: true,
            },
        });
        Element.prototype.scrollIntoView = originalGlobals.scrollIntoView;
    });

    it("renders the main data pages from their API contracts", async () => {
        const pages: Array<[ReactNode, string, { withSocket?: boolean }?]> = [
            [createElement(Agents), "Active (1)"],
            [createElement(Dashboard), "Spydeberg", { withSocket: true }],
            [createElement(Database), "metabase"],
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

    it("labels and dismisses file save errors", async () => {
        const user = userEvent.setup();
        const originalFetch = fetch;
        let view: ReturnType<typeof renderPage> | undefined;

        try {
            Object.defineProperty(globalThis, "fetch", {
                configurable: true,
                value: jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
                    const url = String(input);
                    const method = init?.method ?? "GET";

                    if (method === "PUT" && url === "/api/files/README.md") {
                        return Response.json({ error: "Save failed" }, { status: 500 });
                    }

                    return apiResponse(url, method, init);
                }),
                writable: true,
            });

            view = renderPage(createElement(Files));

            await user.click(await screen.findByRole("button", { name: "README.md" }));
            await user.click(await screen.findByRole("button", { name: "Raw" }));
            const editor = await screen.findByRole("textbox");
            await user.clear(editor);
            await user.type(editor, "# Updated Dashboard");
            await user.click(screen.getByRole("button", { name: "Save" }));

            expect(await screen.findByText("Save failed")).toBeInTheDocument();
            await user.click(screen.getByRole("button", { name: "Dismiss file error" }));
            expect(screen.queryByText("Save failed")).not.toBeInTheDocument();
        } finally {
            view?.unmount();
            view?.queryClient.clear();
            Object.defineProperty(globalThis, "fetch", {
                configurable: true,
                value: originalFetch,
                writable: true,
            });
        }
    });

    it("keeps loaded database metrics visible when a refresh fails", async () => {
        let databaseRequestCount = 0;
        const fetchMock = jest.fn(
            async (input: RequestInfo | URL, init?: RequestInit) => {
                const url = String(input);
                const method = init?.method ?? "GET";
                if (url === "/api/cache/database.summary") {
                    databaseRequestCount += 1;
                    if (databaseRequestCount === 1) {
                        return apiResponse(url, method, init);
                    }

                    const response = await apiResponse(url, method, init);
                    const envelope = (await response.json()) as Record<string, unknown>;
                    return Response.json({
                        ...envelope,
                        status: "error",
                        errorMessage: "Database metrics temporarily unavailable",
                        consecutiveFailures: 1,
                    });
                }

                if (url === "/api/cache/database.summary/refresh") {
                    throw new Error("Database metrics temporarily unavailable");
                }

                return apiResponse(url, method, init);
            }
        );
        Object.defineProperty(globalThis, "fetch", {
            configurable: true,
            value: fetchMock,
            writable: true,
        });

        const view = renderPage(createElement(Database));

        const databaseRows = await screen.findAllByText("metabase");
        expect(databaseRows.length).toBeGreaterThan(0);
        await act(async () => {
            await view.queryClient.invalidateQueries({
                queryKey: ["cache", "database.summary"],
            });
        });

        expect(
            await screen.findByText(
                "Database refresh failed. Showing the last loaded metrics. Database metrics temporarily unavailable"
            )
        ).toBeInTheDocument();
        expect(screen.getAllByText("metabase").length).toBeGreaterThan(0);

        view.unmount();
        view.queryClient.clear();
    });

    it("shows the agents error state without the configured-agents empty state", async () => {
        Object.defineProperty(globalThis, "fetch", {
            configurable: true,
            value: jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
                const url = String(input);
                const method = init?.method ?? "GET";

                if (url === "/api/agents/status" && method === "GET") {
                    return Response.json(
                        { error: "Agents status unavailable" },
                        { status: 503 }
                    );
                }

                return apiResponse(url, method, init);
            }),
            writable: true,
        });

        const view = renderPage(createElement(Agents));

        expect(await screen.findByText("Agents status unavailable")).toBeInTheDocument();
        expect(screen.queryByText(/No agents configured/u)).not.toBeInTheDocument();

        view.unmount();
        view.queryClient.clear();
    });

    it("keeps loaded jobs visible when active view refreshes fail", async () => {
        const user = userEvent.setup();
        let scheduledJobsRequestCount = 0;
        let cronJobsRequestCount = 0;
        const fetchMock = jest.fn(
            async (input: RequestInfo | URL, init?: RequestInit) => {
                const url = String(input);
                const method = init?.method ?? "GET";

                if (url === "/api/jobs" && method === "GET") {
                    scheduledJobsRequestCount += 1;
                    if (scheduledJobsRequestCount > 1) {
                        return Response.json(
                            { error: "Scheduled jobs temporarily unavailable" },
                            { status: 503 }
                        );
                    }
                }

                if (url === "/api/cron/jobs" && method === "GET") {
                    cronJobsRequestCount += 1;
                    if (cronJobsRequestCount > 1) {
                        return Response.json(
                            { error: "Cron jobs temporarily unavailable" },
                            { status: 503 }
                        );
                    }
                }

                return apiResponse(url, method, init);
            }
        );
        Object.defineProperty(globalThis, "fetch", {
            configurable: true,
            value: fetchMock,
            writable: true,
        });

        const view = renderPage(createElement(Jobs));

        const scheduledJobRows = await screen.findAllByText("Heartbeat");
        expect(scheduledJobRows.length).toBeGreaterThan(0);
        await act(async () => {
            await view.queryClient.invalidateQueries({
                queryKey: ["scheduled-jobs", "list"],
            });
        });

        expect(
            await screen.findByText(
                "Dashboard jobs refresh failed. Showing the last loaded jobs. Scheduled jobs temporarily unavailable"
            )
        ).toBeInTheDocument();
        expect(screen.getAllByText("Heartbeat").length).toBeGreaterThan(0);

        await user.click(screen.getByRole("button", { name: /openclaw cron/i }));
        const cronJobRows = await screen.findAllByText("heartbeat");
        expect(cronJobRows.length).toBeGreaterThan(0);
        await act(async () => {
            await view.queryClient.invalidateQueries({ queryKey: ["cron", "jobs"] });
        });

        expect(
            await screen.findByText(
                "OpenClaw cron refresh failed. Showing the last loaded jobs. Cron jobs temporarily unavailable"
            )
        ).toBeInTheDocument();
        expect(screen.getAllByText("heartbeat").length).toBeGreaterThan(0);

        view.unmount();
        view.queryClient.clear();
    });

    it("links git workspace repositories to GitHub remotes", async () => {
        const view = renderPage(createElement(Dashboard), { withSocket: true });

        const dashboardRepoLink = await screen.findByRole("link", {
            name: /open mira dashboard on github/i,
        });
        expect(dashboardRepoLink).toHaveAttribute(
            "href",
            "https://github.com/rajohan/Mira-Dashboard"
        );

        view.unmount();
        view.queryClient.clear();
    });

    it("drives settings backup, restart, skill toggle, and save flows", async () => {
        const user = userEvent.setup();
        const createObjectUrl = jest.fn(() => "blob:settings-backup");
        const revokeObjectUrl = jest.fn();
        const originalCreateObjectUrl = URL.createObjectURL;
        const originalRevokeObjectUrl = URL.revokeObjectURL;
        const anchorClick = jest
            .spyOn(HTMLAnchorElement.prototype, "click")
            .mockImplementation(() => {});

        try {
            Object.defineProperties(URL, {
                createObjectURL: {
                    configurable: true,
                    value: createObjectUrl,
                    writable: true,
                },
                revokeObjectURL: {
                    configurable: true,
                    value: revokeObjectUrl,
                    writable: true,
                },
            });
            renderPage(createElement(Settings));
            expect(await screen.findByText("Model Configuration")).toBeInTheDocument();

            await user.click(screen.getByRole("button", { name: /^backup$/i }));
            await waitFor(() => expect(createObjectUrl).toHaveBeenCalled());
            expect(anchorClick).toHaveBeenCalled();
            expect(revokeObjectUrl).toHaveBeenCalledWith("blob:settings-backup");

            await user.click(screen.getByRole("button", { name: /^session$/i }));
            await user.clear(screen.getByLabelText(/idle timeout/i));
            await user.type(screen.getByLabelText(/idle timeout/i), "45");
            await user.click(screen.getAllByRole("button", { name: /^save$/i }).at(-1)!);
            expect(await screen.findByText("Session settings saved")).toBeInTheDocument();

            await user.click(screen.getByRole("button", { name: /^heartbeat$/i }));
            await user.clear(screen.getByLabelText("Interval (seconds)"));
            await user.type(screen.getByLabelText("Interval (seconds)"), "120");
            await user.clear(screen.getByLabelText("Target Channel"));
            await user.type(screen.getByLabelText("Target Channel"), "ops-room");
            await user.click(screen.getAllByRole("button", { name: /^save$/i }).at(-1)!);
            expect(
                await screen.findByText("Heartbeat settings saved")
            ).toBeInTheDocument();

            await user.click(screen.getByRole("button", { name: /^skills$/i }));
            await user.click(
                screen.getByRole("switch", { name: "Toggle task-tracking" })
            );

            await user.click(screen.getByRole("button", { name: /^restart$/i }));
            const restartDialog = screen.getByRole("dialog", {
                name: "Restart Gateway",
            });
            const restartDialogButtons = [...restartDialog.querySelectorAll("button")];
            await user.click(restartDialogButtons.at(-1)!);
            await waitFor(() =>
                expect(
                    (
                        fetch as unknown as {
                            mock: { calls: Array<[string, RequestInit | undefined]> };
                        }
                    ).mock.calls.some(
                        ([url, init]) =>
                            url === "/api/restart" &&
                            (init as RequestInit | undefined)?.method === "POST"
                    )
                ).toBe(true)
            );

            const fetchCalls = (
                fetch as unknown as {
                    mock: { calls: Array<[string, RequestInit | undefined]> };
                }
            ).mock.calls;
            const configWrites = fetchCalls
                .filter(
                    ([url, init]) =>
                        url === "/api/config" && init?.method === "PUT" && init.body
                )
                .map(([, init]) => parseRequestBody(init));
            expect(configWrites).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({
                        __hash: "config-hash-1",
                        session: { reset: { idleMinutes: 45 } },
                    }),
                    expect.objectContaining({
                        __hash: "config-hash-1",
                        agents: {
                            list: [
                                {
                                    heartbeat: {
                                        every: "2m",
                                        target: "ops-room",
                                    },
                                    id: "ops",
                                },
                            ],
                        },
                    }),
                ])
            );
            expect(fetchCalls).toEqual(
                expect.arrayContaining([
                    [
                        "/api/skills/task-tracking",
                        expect.objectContaining({ method: "POST" }),
                    ],
                ])
            );
        } finally {
            anchorClick.mockRestore();
            Object.defineProperties(URL, {
                createObjectURL: {
                    configurable: true,
                    value: originalCreateObjectUrl,
                    writable: true,
                },
                revokeObjectURL: {
                    configurable: true,
                    value: originalRevokeObjectUrl,
                    writable: true,
                },
            });
        }
    });

    it("edits and runs Dashboard jobs plus OpenClaw cron jobs", async () => {
        const user = userEvent.setup();
        const view = renderPage(createElement(Jobs));

        await waitFor(() => {
            expect(screen.queryAllByText("Heartbeat").length).toBeGreaterThan(0);
            expect(screen.getByText("Run logs")).toBeInTheDocument();
        });

        const dashboardJobsButton = screen.getByRole("button", {
            name: /dashboard jobs/i,
        });
        const openClawCronButton = screen.getByRole("button", {
            name: /openclaw cron/i,
        });
        expect(dashboardJobsButton).toHaveAttribute("aria-pressed", "true");
        expect(openClawCronButton).toHaveAttribute("aria-pressed", "false");

        await user.clear(screen.getByLabelText("Interval seconds"));
        await user.type(screen.getByLabelText("Interval seconds"), "3600");
        await user.click(screen.getByRole("button", { name: /save schedule/i }));
        await waitFor(() => {
            expect(screen.getAllByText("Schedule: Every 1h").length).toBeGreaterThan(0);
        });

        await user.click(screen.getByRole("button", { name: /run now/i }));
        await waitFor(() => {
            expect(screen.getByText("manual run #2")).toBeInTheDocument();
            expect(screen.getByText(/manual ok/)).toBeInTheDocument();
        });

        await user.click(openClawCronButton);
        await waitFor(() => {
            expect(screen.queryAllByText("heartbeat").length).toBeGreaterThan(0);
            expect(screen.getByText("Job config")).toBeInTheDocument();
        });
        expect(dashboardJobsButton).toHaveAttribute("aria-pressed", "false");
        expect(openClawCronButton).toHaveAttribute("aria-pressed", "true");

        await user.click(screen.getByRole("button", { name: /trigger now/i }));
        await waitFor(() => {
            expect(screen.getByText(/Triggered/)).toBeInTheDocument();
        });

        await user.click(screen.getByLabelText("Enabled"));
        await user.click(screen.getByRole("button", { name: /^edit$/i }));
        await user.clear(screen.getByLabelText("Name"));
        await user.type(screen.getByLabelText("Name"), "heartbeat-updated");
        await user.click(screen.getByRole("button", { name: /save edits/i }));
        await waitFor(() => {
            expect(screen.getAllByText("heartbeat-updated").length).toBeGreaterThan(0);
        });

        await user.click(screen.getByRole("button", { name: /^delete$/i }));
        expect(
            screen.getByRole("heading", { name: "Delete cron job" })
        ).toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: /^delete cron job$/i }));
        await waitFor(() => {
            expect(screen.queryByText("Delete cron job")).not.toBeInTheDocument();
        });

        view.unmount();
        view.queryClient.clear();
    });

    it("drives pull request review, branch update, deploy, merge, and reject flows", async () => {
        const user = userEvent.setup();
        const view = renderPage(createElement(PullRequests));

        await waitFor(() => {
            expect(screen.getByText("Expand backend coverage")).toBeInTheDocument();
            expect(screen.getByText("Bump dashboard dependency")).toBeInTheDocument();
            expect(screen.getByText("Deploy dashboard")).toBeInTheDocument();
        });
        expect(screen.getAllByText("1 PR")).toHaveLength(2);
        expect(screen.getByText("Coverage body")).toBeInTheDocument();

        await user.click(screen.getByRole("button", { name: "Approve PR" }));
        expect(screen.getByRole("heading", { name: "Approve PR" })).toBeInTheDocument();
        await user.click(screen.getAllByRole("button", { name: "Approve PR" }).at(-1)!);
        await waitFor(() => {
            expect(screen.getByText("Approved PR #191")).toBeInTheDocument();
        });

        await user.click(screen.getByRole("button", { name: "Update branch" }));
        await waitFor(() => {
            expect(screen.getByText("Branch update queued")).toBeInTheDocument();
        });

        await user.click(screen.getByRole("button", { name: "Deploy latest main" }));
        expect(
            screen.getByRole("heading", { name: "Deploy latest main" })
        ).toBeInTheDocument();
        await user.click(
            screen.getAllByRole("button", { name: "Deploy latest main" }).at(-1)!
        );
        await waitFor(() => {
            expect(screen.getByText("Deploy scheduled")).toBeInTheDocument();
        });

        await user.click(screen.getAllByRole("button", { name: "Merge only" })[0]!);
        expect(screen.getByRole("heading", { name: "Merge PR" })).toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "Merge PR" }));
        await waitFor(() => {
            expect(screen.getByText(/Merged PR #190/)).toBeInTheDocument();
            expect(screen.getByText(/Cleaned worktree/)).toBeInTheDocument();
        });
        expect(screen.getByText("isOk")).toHaveClass("text-green-400");

        await user.click(screen.getAllByRole("button", { name: "Reject" })[0]!);
        expect(screen.getByRole("heading", { name: "Reject PR" })).toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "Reject PR" }));
        await waitFor(() => {
            expect(screen.getByText("Rejected PR #190")).toBeInTheDocument();
        });

        view.unmount();
        view.queryClient.clear();
    });

    it("shows when the Mira-authored pull request queue is clear", async () => {
        Object.defineProperty(globalThis, "fetch", {
            configurable: true,
            value: jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
                const url = String(input);
                if (url === "/api/pull-requests") {
                    return Response.json({
                        pullRequests: [
                            {
                                number: 191,
                                title: "Bump dashboard dependency",
                                url: "https://github.com/rajohan/Mira-Dashboard/pull/191",
                                headRefName: "dependabot/npm-and-yarn/pkg",
                                baseRefName: "main",
                                author: { login: "app/dependabot" },
                                createdAt: "2026-06-24T09:00:00.000Z",
                                updatedAt: "2026-06-24T09:05:00.000Z",
                                isDraft: false,
                                reviewDecision: "REVIEW_REQUIRED",
                                mergeStateStatus: "BEHIND",
                                mergeable: "MERGEABLE",
                                statusCheckRollup: [
                                    { status: "COMPLETED", conclusion: "SUCCESS" },
                                ],
                                additions: 4,
                                deletions: 1,
                                changedFiles: 1,
                                canReviewerApprove: true,
                                body: "Dependency update",
                            },
                        ],
                    });
                }

                const method = init?.method ?? "GET";
                return apiResponse(url, method, init);
            }),
            writable: true,
        });

        const view = renderPage(createElement(PullRequests));

        await waitFor(() => {
            expect(screen.getByText("No Mira-authored PRs waiting")).toBeInTheDocument();
            expect(screen.getByText("Bump dashboard dependency")).toBeInTheDocument();
        });
        expect(screen.getByText("Dependency / external PRs")).toBeInTheDocument();

        view.unmount();
        view.queryClient.clear();
    });

    it("explains when deploy actions are blocked by the production checkout", async () => {
        Object.defineProperty(globalThis, "fetch", {
            configurable: true,
            value: jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
                const url = String(input);
                if (url === "/api/pull-requests/production-checkout") {
                    return Response.json({
                        checkout: {
                            root: "/home/ubuntu/projects/mira-dashboard",
                            expectedRoot: "/home/ubuntu/projects/mira-dashboard",
                            worktreeRoot:
                                "/home/ubuntu/projects/mira-dashboard-worktrees",
                            branch: "main",
                            expectedBranch: "main",
                            head: "abc123",
                            isClean: false,
                            isProductionRoot: true,
                            isSafeForDeploy: false,
                            statusShort: " M src/App.tsx",
                        },
                    });
                }

                const method = init?.method ?? "GET";
                return apiResponse(url, method, init);
            }),
            writable: true,
        });

        const view = renderPage(createElement(PullRequests));

        await waitFor(() => {
            expect(screen.getByText("Dirty checkout")).toBeInTheDocument();
        });
        const deployButton = screen.getByRole("button", {
            name: "Deploy latest main",
        });
        expect(deployButton).toBeDisabled();
        expect(deployButton).toHaveAttribute(
            "aria-describedby",
            "deploy-checkout-disabled-reason"
        );
        expect(
            screen.getAllByText(
                "Deploy and merge are blocked until local changes in the production checkout are resolved."
            ).length
        ).toBeGreaterThan(1);

        view.unmount();
        view.queryClient.clear();
    });

    it("summarizes pull request checks from the latest record per check", async () => {
        Object.defineProperty(globalThis, "fetch", {
            configurable: true,
            value: jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
                const url = String(input);
                if (url === "/api/pull-requests") {
                    return Response.json({
                        pullRequests: [
                            {
                                number: 192,
                                title: "Refresh stale check handling",
                                url: "https://github.com/rajohan/Mira-Dashboard/pull/192",
                                headRefName: "mira/stale-check-handling",
                                baseRefName: "main",
                                author: { login: "mira-2026" },
                                createdAt: "2026-06-24T10:00:00.000Z",
                                updatedAt: "2026-06-24T10:10:00.000Z",
                                isDraft: false,
                                reviewDecision: "APPROVED",
                                mergeStateStatus: "CLEAN",
                                mergeable: "MERGEABLE",
                                statusCheckRollup: [
                                    {
                                        name: "Dashboard checks",
                                        status: "COMPLETED",
                                        conclusion: "FAILURE",
                                        completedAt: "2026-06-24T10:03:00.000Z",
                                    },
                                    {
                                        name: "Dashboard checks",
                                        status: "COMPLETED",
                                        conclusion: "SUCCESS",
                                        completedAt: "2026-06-24T10:08:00.000Z",
                                    },
                                ],
                                additions: 5,
                                deletions: 1,
                                changedFiles: 1,
                                reviewerApproved: true,
                                body: "Latest rerun passed.",
                            },
                        ],
                    });
                }

                const method = init?.method ?? "GET";
                return apiResponse(url, method, init);
            }),
            writable: true,
        });

        const view = renderPage(createElement(PullRequests));

        await waitFor(() => {
            expect(screen.getByText("Refresh stale check handling")).toBeInTheDocument();
            expect(screen.getByText("Checks passed")).toBeInTheDocument();
        });
        expect(screen.queryByText("Checks failed")).not.toBeInTheDocument();

        view.unmount();
        view.queryClient.clear();
    });

    it("drives logs page loading, searching, level filtering, and clearing", async () => {
        const user = userEvent.setup();
        const exportedBlobs: Blob[] = [];
        const createObjectUrl = jest.fn((blob: Blob) => {
            exportedBlobs.push(blob);
            return "blob:logs-export";
        });
        const revokeObjectUrl = jest.fn();
        const originalCreateObjectUrl = URL.createObjectURL;
        const originalRevokeObjectUrl = URL.revokeObjectURL;
        const anchorClick = jest
            .spyOn(HTMLAnchorElement.prototype, "click")
            .mockImplementation(() => {});
        let view: ReturnType<typeof renderPage> | undefined;

        try {
            Object.defineProperties(URL, {
                createObjectURL: {
                    configurable: true,
                    value: createObjectUrl,
                    writable: true,
                },
                revokeObjectURL: {
                    configurable: true,
                    value: revokeObjectUrl,
                    writable: true,
                },
            });
            view = renderPage(createElement(Logs), { withSocket: true });

            await waitFor(() => {
                expect(screen.getByText("openclaw.log")).toBeInTheDocument();
                expect(screen.getByText("2 entries")).toBeInTheDocument();
            });

            const duplicateFallbackLog = parseLogLine(
                JSON.stringify({
                    level: "info",
                    time: "2026-06-24T08:00:00.000Z",
                    msg: "dashboard ready",
                })
            );
            expect(duplicateFallbackLog).toBeDefined();
            await act(async () => {
                logsCollection.utils.writeUpsert(duplicateFallbackLog!);
                await Promise.resolve();
            });
            await waitFor(() => {
                expect(screen.getByText("3 entries")).toBeInTheDocument();
            });
            await user.click(screen.getByRole("button", { name: "Reload" }));
            await waitFor(() => {
                expect(screen.getByText("2 entries")).toBeInTheDocument();
            });
            await user.click(screen.getByRole("button", { name: "Export" }));
            const dedupedExport = await exportedBlobs.at(-1)?.text();
            expect(dedupedExport?.match(/dashboard ready/g)).toHaveLength(1);

            await user.click(screen.getByRole("button", { name: "100 lines" }));
            await user.click(screen.getByRole("menuitem", { name: "5000 lines" }));
            await waitFor(() => {
                expect(screen.getByText("3 entries")).toBeInTheDocument();
            });

            await user.click(screen.getByRole("button", { name: "Export" }));
            const expandedExport = await exportedBlobs.at(-1)?.text();
            expect(expandedExport).toContain("expanded tail only");
            expect(expandedExport?.indexOf("expanded tail only")).toBeLessThan(
                expandedExport?.indexOf("dashboard ready") ?? 0
            );

            const liveLog = parseLogLine(
                JSON.stringify({
                    level: "info",
                    time: "2026-06-24T08:02:00.000Z",
                    msg: "live after snapshot",
                }),
                "400"
            );
            const fallbackLiveLog = parseLogLine("fallback live after snapshot");
            expect(liveLog).toBeDefined();
            expect(fallbackLiveLog).toBeDefined();
            await act(async () => {
                logsCollection.utils.writeUpsert(liveLog!);
                logsCollection.utils.writeUpsert(fallbackLiveLog!);
                await Promise.resolve();
            });

            await user.click(screen.getByRole("button", { name: "5000 lines" }));
            await user.click(screen.getByRole("menuitem", { name: "100 lines" }));
            await waitFor(() => {
                expect(screen.getByText("4 entries")).toBeInTheDocument();
                expect(screen.queryByText("expanded tail only")).toBeNull();
            });
            await user.click(screen.getByRole("button", { name: "Export" }));
            const livePreservedExport = await exportedBlobs.at(-1)?.text();
            expect(livePreservedExport).toContain("live after snapshot");
            expect(livePreservedExport).toContain("fallback live after snapshot");
            expect(livePreservedExport).not.toContain("expanded tail only");

            await user.click(screen.getByRole("button", { name: "openclaw.log" }));
            await user.click(screen.getByRole("menuitem", { name: "archived.log" }));
            await waitFor(() => {
                expect(screen.getByText("1 entry")).toBeInTheDocument();
                expect(screen.queryByText("live after snapshot")).toBeNull();
            });
            await user.click(screen.getByRole("button", { name: "Export" }));
            const archivedExport = await exportedBlobs.at(-1)?.text();
            expect(archivedExport).toContain("archived dashboard ready");
            expect(archivedExport).not.toContain("live after snapshot");

            await user.click(screen.getByRole("button", { name: "archived.log" }));
            await user.click(screen.getByRole("menuitem", { name: "openclaw.log" }));
            await waitFor(() => {
                expect(screen.getByText("2 entries")).toBeInTheDocument();
            });

            const searchInput = screen.getByPlaceholderText("Search logs...");

            await user.type(searchInput, " failed ");
            await waitFor(() => {
                expect(screen.getByText(/1 of 2 entries/)).toBeInTheDocument();
            });

            await user.clear(searchInput);
            await user.type(searchInput, "missing");
            await waitFor(() => {
                expect(
                    screen.getByText("No logs match your filter.")
                ).toBeInTheDocument();
            });

            await user.clear(searchInput);
            await waitFor(() => {
                expect(screen.getByText("2 entries")).toBeInTheDocument();
            });

            await user.click(screen.getByRole("button", { name: "error" }));
            await waitFor(() => {
                expect(screen.getByText(/1 of 2 entries/)).toBeInTheDocument();
            });

            await user.click(screen.getByRole("button", { name: "error" }));
            await waitFor(() => {
                expect(screen.getByText("2 entries")).toBeInTheDocument();
            });

            logsApiState.simulateOpenclawTruncation = true;
            await user.click(screen.getByRole("button", { name: "Reload" }));
            await waitFor(() => {
                expect(screen.getByText("1 entry")).toBeInTheDocument();
                expect(screen.queryByText("live after snapshot")).toBeNull();
                expect(screen.queryByText("failed backup")).toBeNull();
            });
            await user.click(screen.getByRole("button", { name: "Export" }));
            const truncatedExport = await exportedBlobs.at(-1)?.text();
            expect(truncatedExport).toContain("truncated dashboard ready");
            expect(truncatedExport).not.toContain("live after snapshot");
            expect(truncatedExport).not.toContain("fallback live after snapshot");
            expect(truncatedExport).not.toContain("failed backup");

            await user.click(screen.getByRole("button", { name: "Clear" }));
            await waitFor(() => {
                expect(screen.getByText("Waiting for logs...")).toBeInTheDocument();
                expect(screen.queryByText("truncated dashboard ready")).toBeNull();
            });

            await user.click(screen.getByRole("button", { name: "openclaw.log" }));
            await user.click(screen.getByRole("menuitem", { name: "blank.log" }));
            await waitFor(() => {
                expect(screen.getByText("Waiting for logs...")).toBeInTheDocument();
                expect(screen.queryByText("dashboard ready")).toBeNull();
                expect(screen.queryByText("live after snapshot")).toBeNull();
            });
        } finally {
            view?.unmount();
            view?.queryClient.clear();
            anchorClick.mockRestore();
            Object.defineProperties(URL, {
                createObjectURL: {
                    configurable: true,
                    value: originalCreateObjectUrl,
                    writable: true,
                },
                revokeObjectURL: {
                    configurable: true,
                    value: originalRevokeObjectUrl,
                    writable: true,
                },
            });
        }
    });

    it("drives chat page session sync, history loading, diagnostics, and send ack", async () => {
        const user = userEvent.setup();
        const view = renderChatPage();

        await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
        const socket = FakeWebSocket.instances[0]!;

        await act(async () => {
            socket.emit("open");
            await Promise.resolve();
        });

        await waitFor(() => {
            expect(
                socket.sent.some((entry) => entry.includes('"method":"sessions.list"'))
            ).toBe(true);
        });
        await respondToSocketRequest(socket, "sessions.list", {
            sessions: [
                {
                    id: "session-main",
                    key: "agent:main:main",
                    type: "main",
                    agentType: "main",
                    displayLabel: "Main chat",
                    model: "codex",
                    tokenCount: 525,
                    maxTokens: 1000,
                    thinkingDefault: "low",
                    thinkingLevel: "medium",
                    thinkingLevels: [
                        { id: "low", label: "low" },
                        { id: "medium", label: "medium" },
                        { id: "high", label: "high" },
                    ],
                    verboseLevel: "compact",
                    updatedAt: "2026-06-24T08:00:00.000Z",
                },
            ],
        });
        await flushQueuedTimers();
        await waitFor(() => {
            expect(
                socket.sent.filter((entry) => entry.includes('"method":"chat.history"'))
            ).toHaveLength(1);
        });
        await respondToSocketRequest(socket, "chat.history", {
            messages: [
                {
                    role: "user",
                    content: "Previous question",
                    timestamp: "2026-06-24T08:00:00.000Z",
                },
                {
                    role: "assistant",
                    content: "Previous answer",
                    timestamp: "2026-06-24T08:00:01.000Z",
                },
            ],
        });
        await flushQueuedTimers();

        await waitFor(() => {
            expect(
                socket.sent.some((entry) => entry.includes('"method":"models.list"'))
            ).toBe(true);
        });
        await respondToSocketRequest(socket, "models.list", {
            models: [{ id: "codex", label: "Codex" }],
        });
        await flushQueuedTimers();

        expect(findSocketRequest(socket, "chat.history")?.params).toMatchObject({
            sessionKey: "agent:main:main",
        });

        await waitFor(() => {
            expect(
                screen.getByText(/MAIN · codex · Context: 0.5k \/ 1k \(53%\)/)
            ).toBeInTheDocument();
        });

        await user.click(screen.getByLabelText("Model and response settings"));
        await user.click(screen.getByRole("button", { name: "Thinking: medium" }));
        await user.click(screen.getByRole("menuitem", { name: "high" }));
        await waitFor(() => {
            expect(
                socket.sent.filter((entry) => entry.includes('"method":"sessions.patch"'))
            ).toHaveLength(1);
        });
        expect(
            socket.sent
                .map(
                    (entry) => JSON.parse(entry) as { method?: string; params?: unknown }
                )
                .findLast((entry) => entry.method === "sessions.patch")?.params
        ).toEqual({
            key: "agent:main:main",
            thinkingLevel: "high",
        });
        await respondToSocketRequest(socket, "sessions.patch", {});
        await flushQueuedTimers();

        await user.click(screen.getByRole("button", { name: "Speed: Default" }));
        await user.click(screen.getByRole("menuitem", { name: "Fast" }));
        await waitFor(() => {
            expect(
                socket.sent.filter((entry) => entry.includes('"method":"sessions.patch"'))
            ).toHaveLength(2);
        });
        expect(
            socket.sent
                .map(
                    (entry) => JSON.parse(entry) as { method?: string; params?: unknown }
                )
                .findLast((entry) => entry.method === "sessions.patch")?.params
        ).toEqual({
            fastMode: true,
            key: "agent:main:main",
        });
        await user.type(
            screen.getByPlaceholderText(
                "Message, attach files, or use / commands (try /help)"
            ),
            "Ship it"
        );
        expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
        await respondToSocketRequest(socket, "sessions.patch", {});
        await flushQueuedTimers();

        await waitFor(() => {
            expect(screen.getByRole("button", { name: "Send" })).toBeEnabled();
        });

        await user.click(screen.getByRole("button", { name: "Chat display settings" }));
        const thinkingToggle = screen.getByRole("button", { name: "Show thinking" });
        const toolsToggle = screen.getByRole("button", { name: "Show tools" });
        await user.click(thinkingToggle);
        await user.click(toolsToggle);
        expect(thinkingToggle).toHaveAttribute("aria-pressed", "true");
        expect(toolsToggle).toHaveAttribute("aria-pressed", "true");
        const keepThinkingToggle = screen.getByRole("button", {
            name: "Keep thinking after final answer",
        });
        await user.click(keepThinkingToggle);
        expect(keepThinkingToggle).toHaveAttribute("aria-pressed", "true");
        await user.click(thinkingToggle);
        expect(thinkingToggle).toHaveAttribute("aria-pressed", "false");
        expect(keepThinkingToggle).toHaveAttribute("aria-pressed", "true");
        expect(keepThinkingToggle).toBeDisabled();
        await user.click(thinkingToggle);
        expect(keepThinkingToggle).toHaveAttribute("aria-pressed", "true");
        const toolDetailsToggle = screen.getByRole("button", {
            name: "Expand tool call details",
        });
        expect(toolDetailsToggle).toHaveAttribute("aria-pressed", "false");
        await user.click(toolDetailsToggle);
        expect(toolDetailsToggle).toHaveAttribute("aria-pressed", "true");

        await user.click(screen.getByRole("button", { name: "Send" }));

        await waitFor(() => {
            expect(
                socket.sent.filter((entry) => entry.includes('"method":"sessions.patch"'))
            ).toHaveLength(3);
        });
        await respondToSocketRequest(socket, "sessions.patch", {});
        await flushQueuedTimers();

        await waitFor(() => {
            expect(
                socket.sent.some((entry) => entry.includes('"method":"chat.send"'))
            ).toBe(true);
        });
        const chatSendRequest = socket.sent
            .map((entry) => JSON.parse(entry) as { method?: string; params?: unknown })
            .find(
                (entry) =>
                    entry.method === "chat.send" &&
                    (entry.params as { message?: string } | undefined)?.message ===
                        "Ship it"
            );
        expect(chatSendRequest?.params).toMatchObject({
            sessionKey: "agent:main:main",
            sessionId: "session-main",
            message: "Ship it",
        });
        expect(screen.getByRole("button", { name: "Stop" })).toBeEnabled();
        await respondToSocketRequest(socket, "chat.send", { runId: "run-123" });
        await flushQueuedTimers();

        await waitFor(() => {
            expect(
                screen.getByPlaceholderText(
                    "Message, attach files, or use / commands (try /help)"
                )
            ).toHaveValue("");
        });

        const composer = screen.getByPlaceholderText(
            "Message, attach files, or use / commands (try /help)"
        );
        await user.type(composer, "Follow up after stop");
        await user.click(screen.getByRole("button", { name: "Stop" }));
        await waitFor(() => {
            expect(
                socket.sent.some((entry) => entry.includes('"method":"chat.abort"'))
            ).toBe(true);
        });
        expect(composer).toHaveValue("Follow up after stop");
        expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
        await respondToSocketRequest(socket, "chat.abort", {});
        await flushQueuedTimers();
        await waitFor(() => {
            expect(screen.getByRole("button", { name: "Send" })).toBeEnabled();
        });
        await user.clear(composer);

        const fileInput = view.container.querySelector<HTMLInputElement>(
            'input[type="file"][multiple]'
        );
        expect(fileInput).not.toBeNull();
        fireEvent.change(fileInput!, {
            target: {
                files: [
                    new File(["failed attachment"], "failed.txt", {
                        type: "text/plain",
                    }),
                ],
            },
        });
        await flushQueuedTimers();
        await waitFor(() => {
            expect(screen.getByText("failed.txt")).toBeInTheDocument();
        });
        await user.click(screen.getByRole("button", { name: "Send" }));

        await waitFor(() => {
            expect(
                socket.sent.filter((entry) => entry.includes('"method":"sessions.patch"'))
            ).toHaveLength(4);
        });
        await respondToSocketRequest(socket, "sessions.patch", {});
        await flushQueuedTimers();

        await waitFor(() => {
            expect(
                socket.sent.filter((entry) => entry.includes('"method":"chat.send"'))
            ).toHaveLength(2);
        });
        await respondToSocketRequest(socket, "chat.send", undefined, false);
        await flushQueuedTimers();

        await waitFor(() => {
            expect(screen.queryByText("failed.txt")).not.toBeInTheDocument();
            expect(screen.getByText("Failed to send message")).toBeInTheDocument();
        });
        await act(async () => {
            socket.emit("error");
            await Promise.resolve();
        });
        await user.click(screen.getByRole("button", { name: "Dismiss error" }));
        expect(screen.queryByText("Failed to send message")).not.toBeInTheDocument();
        expect(screen.getByText("WebSocket connection failed")).toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "Dismiss error" }));
        expect(screen.queryByText("WebSocket connection failed")).not.toBeInTheDocument();

        view.unmount();
        view.queryClient.clear();
    }, 10_000);

    it("clears chat history loading when the selected session disappears", async () => {
        const view = renderChatPage();

        await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
        const socket = FakeWebSocket.instances[0]!;

        await act(async () => {
            socket.emit("open");
            await Promise.resolve();
        });

        await waitFor(() => {
            expect(
                socket.sent.some((entry) => entry.includes('"method":"sessions.list"'))
            ).toBe(true);
        });
        await respondToSocketRequest(socket, "sessions.list", {
            sessions: [
                {
                    id: "session-main",
                    key: "agent:main:main",
                    type: "main",
                    agentType: "main",
                    displayLabel: "Main chat",
                    model: "codex",
                    updatedAt: "2026-06-24T08:00:00.000Z",
                },
            ],
        });

        await waitFor(() => {
            expect(
                socket.sent.some((entry) => entry.includes('"method":"chat.history"'))
            ).toBe(true);
        });
        expect(screen.getByText(/Loading chat/)).toBeInTheDocument();

        await act(async () => {
            socket.emit("message", {
                data: JSON.stringify({ type: "state", sessions: [] }),
            });
            await Promise.resolve();
        });

        await waitFor(() => {
            expect(screen.queryByText(/Loading chat/)).not.toBeInTheDocument();
        });

        view.unmount();
        view.queryClient.clear();
    });

    it("restores the selected chat session from the URL and follows URL changes", async () => {
        const user = userEvent.setup();
        const view = renderChatPage("/chat?session=agent%3Aops%3Amain%3Aheartbeat");
        const chatRouter = view.router;

        await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
        const socket = FakeWebSocket.instances[0]!;
        await act(async () => {
            socket.emit("open");
            await Promise.resolve();
        });

        await waitFor(() => {
            expect(findSocketRequest(socket, "chat.history")?.params).toMatchObject({
                sessionKey: "agent:ops:main:heartbeat",
            });
        });
        await respondToSocketRequest(socket, "chat.history", { messages: [] });
        await respondToSocketRequest(socket, "sessions.list", {
            sessions: [
                {
                    agentType: "main",
                    displayLabel: "Main chat",
                    id: "session-main",
                    key: "agent:main:main",
                    model: "codex",
                    type: "main",
                    updatedAt: "2026-07-19T18:00:00.000Z",
                },
                {
                    agentType: "ops",
                    displayLabel: "Heartbeat",
                    id: "session-heartbeat",
                    key: "agent:ops:main:heartbeat",
                    model: "synthetic",
                    type: "heartbeat",
                    updatedAt: "2026-07-19T17:00:00.000Z",
                },
            ],
        });
        await flushQueuedTimers();

        await waitFor(() => {
            expect(
                screen.getByRole("button", { name: "Session: main:heartbeat" })
            ).toBeInTheDocument();
        });
        expect(chatRouter.state.location.search).toEqual({
            session: "agent:ops:main:heartbeat",
        });

        const historyRequestsBeforeSelection = socket.sent.filter((entry) =>
            entry.includes('"method":"chat.history"')
        ).length;
        await user.click(screen.getByRole("button", { name: "Agent: ops" }));
        await user.click(screen.getByRole("menuitem", { name: /^main\b/i }));
        await waitFor(() => {
            expect(
                screen.getByRole("button", { name: "Session: main" })
            ).toBeInTheDocument();
            expect(findSocketRequest(socket, "chat.history")?.params).toMatchObject({
                sessionKey: "agent:main:main",
            });
        });
        await flushQueuedTimers();
        const selectedSessionHistoryRequests = socket.sent
            .filter((entry) => entry.includes('"method":"chat.history"'))
            .slice(historyRequestsBeforeSelection)
            .map((entry) => {
                const request = JSON.parse(entry) as {
                    params?: { sessionKey?: string };
                };
                return request.params?.sessionKey;
            });
        expect(selectedSessionHistoryRequests).toEqual(["agent:main:main"]);

        view.unmount();
        view.queryClient.clear();
    });

    it("does not enable sending for an unknown URL-selected session", async () => {
        const user = userEvent.setup();
        const view = renderChatPage("/chat?session=agent%3Amissing%3Amain");

        await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
        const socket = FakeWebSocket.instances[0]!;
        await act(async () => {
            socket.emit("open");
            await Promise.resolve();
        });
        await respondToSocketRequest(socket, "chat.history", { messages: [] });
        await respondToSocketRequest(socket, "sessions.list", {
            sessions: [
                {
                    agentType: "main",
                    displayLabel: "Main chat",
                    id: "session-main",
                    key: "agent:main:main",
                    model: "codex",
                    type: "main",
                    updatedAt: "2026-07-19T18:00:00.000Z",
                },
            ],
        });
        await flushQueuedTimers();

        expect(view.router.state.location.search).toEqual({
            session: "agent:missing:main",
        });

        const composer = screen.getByPlaceholderText(
            "Message, attach files, or use / commands (try /help)"
        );
        await user.type(composer, "Do not send this");
        expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();

        view.unmount();
        view.queryClient.clear();
    });

    it("renders sessions page connection state with a socket provider", async () => {
        const user = userEvent.setup();
        const view = renderPage(createElement(Sessions), { withSocket: true });

        await waitFor(() => {
            expect(screen.getByText("Connecting to OpenClaw...")).toBeInTheDocument();
            expect(FakeWebSocket.instances).toHaveLength(1);
        });
        await act(async () => {
            FakeWebSocket.instances[0]?.emit("open");
        });
        FakeWebSocket.instances[0]?.respondToLastRequest({ sessions: [] });
        await waitFor(() =>
            expect(
                screen.queryByText("Connecting to OpenClaw...")
            ).not.toBeInTheDocument()
        );
        expect(screen.getByText("No sessions found")).toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "CRON" }));
        expect(screen.getByText("No CRON sessions found")).toBeInTheDocument();
        await act(async () => {
            FakeWebSocket.instances[0]?.close();
        });
        await waitFor(() =>
            expect(screen.getByText("Connecting to OpenClaw...")).toBeInTheDocument()
        );
        view.unmount();
        view.queryClient.clear();
    });

    it("drives terminal page command history, cwd changes, completions, stop, and clear", async () => {
        const user = userEvent.setup();
        const view = renderPage(createElement(Terminal));

        await waitFor(() => {
            expect(screen.getByRole("log")).toHaveTextContent(
                "Welcome to Mira Dashboard Terminal."
            );
        });

        const commandInput = screen.getByRole("textbox", {
            name: /terminal command/i,
        });

        await user.type(commandInput, "pwd");
        await user.keyboard("{Enter}");
        await flushQueuedTimers();
        await waitFor(() => {
            expect(screen.getByText("/home/ubuntu")).toBeInTheDocument();
        });

        await user.type(commandInput, "cd /missing");
        await user.keyboard("{Enter}");
        await flushQueuedTimers();
        await waitFor(() => {
            expect(screen.getByText("Not a directory")).toBeInTheDocument();
        });

        await user.type(commandInput, "cd /tmp");
        await user.keyboard("{Enter}");
        await flushQueuedTimers();
        await waitFor(() => {
            expect(screen.getByText("/tmp")).toBeInTheDocument();
        });

        await user.type(commandInput, "ec");
        await user.keyboard("{Tab}");
        await waitFor(() => {
            expect(commandInput).toHaveValue("echo ");
        });
        await user.type(commandInput, "hello");
        await user.keyboard("{Enter}");
        await flushQueuedTimers();

        const stopButton = await screen.findByRole("button", { name: /stop/i });
        expect(commandInput).toBeDisabled();
        clickElement(stopButton);
        await waitFor(() => {
            expect(screen.getByText("ok")).toBeInTheDocument();
            expect(screen.getByRole("log")).toHaveTextContent("Exit code: 0");
        });

        await user.keyboard("{ArrowUp}");
        expect(commandInput).toHaveValue("echo hello");
        await user.keyboard("{ArrowDown}");
        expect(commandInput).toHaveValue("");

        clickElement(screen.getByRole("button", { name: /clear/i }));
        await waitFor(() => {
            expect(screen.getByRole("log")).toHaveTextContent(
                "Welcome to Mira Dashboard Terminal."
            );
        });

        view.unmount();
        view.queryClient.clear();
    });

    it("drives docker page container, updater, prune, delete, and console flows", async () => {
        const user = userEvent.setup();
        const fetchMock = fetch as unknown as ReturnType<typeof jest.fn>;

        const view = renderPage(createElement(Docker));

        await waitFor(() => {
            expect(screen.getByText("Updater overview")).toBeInTheDocument();
        });
        await waitFor(() => {
            expect(screen.getAllByText("8.5%").length).toBeGreaterThan(0);
            expect(screen.getAllByText("268 MB").length).toBeGreaterThan(0);
        });

        clickElement(screen.getByRole("button", { name: /run updater now/i }));
        await waitFor(() => {
            expect(screen.getByText(/"isSuccess": true/i)).toBeInTheDocument();
        });

        clickElement(screen.getByRole("button", { name: /update now/i }));
        expect(screen.getByText("Run manual update")).toBeInTheDocument();
        clickElement(screen.getByRole("button", { name: /^update now$/i }));
        await waitFor(() => {
            expect(
                screen.getByText(/Manual updater run finished\. updated=1 failed=0/i)
            ).toBeInTheDocument();
        });

        clickElement(screen.getByRole("button", { name: /dismiss/i }));
        expect(
            screen.queryByText(/Manual updater run finished/i)
        ).not.toBeInTheDocument();

        clickElement(screen.getByRole("button", { name: /restart stack/i }));
        await waitFor(() => {
            expect(screen.getByText("stack restarted")).toBeInTheDocument();
        });

        clickElement(screen.getAllByLabelText(/restart dashboard/i)[0]!);
        await waitFor(() => {
            expect(screen.getByText("container action output")).toBeInTheDocument();
        });

        clickElement(screen.getAllByLabelText(/show logs for dashboard/i)[0]!);
        expect(await screen.findByText("dashboard log line")).toBeInTheDocument();
        clickElement(screen.getByRole("button", { name: "200 lines" }));
        clickElement(screen.getByRole("menuitem", { name: "500 lines" }));
        await waitFor(() => {
            expect(screen.getByText("more dashboard log lines")).toBeInTheDocument();
        });
        clickElement(screen.getByLabelText(/close dashboard logs/i));
        await waitFor(() => {
            expect(screen.queryByRole("dialog", { name: /dashboard logs/i })).toBeNull();
        });

        clickElement(screen.getAllByLabelText(/open console for dashboard/i)[0]!);
        const consoleCommandInput = screen.getByPlaceholderText(
            /command to run inside container/i
        );
        expect(consoleCommandInput.parentElement?.parentElement).toHaveClass(
            "min-w-0",
            "flex-1"
        );
        expect(screen.getByRole("button", { name: "Send" }).parentElement).toHaveClass(
            "sm:min-w-44",
            "sm:items-center"
        );
        await user.type(consoleCommandInput, "echo hello{enter}");
        await waitFor(() => {
            expect(fetchMock).toHaveBeenCalledWith(
                "/api/docker/exec/start",
                expect.objectContaining({ method: "POST" })
            );
        });
        clickElement(screen.getByLabelText(/close dashboard console/i));
        await waitFor(() => {
            expect(
                screen.queryByRole("dialog", { name: /dashboard console/i })
            ).toBeNull();
        });

        clickElement(screen.getByLabelText(/open details for dashboard/i));
        expect(await screen.findByText("Networks")).toBeInTheDocument();
        expect(screen.getByText("MAC: 02:42:ac:14:00:02")).toBeInTheDocument();
        clickElement(screen.getByLabelText(/close dashboard/i));

        clickElement(screen.getAllByRole("button", { name: /remove unused/i })[0]!);
        await waitFor(() => {
            expect(screen.getByText("pruned")).toBeInTheDocument();
        });

        clickElement(
            screen.getAllByRole("button", { name: /delete unused:<none>/i })[0]!
        );
        expect(screen.getByText("Delete image")).toBeInTheDocument();
        clickElement(screen.getByRole("button", { name: /^delete$/i }));
        await waitFor(() => {
            expect(screen.getByText(/Deleted Docker image/i)).toBeInTheDocument();
        });

        clickElement(
            screen.getAllByRole("button", { name: /delete unused-volume/i })[0]!
        );
        expect(screen.getByText("Delete volume")).toBeInTheDocument();
        clickElement(screen.getByRole("button", { name: /^delete$/i }));
        await waitFor(() => {
            expect(
                screen.getByText(/Deleted Docker volume unused-volume/i)
            ).toBeInTheDocument();
        });

        expect(fetchMock).toHaveBeenCalledWith(
            "/api/docker/exec/start",
            expect.objectContaining({ method: "POST" })
        );
        view.unmount();
        view.queryClient.clear();
    }, 10_000);

    it("shows Docker console start failures in the action output pane", async () => {
        const user = userEvent.setup();
        const fetchMock = jest.fn(
            async (input: RequestInfo | URL, init?: RequestInit) => {
                const url = String(input);
                const method = init?.method ?? "GET";
                if (method === "POST" && url === "/api/docker/exec/start") {
                    return Response.json(
                        { error: "console unavailable" },
                        { status: 503 }
                    );
                }

                return apiResponse(url, method, init);
            }
        );
        Object.defineProperty(globalThis, "fetch", {
            configurable: true,
            value: fetchMock,
            writable: true,
        });

        const view = renderPage(createElement(Docker));

        await waitFor(() => {
            expect(screen.getByText("Updater overview")).toBeInTheDocument();
        });
        await waitFor(() => {
            expect(screen.getAllByText("8.5%").length).toBeGreaterThan(0);
            expect(screen.getAllByText("268 MB").length).toBeGreaterThan(0);
        });

        clickElement(screen.getAllByLabelText(/open console for dashboard/i)[0]!);
        await user.type(
            screen.getByPlaceholderText(/command to run inside container/i),
            "echo hello{enter}"
        );

        const consoleDialog = screen.getByRole("dialog", { name: /dashboard console/i });
        expect(
            within(consoleDialog).getByText(/Failed to start Docker console/i)
        ).toBeInTheDocument();
        expect(
            within(consoleDialog).getByText(/console unavailable/i)
        ).toBeInTheDocument();
        view.unmount();
        view.queryClient.clear();
    });

    it("clears stale Docker detail stats when live container stats are absent", async () => {
        const fetchMock = jest.fn(
            async (input: RequestInfo | URL, init?: RequestInit) => {
                const url = String(input);
                const method = init?.method ?? "GET";

                if (url === "/api/cache/docker.summary" && method === "GET") {
                    const response = await apiResponse(url, method, init);
                    const payload = (await response.json()) as Record<string, unknown>;
                    const data = payload.data as {
                        containers: Array<Record<string, unknown>>;
                    };
                    return Response.json({
                        ...payload,
                        data: {
                            ...data,
                            containers: data.containers.map((container) => ({
                                ...container,
                                stats: undefined,
                            })),
                        },
                    });
                }

                if (url === "/api/docker/containers/stats" && method === "GET") {
                    return Response.json({ stats: [] });
                }

                return apiResponse(url, method, init);
            }
        );
        Object.defineProperty(globalThis, "fetch", {
            configurable: true,
            value: fetchMock,
            writable: true,
        });

        const view = renderPage(createElement(Docker));

        await waitFor(() => {
            expect(screen.getByText("Updater overview")).toBeInTheDocument();
        });
        await waitFor(() => {
            expect(
                fetchMock.mock.calls.some(
                    ([url]) => String(url) === "/api/docker/containers/stats"
                )
            ).toBe(true);
        });
        await flushQueuedTimers();

        clickElement(screen.getByLabelText(/open details for dashboard/i));

        const detailsDialog = await screen.findByRole("dialog", {
            name: /dashboard/i,
        });
        expect(within(detailsDialog).getByText("CPU: —")).toBeInTheDocument();
        expect(within(detailsDialog).getByText("Memory: —")).toBeInTheDocument();
        view.unmount();
        view.queryClient.clear();
    });

    it("keeps chat page storage and history helpers deterministic", () => {
        localStorage.removeItem("mira-dashboard-chat-diagnostic-visibility");
        const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
        try {
            Reflect.deleteProperty(globalThis, "window");
            expect(readStoredChatDiagnosticVisibility()).toEqual({
                keepThinkingAfterFinal: false,
                thinking: false,
                toolDetailsExpanded: false,
                tools: false,
            });
        } finally {
            if (originalWindow) {
                Object.defineProperty(globalThis, "window", originalWindow);
            }
        }

        expect(readDeletedMessageKeys("agent:main:main")).toEqual(new Set());

        expect(
            addDeletedMessageKeys(new Set(["current"]), ["scoped", "history"])
        ).toEqual(new Set(["current", "scoped", "history"]));

        writeDeletedMessageKeys("agent:main:main", new Set(["message-1"]));
        expect(readDeletedMessageKeys("agent:main:main")).toEqual(new Set(["message-1"]));
        localStorage.setItem("openclaw:deleted:agent:main:main", "{bad json");
        expect(readDeletedMessageKeys("agent:main:main")).toEqual(new Set());

        expect(sessionTimestampMs("2026-06-24T08:00:00.000Z")).toBeGreaterThan(0);
        expect(sessionTimestampMs(NaN)).toBeUndefined();

        expect(shouldStayAtHistoryBottom(false, true, false)).toBe(true);
        expect(shouldStayAtHistoryBottom(false, false, false)).toBe(false);
        expect(nextHistoryLoadSendError("old", true, "new")).toBe("old");
        expect(nextHistoryLoadSendError(undefined, false, "new")).toBe("new");
        const unchangedTimestamp = "2026-06-24T08:00:00.000Z";
        expect(
            nextRefreshedChatMessages(
                [
                    {
                        content: "old",
                        role: "assistant",
                        text: "old",
                        timestamp: unchangedTimestamp,
                    },
                ],
                [
                    {
                        content: "new",
                        role: "assistant",
                        text: "new",
                        timestamp: unchangedTimestamp,
                    },
                ]
            )[0]?.text
        ).toBe("new");
        expect(isSessionActive(undefined)).toBe(false);
        expect(
            isSessionActive({ status: "running" } as Parameters<
                typeof isSessionActive
            >[0])
        ).toBe(true);
        expect(
            isSessionActive({ activeRunId: "run-1" } as Parameters<
                typeof isSessionActive
            >[0])
        ).toBe(true);
        expect(
            isSessionActive({ hasActiveRun: true } as Parameters<
                typeof isSessionActive
            >[0])
        ).toBe(true);
        expect(
            isSessionActive({ currentRunId: "run-2" } as Parameters<
                typeof isSessionActive
            >[0])
        ).toBe(true);
        expect(
            isSessionActive({
                activeRunId: "stale-run",
                currentRunId: "stale-current-run",
                endedAt: "2026-06-24T08:01:00.000Z",
                status: "running",
            } as Parameters<typeof isSessionActive>[0])
        ).toBe(false);

        const scheduled: string[] = [];
        didScheduleBottomFollow(true, () => {
            scheduled.push("bottom");
        });
        didScheduleBottomFollow(false, () => {
            scheduled.push("skipped");
        });
        expect(scheduled).toEqual(["bottom"]);
    });

    it("preserves stored final-thinking retention while thinking is hidden", () => {
        localStorage.setItem(
            "mira-dashboard-chat-diagnostic-visibility",
            JSON.stringify({
                keepThinkingAfterFinal: true,
                thinking: false,
                toolDetailsExpanded: false,
                tools: true,
            })
        );

        expect(readStoredChatDiagnosticVisibility()).toEqual({
            keepThinkingAfterFinal: true,
            thinking: false,
            toolDetailsExpanded: false,
            tools: true,
        });
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
