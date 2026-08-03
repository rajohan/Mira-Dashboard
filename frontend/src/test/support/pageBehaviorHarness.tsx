import { expect, jest } from "bun:test";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
    createMemoryHistory,
    createRootRoute,
    createRoute,
    createRouter,
    RouterProvider,
} from "@tanstack/react-router";
import { act, fireEvent, render } from "@testing-library/react";
import { createElement, type ReactNode } from "react";

import type { CacheEnvelope } from "../../../../contracts/cache";
import { canonicalizeOpenClawHistoryPage } from "../../../../contracts/chat/openClawHistoryPageAdapter";
import type { Metrics } from "../../../../contracts/metrics";
import type { Session } from "../../../../contracts/sessions";
import { requestBodyText } from "../../../../test/support/fetch";
import { logsCollection } from "../../collections/logs";
import { sessionsCollection } from "../../collections/sessions";
import { OpenClawSocketProvider } from "../../hooks/useOpenClawSocket";
import { Chat } from "../../pages/Chat";
import { normalizeChatSearch } from "../../router";
export type FakeWebSocketListener = (event?: { data?: string }) => void;
interface SocketRequestTestDouble {
    emit(type: string, event?: { data?: string }): void;
    readonly respondedRequestIds: Set<string>;
    readonly sent: string[];
}
function dashboardSessionFixture(
    overrides: Partial<Session> & Pick<Session, "id" | "key" | "type">
): Session {
    return {
        agentType: "",
        channel: "unknown",
        displayLabel: "",
        displayName: "",
        hookName: "",
        label: "",
        maxTokens: 0,
        model: "Unknown",
        tokenCount: 0,
        ...overrides,
    };
}

function cacheEnvelopeFixture<T>(
    key: string,
    data: T,
    overrides: Partial<Omit<CacheEnvelope<T>, "data" | "key">> = {}
): CacheEnvelope<T> {
    return {
        consecutiveFailures: 0,
        data,
        errorCode: null,
        errorMessage: null,
        expiresAt: null,
        key,
        lastAttemptAt: "2026-06-24T08:00:00.000Z",
        meta: {},
        source: "backend",
        status: "fresh",
        updatedAt: "2026-06-24T08:00:00.000Z",
        ...overrides,
    };
}

function resetLogsCollectionForTest() {
    if (!logsCollection.isReady()) {
        return;
    }
    const keys = Array.from(logsCollection, ([key]) => key);
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
    const keys = Array.from(sessionsCollection, ([key]) => key);
    if (keys.length === 0) {
        return;
    }
    sessionsCollection.utils.writeBatch(() => {
        sessionsCollection.utils.writeDelete(keys);
    });
}

async function emitNormalizedSessions(
    socket: SocketRequestTestDouble,
    sessions: Session[]
): Promise<void> {
    await act(async () => {
        socket.emit("message", {
            data: JSON.stringify({
                sessions,
                type: "sessions",
            }),
        });
        await Promise.resolve();
    });
}

function findSocketRequest(socket: SocketRequestTestDouble, method: string) {
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
    return JSON.parse(requestBodyText(init?.body, "{}")) as Record<string, unknown>;
}

function dashboardMetricsResponse(): Metrics {
    return {
        cacheRefresh: {
            active: 0,
            averageDurationMs: 4,
            coalesced: 0,
            failures: 0,
            lastDurationMs: 4,
            maxDurationMs: 4,
            refreshes: 1,
            requests: 1,
            totalDurationMs: 4,
        },
        chat: {
            persistence: {
                writeAttempts: 4,
                writeFailures: 0,
                writes: 4,
                writesPerMinute: 2,
            },
            replay: {
                currentBytes: 2048,
                events: 12,
                maxBytes: 16_777_216,
                memoryEvictions: 0,
                peakBytes: 4096,
                runs: 2,
                sessionEvictions: 0,
                sessions: 1,
            },
        },
        cpu: {
            count: 4,
            loadAvg: [0.1, 0.2, 0.3],
            loadPercent: 5,
            model: "test cpu",
        },
        database: {
            available: true,
            averageDurationMs: 1,
            fileBytes: 4096,
            freelistBytes: 0,
            freelistPages: 0,
            freelistPercent: 0,
            latencyMs: 0.5,
            lockErrors: 0,
            maxDurationMs: 1,
            operations: 1,
            shmBytes: 0,
            walBytes: 0,
        },
        disk: {
            percent: 25,
            total: 1000,
            totalGB: 1000,
            used: 250,
            usedGB: 250,
        },
        gateway: {
            connectFailures: 0,
            connected: true,
            connections: 1,
            disconnects: 0,
            pendingRequests: 0,
            reconnects: 0,
        },
        http: {
            averageDurationMs: 1,
            errors: 0,
            maxDurationMs: 1,
            requests: 1,
            routes: [],
        },
        memory: {
            free: 60,
            percent: 40,
            total: 100,
            totalGB: 100,
            used: 40,
            usedGB: 40,
        },
        network: {
            downloadMbps: 1,
            uploadMbps: 2,
        },
        polling: {
            snapshots: [],
        },
        processes: {
            active: 0,
            averageDurationMs: 1,
            failed: 0,
            lastDurationMs: 1,
            maxDurationMs: 1,
            started: 1,
            succeeded: 1,
            totalDurationMs: 1,
        },
        runtime: {
            eventLoopDelayMs: 0.25,
            externalBytes: 1024,
            heapTotalBytes: 4096,
            heapUsedBytes: 2048,
            rssBytes: 8192,
            uptimeSeconds: 120,
        },
        scheduler: {
            activeResourceClasses: [],
            dueJobs: 0,
            executorActive: true,
            executorTickRunning: false,
            lastTickDurationMs: 1,
            queueFailures: 0,
            queued: 0,
            running: 0,
            scheduleLagMs: 0,
            schedulerActive: true,
            schedulerTickRunning: false,
            tickFailures: 0,
            ticks: 1,
            workerCapacity: 2,
            workerCount: 1,
            workerOnline: true,
        },
        system: {
            uptime: 120,
            hostname: "dashboard-test",
            platform: "linux",
        },
        timestamp: 1_719_216_000_000,
        tokens: {
            total: 42,
            byModel: {
                codex: 42,
            },
            sessionsByModel: {
                codex: 1,
            },
            byAgent: [
                {
                    label: "Mira",
                    model: "codex",
                    tokens: 42,
                    type: "MAIN",
                },
            ],
        },
    };
}

function renderPage(
    children: ReactNode,
    options: {
        withRouter?: boolean;
        withSocket?: boolean;
    } = {}
) {
    const queryClient = new QueryClient({
        defaultOptions: {
            queries: {
                retry: false,
                staleTime: Infinity,
            },
            mutations: {
                retry: false,
            },
        },
    });
    const content = options.withSocket
        ? createElement(OpenClawSocketProvider, undefined, children)
        : children;
    if (options.withRouter) {
        const rootRoute = createRootRoute();
        const pageRoute = createRoute({
            component: () => content,
            getParentRoute: () => rootRoute,
            path: "/settings",
        });
        const router = createRouter({
            history: createMemoryHistory({
                initialEntries: ["/settings"],
            }),
            routeTree: rootRoute.addChildren([pageRoute]),
        });
        return {
            ...render(
                <QueryClientProvider client={queryClient}>
                    <RouterProvider router={router} />
                </QueryClientProvider>
            ),
            queryClient,
        };
    }
    return {
        ...render(
            createElement(
                QueryClientProvider,
                {
                    client: queryClient,
                },
                content
            )
        ),
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
        history: createMemoryHistory({
            initialEntries: [initialEntry],
        }),
        routeTree: rootRoute.addChildren([chatRoute]),
    });
    const queryClient = new QueryClient({
        defaultOptions: {
            mutations: {
                retry: false,
            },
            queries: {
                retry: false,
                staleTime: Infinity,
            },
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

async function flushQueuedTimers() {
    await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
    });
}

export function createPageBehaviorHarness() {
    const originalGlobals = {
        cancelAnimationFrame,
        fetch,
        requestAnimationFrame,
        scrollIntoViewDescriptor: Object.getOwnPropertyDescriptor(
            Element.prototype,
            "scrollIntoView"
        ),
        WebSocket,
    };
    const animationFrameState = {
        id: 0,
        frames: new Map<number, FrameRequestCallback>(),
    };
    const scrollIntoViewMock = jest.fn();
    const terminalApiState = {
        expectedExecCwd: "/tmp",
        wasJobStopped: false,
    };
    const jobsApiState = {
        cronName: "heartbeat",
        heartbeatDisableIntent: undefined as
            | undefined
            | {
                  mode: "indefinite";
                  comment: string;
              }
            | {
                  mode: "until";
                  comment: string;
                  until: string;
              },
        heartbeatEnabled: true,
        heartbeatIntervalSeconds: 1800,
        heartbeatRuns: [
            {
                cancellable: false,
                id: 1,
                jobId: "heartbeat",
                queuedAt: "2026-06-24T08:00:00.000Z",
                resourceClass: "light",
                status: "success",
                triggerType: "manual",
                startedAt: "2026-06-24T08:00:00.000Z",
                finishedAt: "2026-06-24T08:01:00.000Z",
                output: {
                    message: "ok",
                },
            },
        ],
    };
    const logsApiState = {
        dashboardRequests: 0,
        openclawHundredLineRequests: 0,
        simulateOpenclawTruncation: false,
        unavailableReason: undefined as string | undefined,
    };

    /**
     * Creates one complete cache response matching the Dashboard cache contract.
     * @param key Cache key.
     * @param data Cached domain value.
     * @param overrides Fields that differ from the default fresh fixture.
     * @returns Complete cache envelope fixture.
     */
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
        emit(
            type: string,
            event: {
                data?: string;
            } = {}
        ) {
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
            const request = JSON.parse(this.sent.at(-1) || "{}") as {
                id?: string;
            };
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
        let responsePayload = payload;
        if (method === "chat.history") {
            const requestParameters =
                typeof request.params === "object" && request.params !== null
                    ? request.params
                    : {};
            const offset =
                "offset" in requestParameters &&
                typeof requestParameters.offset === "number"
                    ? requestParameters.offset
                    : 0;
            const rawPage =
                typeof payload === "object" && payload !== null && !Array.isArray(payload)
                    ? {
                          ...payload,
                          ...(!("offset" in payload) && {
                              offset,
                          }),
                      }
                    : payload;
            responsePayload = canonicalizeOpenClawHistoryPage(rawPage, {
                offset,
                sessionKey:
                    "sessionKey" in requestParameters &&
                    typeof requestParameters.sessionKey === "string"
                        ? requestParameters.sessionKey
                        : "agent:main:main",
            });
        }
        await act(async () => {
            socket.emit("message", {
                data: JSON.stringify({
                    type: "response",
                    id: request.id,
                    isOk,
                    payload: responsePayload,
                }),
            });
            await Promise.resolve();
        });
    }
    function apiResponse(url: string, method: string, init?: RequestInit) {
        if (method === "POST" && url === "/api/sessions/agent%3Amain%3Amain/action") {
            expect(parseRequestBody(init)).toEqual({
                action: "compact",
            });
            return Response.json({
                isSuccess: true,
            });
        }
        if (method === "POST" && url === "/api/docker/containers/abc123/action") {
            expect(parseRequestBody(init)).toEqual({
                action: "restart",
            });
            return Response.json({
                output: "container action output",
            });
        }
        if (method === "POST" && url === "/api/docker/stack/action") {
            expect(parseRequestBody(init)).toEqual({
                action: "restart",
            });
            return Response.json({
                output: "stack restarted",
            });
        }
        if (method === "POST" && url === "/api/docker/prune") {
            const body = parseRequestBody(init);
            if (body.target !== "images" && body.target !== "volumes") {
                throw new Error(`Unexpected Docker prune target: ${String(body.target)}`);
            }
            return Response.json({
                isSuccess: true,
                output: "pruned",
            });
        }
        if (method === "POST" && url === "/api/docker/updater/run") {
            return Response.json({
                isSuccess: true,
                steps: [
                    {
                        isOk: true,
                        stderr: "",
                        stdout: "ok",
                        step: "scan",
                    },
                ],
            });
        }
        if (method === "POST" && url === "/api/docker/updater/services/1/update") {
            return Response.json({
                isSuccess: true,
                result: {
                    failed: [],
                    serviceId: 1,
                    summary: {
                        failed: 0,
                        updated: 1,
                    },
                    updated: [1],
                },
                stderr: "manual stderr",
            });
        }
        if (method === "POST" && url === "/api/cache/docker.summary/refresh") {
            return Response.json({
                entry: cacheEnvelopeFixture("docker.summary", {
                    checkedAt: "2026-06-24T08:00:00.000Z",
                    containers: [],
                    images: [
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
                    updaterEvents: [],
                    updaterServices: [
                        {
                            appSlug: "dashboard",
                            composeImageRef: "mira-dashboard:latest",
                            currentDigest: "sha256:old",
                            currentTag: "1.0.0",
                            enabled: true,
                            id: 1,
                            imageRepo: "mira-dashboard",
                            lastCheckedAt: "2026-06-24T08:00:00.000Z",
                            lastStatus: "update_available",
                            latestDigest: "sha256:new",
                            latestTag: "1.0.1",
                            metadata: {},
                            pinMode: "tag",
                            policy: "notify",
                            serviceName: "dashboard",
                            updateAvailable: true,
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
                    volumes: [
                        {
                            driver: "local",
                            labels: {},
                            mountpoint: "/var/lib/docker/volumes/unused-volume",
                            name: "unused-volume",
                            scope: "local",
                            size: "2 KiB",
                            usedBy: [],
                        },
                    ],
                }),
                isOk: true,
            });
        }
        if (
            method === "POST" &&
            url.startsWith("/api/cache/") &&
            url.endsWith("/refresh")
        ) {
            const key = decodeURIComponent(
                url.slice("/api/cache/".length, -"/refresh".length)
            );
            return Response.json({
                entry: cacheEnvelopeFixture(key, {}),
                isOk: true,
            });
        }
        if (method === "POST" && url === "/api/docker/exec/start") {
            expect(parseRequestBody(init)).toMatchObject({
                command: "echo hello",
                containerId: "abc123",
            });
            return Response.json({
                jobId: "job-1",
            });
        }
        if (method === "POST" && url === "/api/docker/exec/job-1/stop") {
            return Response.json({
                isSuccess: true,
            });
        }
        if (method === "POST" && url === "/api/terminal/cd") {
            const body = parseRequestBody(init);
            if (body.path === "/tmp") {
                return Response.json({
                    newCwd: "/tmp",
                });
            }
            return Response.json(
                {
                    error: {
                        code: "bad_request",
                        message: "Not a directory",
                        requestId: "terminal-cd-request",
                    },
                },
                {
                    status: 400,
                }
            );
        }
        if (method === "POST" && url === "/api/terminal/complete") {
            expect(parseRequestBody(init)).toMatchObject({
                partial: "ec",
            });
            return Response.json({
                commonPrefix: "echo ",
                completions: [
                    {
                        completion: "echo ",
                        display: "echo",
                        type: "executable",
                    },
                    {
                        completion: "echown ",
                        display: "echown",
                        type: "executable",
                    },
                ],
            });
        }
        if (method === "POST" && url === "/api/exec/start") {
            const body = parseRequestBody(init);
            expect(body.command).toBe("bash");
            expect(body.args).toEqual(["-lc", "echo hello"]);
            expect(body.cwd).toBe(terminalApiState.expectedExecCwd);
            return Response.json({
                jobId: "job-1",
            });
        }
        if (method === "POST" && url === "/api/exec/job-1/stop") {
            terminalApiState.wasJobStopped = true;
            return Response.json({
                isSuccess: true,
            });
        }
        if (method === "DELETE" && url === "/api/docker/images/img-unused") {
            return Response.json({
                isSuccess: true,
            });
        }
        if (method === "DELETE" && url === "/api/docker/volumes/unused-volume") {
            return Response.json({
                isSuccess: true,
            });
        }
        if (url === "/api/agents/status") {
            return Response.json({
                agents: [
                    {
                        id: "mira-2026",
                        status: "active",
                        model: "codex",
                        currentTask: "Testing pages",
                        lastActivity: "2026-06-24T08:00:00.000Z",
                    },
                    {
                        id: "ops",
                        status: "idle",
                        model: "codex",
                    },
                    {
                        id: "researcher",
                        status: "offline",
                        model: "codex",
                    },
                ],
                timestamp: 1_719_216_000_000,
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
                        startedAt: "2026-06-24T08:00:00.000Z",
                        lastActivityAt: "2026-06-24T08:04:00.000Z",
                        completedAt: "2026-06-24T08:05:00.000Z",
                    },
                ],
                timestamp: 1_719_216_000_000,
            });
        }
        if (url === "/api/metrics") {
            return Response.json(dashboardMetricsResponse());
        }
        if (url === "/api/cache/weather.spydeberg") {
            return Response.json(
                cacheEnvelopeFixture(
                    "weather.spydeberg",
                    {
                        location: "Spydeberg",
                        temperatureC: 20,
                        feelsLikeC: 19,
                        humidityPercent: 52,
                        windKph: 8,
                        description: "Clear",
                        fetchedAt: "2026-06-24T08:00:00.000Z",
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
                    {
                        source: "weather",
                    }
                )
            );
        }
        if (url === "/api/cache/quotas.summary") {
            return Response.json(
                cacheEnvelopeFixture(
                    "quotas.summary",
                    {
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
                    {
                        source: "quota",
                    }
                )
            );
        }
        if (url === "/api/cache/heartbeat") {
            return Response.json({
                count: 7,
                cronJobs: {
                    dataAvailable: true,
                    items: [],
                },
                dashboardJobs: [],
                entries: [
                    cacheEnvelopeFixture(
                        "weather.spydeberg",
                        {},
                        {
                            source: "weather",
                        }
                    ),
                    cacheEnvelopeFixture(
                        "quotas.summary",
                        {},
                        {
                            source: "quota",
                        }
                    ),
                    cacheEnvelopeFixture(
                        "moltbook.home",
                        {},
                        {
                            source: "moltbook",
                        }
                    ),
                    cacheEnvelopeFixture(
                        "git.workspace",
                        {},
                        {
                            source: "git",
                        }
                    ),
                    cacheEnvelopeFixture(
                        "system.host",
                        {},
                        {
                            source: "system",
                        }
                    ),
                    cacheEnvelopeFixture("docker.summary", {}),
                    cacheEnvelopeFixture("database.summary", {}),
                ],
                generatedAt: "2026-06-24T08:00:00.000Z",
                schemaVersion: 3,
                tasks: [],
            });
        }
        if (url === "/api/cache/status") {
            const keys = [
                ["weather.spydeberg", "weather"],
                ["quotas.summary", "quota"],
                ["moltbook.home", "moltbook"],
                ["git.workspace", "git"],
                ["system.host", "system"],
                ["docker.summary", "backend"],
                ["database.summary", "backend"],
            ] as const;
            return Response.json({
                count: keys.length,
                entries: keys.map(([key, source]) =>
                    cacheEnvelopeFixture(key, null, {
                        source,
                    })
                ),
                generatedAt: "2026-06-24T08:00:00.000Z",
            });
        }
        if (url === "/api/cache/git.workspace") {
            return Response.json(
                cacheEnvelopeFixture(
                    "git.workspace",
                    {
                        repos: [
                            {
                                branch: "test/broaden-fullstack-coverage",
                                category: "project",
                                checkedAt: "2026-06-24T08:00:00.000Z",
                                dirty: true,
                                exists: true,
                                key: "dashboard",
                                name: "Mira Dashboard",
                                path: "/home/ubuntu/projects/mira-dashboard/production/checkout",
                                remote: "https://github.com/rajohan/Mira-Dashboard",
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
                                branch: "main",
                                category: "workspace",
                                checkedAt: "2026-06-24T08:00:00.000Z",
                                dirty: false,
                                exists: true,
                                key: "workspace",
                                name: "Workspace",
                                path: "/home/ubuntu/.openclaw",
                                remote: "origin",
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
                    {
                        source: "git",
                    }
                )
            );
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
            return Response.json(
                cacheEnvelopeFixture(
                    "backup.kopia.status",
                    {
                        checkedAt: "2026-06-24T08:00:00.000Z",
                        tool: "kopia",
                        isOk: true,
                        snapshotsByPath: [],
                        stale: [],
                    },
                    {
                        source: "backup",
                    }
                )
            );
        }
        if (url === "/api/cache/backup.walg.status") {
            return Response.json(
                cacheEnvelopeFixture(
                    "backup.walg.status",
                    {
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
                    {
                        source: "backup",
                    }
                )
            );
        }
        if (url === "/api/cron/jobs") {
            return Response.json({
                jobs: [
                    {
                        id: "heartbeat",
                        name: jobsApiState.cronName,
                        command: "openclaw heartbeat",
                        schedule: {
                            kind: "cron",
                            expression: "*/30 * * * *",
                        },
                        payload: {
                            kind: "heartbeat",
                        },
                        delivery: {
                            mode: "session",
                        },
                        enabled: true,
                        taskLinks: [
                            {
                                number: 8,
                                title: "Chat improvements",
                            },
                        ],
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
                errorCode: null,
                errorMessage: null,
                expiresAt: null,
                lastAttemptAt: "2026-06-24T08:00:00.000Z",
                updatedAt: "2026-06-24T08:00:00.000Z",
                meta: {},
                data: {
                    bloatEstimates: [],
                    checkedAt: "2026-06-24T08:00:00.000Z",
                    overview: {
                        totalDatabaseSizeBytes: 1024,
                        totalBackends: 2,
                        averageCacheHitRatio: 99,
                        connections: {
                            active: 1,
                            idle: 1,
                        },
                        pgStatStatementsEnabled: true,
                        torrentCounts: {
                            comet: 1,
                            bitmagnet: 1,
                        },
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
                    sqlite: {
                        attention: [],
                        backup: {
                            count: 1,
                            current: true,
                            latest: {
                                bytes: 512,
                                createdAt: "2026-06-24T07:00:00.000Z",
                                kind: "scheduled",
                                name: "mira-dashboard-scheduled.db",
                            },
                            latestAgeHours: 1,
                            reviewAgeHours: 48,
                        },
                        databaseBytes: 1024,
                        fileName: "mira-dashboard.db",
                        freeBytes: 256,
                        freePages: 1,
                        freePercent: 25,
                        foreignKeysEnabled: true,
                        journalMode: "wal",
                        lastMaintenance: {
                            finishedAt: "2026-06-24T07:01:00.000Z",
                            startedAt: "2026-06-24T07:00:00.000Z",
                            status: "success",
                        },
                        migrations: {
                            applied: 4,
                            current: true,
                            latest: 4,
                        },
                        pageCount: 4,
                        pageSize: 256,
                        permissions: {
                            dataDirectory: "0700",
                            database: "0600",
                            secure: true,
                            shm: "0600",
                            wal: "0600",
                        },
                        shmBytes: 32,
                        status: "healthy",
                        storageBytes: 1184,
                        walAutoCheckpointPages: 1000,
                        walBytes: 128,
                    },
                },
            });
        }
        if (url === "/api/database/overview") {
            return Response.json({
                overview: {
                    totalDatabaseSizeBytes: 1024,
                    totalBackends: 2,
                    averageCacheHitRatio: 99,
                    connections: {
                        active: 1,
                        idle: 1,
                    },
                    pgStatStatementsEnabled: true,
                    torrentCounts: {
                        comet: 1,
                        bitmagnet: 1,
                    },
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
                errorCode: null,
                errorMessage: null,
                expiresAt: null,
                lastAttemptAt: "2026-06-24T08:00:00.000Z",
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
                            ipAddresses: {
                                mira: "172.20.0.2",
                            },
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
                        ipAddresses: {
                            mira: "172.20.0.2",
                        },
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
                            cpu: "8.5%",
                            memory: "256 MiB / 1 GiB",
                            memoryPercent: "25%",
                            netIO: "3 KB / 6 KB",
                            pids: "9",
                        },
                        status: "Up",
                    },
                ],
                mode: "live",
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
                ipAddresses: {
                    mira: "172.20.0.2",
                },
                labels: {
                    "com.docker.compose.service": "dashboard",
                },
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
            return Response.json({
                content: "dashboard log line",
            });
        }
        if (url === "/api/docker/containers/abc123/logs?tail=500") {
            return Response.json({
                content: "more dashboard log lines",
            });
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
                    {
                        name: "src",
                        path: "src",
                        type: "directory",
                    },
                    {
                        name: "README.md",
                        path: "README.md",
                        type: "file",
                        size: 100,
                    },
                ],
            });
        }
        if (url === "/api/files/README.md") {
            return Response.json({
                content: "# Dashboard",
                isBinary: false,
                modified: "2026-07-28T12:00:00.000Z",
                path: "README.md",
                size: 11,
            });
        }
        if (url === "/api/jobs") {
            return Response.json({
                jobs: [
                    {
                        description: "Dashboard heartbeat",
                        id: "heartbeat",
                        name: "Heartbeat",
                        enabled: jobsApiState.heartbeatEnabled,
                        disableIntent: jobsApiState.heartbeatDisableIntent,
                        scheduleType: "interval",
                        intervalSeconds: jobsApiState.heartbeatIntervalSeconds,
                        actionKey: "heartbeat",
                        actionPayload: {},
                        createdAt: "2026-06-24T08:00:00.000Z",
                        updatedAt: "2026-06-24T08:00:00.000Z",
                        lastRun: jobsApiState.heartbeatRuns[0],
                        resourceClass: "light",
                        timeoutMs: 300_000,
                        isQueued: false,
                        isRunning: false,
                    },
                ],
            });
        }
        if (url === "/api/job-executions?include=claims") {
            return Response.json({
                executions: [],
                summary: {
                    activeResourceClasses: [],
                    claimsPaused: false,
                    claimsPausedAt: undefined,
                    queued: 0,
                    running: 0,
                    workerCapacity: 1,
                    workerCount: 1,
                    workerOnline: true,
                },
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
                    disableIntent?:
                        | null
                        | {
                              mode: "indefinite";
                              comment: string;
                          }
                        | {
                              mode: "until";
                              comment: string;
                              until: string;
                          };
                    enabled?: boolean;
                    intervalSeconds?: unknown;
                    scheduleType?: unknown;
                    timeOfDay?: unknown;
                };
            };
            if (body.patch?.enabled === false) {
                expect(body.patch.disableIntent).toEqual({
                    mode: "indefinite",
                    comment: "Paused Dashboard maintenance",
                });
                jobsApiState.heartbeatEnabled = false;
                jobsApiState.heartbeatDisableIntent =
                    body.patch.disableIntent ?? undefined;
                return Response.json({
                    isOk: true,
                    job: {
                        description: "Dashboard heartbeat",
                        id: "heartbeat",
                        name: "Heartbeat",
                        enabled: jobsApiState.heartbeatEnabled,
                        disableIntent: jobsApiState.heartbeatDisableIntent,
                        scheduleType: "interval",
                        intervalSeconds: jobsApiState.heartbeatIntervalSeconds,
                        actionKey: "heartbeat",
                        actionPayload: {},
                        createdAt: "2026-06-24T08:00:00.000Z",
                        updatedAt: "2026-06-24T08:05:00.000Z",
                        resourceClass: "light",
                        timeoutMs: 300_000,
                        isQueued: false,
                        isRunning: false,
                    },
                });
            }
            jobsApiState.heartbeatIntervalSeconds = Number(body.patch?.intervalSeconds);
            expect(body).toEqual({
                patch: {
                    cronExpression: null,
                    intervalSeconds: 3600,
                    scheduleType: "interval",
                    timeOfDay: null,
                },
            });
            return Response.json({
                isOk: true,
                job: {
                    description: "Dashboard heartbeat",
                    id: "heartbeat",
                    name: "Heartbeat",
                    enabled: jobsApiState.heartbeatEnabled,
                    disableIntent: jobsApiState.heartbeatDisableIntent,
                    scheduleType: "interval",
                    intervalSeconds: jobsApiState.heartbeatIntervalSeconds,
                    actionKey: "heartbeat",
                    actionPayload: {},
                    createdAt: "2026-06-24T08:00:00.000Z",
                    updatedAt: "2026-06-24T08:05:00.000Z",
                    resourceClass: "light",
                    timeoutMs: 300_000,
                    isQueued: false,
                    isRunning: false,
                },
            });
        }
        if (method === "POST" && url === "/api/jobs/heartbeat/run") {
            jobsApiState.heartbeatRuns = [
                {
                    cancellable: false,
                    id: 2,
                    jobId: "heartbeat",
                    queuedAt: "2026-06-24T08:05:00.000Z",
                    resourceClass: "light",
                    status: "success",
                    triggerType: "manual",
                    startedAt: "2026-06-24T08:05:00.000Z",
                    finishedAt: "2026-06-24T08:06:00.000Z",
                    output: {
                        message: "manual ok",
                    },
                },
                ...jobsApiState.heartbeatRuns,
            ];
            return Response.json({
                isOk: true,
                run: jobsApiState.heartbeatRuns[0],
            });
        }
        if (method === "POST" && url === "/api/cron/jobs/heartbeat/run") {
            return Response.json({
                isOk: true,
            });
        }
        if (method === "POST" && url === "/api/cron/jobs/heartbeat/toggle") {
            expect(parseRequestBody(init)).toEqual({
                enabled: false,
                disableIntent: {
                    mode: "indefinite",
                    comment: "Paused during chat work",
                },
            });
            return Response.json({
                isOk: true,
            });
        }
        if (method === "POST" && url === "/api/cron/jobs/heartbeat/update") {
            const body = parseRequestBody(init) as {
                patch: {
                    delivery: {
                        mode: string;
                    };
                    name: string;
                    payload: {
                        kind: string;
                    };
                    schedule: {
                        kind: string;
                        expression: string;
                    };
                };
            };
            expect(body).toEqual({
                patch: {
                    delivery: {
                        mode: "session",
                    },
                    name: "heartbeat-updated",
                    payload: {
                        kind: "heartbeat",
                    },
                    schedule: {
                        kind: "cron",
                        expression: "*/30 * * * *",
                    },
                },
            });
            jobsApiState.cronName = body.patch.name;
            return Response.json({
                isOk: true,
            });
        }
        if (method === "POST" && url === "/api/cron/jobs/heartbeat/delete") {
            return Response.json({
                isOk: true,
            });
        }
        if (url === "/api/logs/dashboard?lines=100") {
            logsApiState.dashboardRequests += 1;
            return Response.json({
                content: JSON.stringify({
                    component: "server",
                    event: "server.started",
                    level: "info",
                    timestamp: "2026-06-24T08:00:00.000Z",
                }),
                lineIds: ["0"],
            });
        }
        if (url === "/api/logs/openclaw/files") {
            if (logsApiState.unavailableReason) {
                return Response.json({
                    logs: [],
                    unavailableReason: logsApiState.unavailableReason,
                });
            }
            return Response.json({
                logs: [
                    {
                        modified: "2026-06-24T08:00:00.000Z",
                        name: "openclaw.log",
                        size: 100,
                    },
                    {
                        modified: "2026-06-23T08:00:00.000Z",
                        name: "archived.log",
                        size: 40,
                    },
                    {
                        modified: "2026-06-22T08:00:00.000Z",
                        name: "blank.log",
                        size: 2,
                    },
                ],
            });
        }
        if (url === "/api/logs/openclaw/content?file=openclaw.log&lines=100") {
            logsApiState.openclawHundredLineRequests += 1;
            if (logsApiState.simulateOpenclawTruncation) {
                return Response.json({
                    content: JSON.stringify({
                        level: "info",
                        time: "2026-06-24T08:00:00.000Z",
                        msg: "truncated dashboard ready",
                    }),
                    file: "openclaw.log",
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
                file: "openclaw.log",
                lineIds: ["200", "300"],
            });
        }
        if (url === "/api/logs/openclaw/content?file=openclaw.log&lines=5000") {
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
                file: "openclaw.log",
                lineIds: ["100", "200", "300"],
            });
        }
        if (url === "/api/logs/openclaw/content?file=blank.log&lines=100") {
            return Response.json({
                content: "\n\n",
                file: "blank.log",
                lineIds: ["0", "1", "2"],
            });
        }
        if (url === "/api/logs/openclaw/content?file=archived.log&lines=100") {
            return Response.json({
                content: JSON.stringify({
                    level: "info",
                    time: "2026-06-23T08:00:00.000Z",
                    msg: "archived dashboard ready",
                }),
                file: "archived.log",
                lineIds: ["20"],
            });
        }
        if (url === "/api/cache/moltbook.home") {
            return Response.json(
                cacheEnvelopeFixture(
                    "moltbook.home",
                    {
                        pendingRequestCount: 1,
                        unreadMessageCount: 2,
                        activityOnYourPosts: [],
                        activityOnYourPostsCount: 0,
                        fetchedAt: "2026-06-24T08:00:00.000Z",
                        nextActions: ["reply"],
                    },
                    {
                        source: "moltbook",
                    }
                )
            );
        }
        if (
            url === "/api/cache/moltbook.feed.hot" ||
            url === "/api/cache/moltbook.feed.new"
        ) {
            const key = url.endsWith(".new") ? "moltbook.feed.new" : "moltbook.feed.hot";
            return Response.json(
                cacheEnvelopeFixture(
                    key,
                    {
                        hasMore: false,
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
                    {
                        source: "moltbook",
                    }
                )
            );
        }
        if (url === "/api/cache/moltbook.profile") {
            return Response.json(
                cacheEnvelopeFixture(
                    "moltbook.profile",
                    {
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
                    {
                        source: "moltbook",
                    }
                )
            );
        }
        if (url === "/api/cache/moltbook.my-content") {
            return Response.json(
                cacheEnvelopeFixture(
                    "moltbook.my-content",
                    {
                        comments: [],
                        posts: [],
                    },
                    {
                        source: "moltbook",
                    }
                )
            );
        }
        if (url === "/api/pull-requests") {
            return Response.json({
                pullRequests: [
                    {
                        number: 190,
                        title: "Expand backend coverage",
                        url: "https://github.com/rajohan/Mira-Dashboard/pull/190",
                        headRefName: "test/backend",
                        headRefOid: "a".repeat(40),
                        baseRefName: "main",
                        author: {
                            login: "mira-2026",
                        },
                        createdAt: "2026-06-24T08:00:00.000Z",
                        updatedAt: "2026-06-24T08:05:00.000Z",
                        isDraft: false,
                        reviewDecision: "APPROVED",
                        mergeStateStatus: "CLEAN",
                        mergeable: "isOk",
                        statusCheckRollup: [
                            {
                                status: "COMPLETED",
                                conclusion: "SUCCESS",
                            },
                        ],
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
                        author: {
                            login: "app/dependabot",
                        },
                        createdAt: "2026-06-24T09:00:00.000Z",
                        updatedAt: "2026-06-24T09:05:00.000Z",
                        isDraft: false,
                        reviewDecision: "REVIEW_REQUIRED",
                        mergeStateStatus: "BEHIND",
                        mergeable: "MERGEABLE",
                        statusCheckRollup: [
                            {
                                status: "COMPLETED",
                                conclusion: "SUCCESS",
                            },
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
        if (url === "/api/pull-requests/deployments") {
            return Response.json({
                deployments: [
                    {
                        id: "deploy-1",
                        commit: "abc123",
                        commitTitle: "Deploy dashboard",
                        startedAt: "2026-06-24T08:00:00.000Z",
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
                    root: "/srv/mira-dashboard/production/checkout",
                    expectedRoot: "/srv/mira-dashboard/production/checkout",
                    worktreeRoot: "/srv/mira-dashboard/production/checkout",
                    branch: "main",
                    expectedBranch: "main",
                    head: "abc123",
                    headCommit: "abc123",
                    isClean: true,
                    isProductionRoot: true,
                    isSafeForDeploy: true,
                },
            });
        }
        if (url === "/api/pull-requests/releases") {
            return Response.json({
                release: {
                    current: {
                        builtAt: "2026-06-24T08:00:00.000Z",
                        commitSha: "abc12345".repeat(5),
                        commitTitle: "Current dashboard release",
                        commitUrl: `https://github.com/rajohan/Mira-Dashboard/commit/${"abc12345".repeat(5)}`,
                        schema: {
                            maximumCompatible: 31,
                            minimumCompatible: 1,
                            target: 31,
                        },
                    },
                    previous: {
                        builtAt: "2026-06-23T08:00:00.000Z",
                        commitSha: "def45678".repeat(5),
                        commitTitle: "Previous dashboard release",
                        commitUrl: `https://github.com/rajohan/Mira-Dashboard/commit/${"def45678".repeat(5)}`,
                        schema: {
                            maximumCompatible: 31,
                            minimumCompatible: 1,
                            target: 31,
                        },
                    },
                    rollback: {
                        available: true,
                    },
                },
            });
        }
        if (method === "POST" && url === "/api/pull-requests/190/approve") {
            expect(parseRequestBody(init)).toEqual({
                deploy: false,
                expectedHeadSha: "a".repeat(40),
                mergeStack: false,
            });
            return Response.json({
                isOk: true,
                message: "Merged PR #190",
                cleanup: {
                    branch: "test/backend",
                    message: "Cleaned worktree",
                    status: "removed",
                },
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
            return Response.json({
                isOk: true,
                message: "Approved PR #191",
            });
        }
        if (method === "POST" && url === "/api/pull-requests/191/update-branch") {
            expect(parseRequestBody(init)).toEqual({});
            return Response.json({
                isOk: true,
                message: "Branch update queued",
            });
        }
        if (method === "POST" && url === "/api/pull-requests/deploy") {
            return Response.json({
                isOk: true,
                deployment: {
                    id: "deploy-2",
                    commit: "def456",
                    startedAt: "2026-06-24T08:14:00.000Z",
                    status: "verifying",
                    updatedAt: "2026-06-24T08:15:00.000Z",
                    note: "Deploy scheduled",
                },
            });
        }
        if (method === "POST" && url === "/api/pull-requests/releases/rollback") {
            expect(parseRequestBody(init)).toEqual({
                targetCommit: "def45678".repeat(5),
            });
            return Response.json({
                isOk: true,
                deployment: {
                    id: "rollback-1",
                    commit: "def45678".repeat(5),
                    startedAt: "2026-06-24T08:15:00.000Z",
                    status: "building",
                    updatedAt: "2026-06-24T08:16:00.000Z",
                    note: "Rollback to def45678 queued",
                },
            });
        }
        if (method === "GET" && url === "/api/pull-requests/preview") {
            return Response.json({
                preview: {
                    status: "stopped",
                },
            });
        }
        if (method === "GET" && url === "/api/account/security") {
            return Response.json({
                factors: {
                    methods: [],
                    recoveryCodesRemaining: 0,
                    totpFactors: [],
                    webAuthnCredentials: [],
                },
                recentVerification: {
                    mfa: false,
                    password: true,
                },
                recommendation: {
                    minimumSecurityKeys: 2,
                    needsBackupSecurityKey: true,
                },
                sessions: [],
                totp: {
                    available: true,
                },
                webAuthn: {
                    available: true,
                    rpId: "dashboard.example.com",
                },
            });
        }
        if (url === "/api/config") {
            if (method === "PUT") {
                const body = parseRequestBody(init);
                expect(body.__hash).toBe("config-hash-1");
                return Response.json({
                    isOk: true,
                    result: {},
                });
            }
            return Response.json({
                __hash: "config-hash-1",
                agents: {
                    list: [
                        {
                            id: "ops",
                            heartbeat: {
                                every: "30m",
                            },
                        },
                    ],
                },
                session: {
                    reset: {
                        idleMinutes: 60,
                    },
                },
                channels: {
                    webchat: {
                        enabled: true,
                        dmPolicy: "allow",
                    },
                },
                auth: {
                    profiles: {
                        owner: {},
                    },
                },
                commands: {
                    ownerAllowFrom: ["rajohan"],
                    restart: true,
                },
                logging: {
                    redactSensitive: "strict",
                },
                meta: {
                    lastTouchedAt: "2026-06-25T18:00:00.000Z",
                    lastTouchedVersion: "2026.6.10",
                },
                models: {},
                tools: {
                    exec: {
                        ask: "always",
                        security: "deny",
                    },
                    web: {
                        fetch: {
                            enabled: true,
                        },
                        search: {
                            enabled: true,
                        },
                    },
                },
            });
        }
        if (method === "POST" && url === "/api/skills/task-tracking") {
            expect(parseRequestBody(init)).toEqual({
                __hash: "config-hash-1",
                enabled: false,
            });
            return Response.json({
                isOk: true,
            });
        }
        if (url === "/api/skills") {
            return Response.json({
                skills: [
                    {
                        name: "task-tracking",
                        description: "Tasks",
                        enabled: true,
                        path: "/workspace/skills/task-tracking",
                        source: "workspace",
                    },
                ],
            });
        }
        if (method === "POST" && url === "/api/backup") {
            return Response.json({
                createdAt: "2026-06-25T18:30:00.000Z",
                hash: "backup-hash",
                config: {
                    model: "codex",
                },
            });
        }
        if (method === "POST" && url === "/api/restart") {
            return Response.json({
                isOk: true,
            });
        }
        if (url === "/api/cache/system.host") {
            return Response.json(
                cacheEnvelopeFixture(
                    "system.host",
                    {
                        version: {
                            current: "2026.6.9",
                            latest: "2026.6.9",
                        },
                    },
                    {
                        source: "system",
                    }
                )
            );
        }
        if (url === "/api/exec/job-1") {
            return Response.json({
                code: terminalApiState.wasJobStopped ? 0 : undefined,
                endedAt: terminalApiState.wasJobStopped ? 2 : undefined,
                jobId: "job-1",
                status: terminalApiState.wasJobStopped ? "done" : "running",
                stderr: "",
                startedAt: 1,
                stdout: terminalApiState.wasJobStopped ? "ok" : "",
            });
        }
        throw new Error(`Unexpected page API call: ${method} ${url}`);
    }
    function clickElement(element: Element) {
        act(() => {
            fireEvent.click(element);
        });
        flushAnimationFrames();
    }
    return {
        FakeWebSocket,
        animationFrameState,
        apiResponse,
        cancelAnimationFrameForTest,
        clickElement,
        dashboardSessionFixture,
        emitNormalizedSessions,
        findSocketRequest,
        flushQueuedTimers,
        jobsApiState,
        logsApiState,
        originalGlobals,
        parseRequestBody,
        renderChatPage,
        renderPage,
        requestAnimationFrameForTest,
        resetLogsCollectionForTest,
        resetSessionsCollectionForTest,
        respondToSocketRequest,
        scrollIntoViewMock,
        terminalApiState,
    };
}
