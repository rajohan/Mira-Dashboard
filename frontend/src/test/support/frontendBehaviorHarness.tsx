import { jest } from "bun:test";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
    createMemoryHistory,
    createRootRoute,
    createRoute,
    createRouter,
    Outlet,
    RouterProvider,
} from "@tanstack/react-router";
import { render, renderHook, screen } from "@testing-library/react";
import { createElement, type ReactNode } from "react";

import type { CacheEnvelope } from "../../../../contracts/cache";
import type { DatabaseOverviewResponse } from "../../../../contracts/database";
import type { DashboardDiagnosticsResponse } from "../../../../contracts/health";
import type { AppObservabilityMetrics, Metrics } from "../../../../contracts/metrics";
import type { NotificationItem } from "../../../../contracts/notifications";
import type { Task, TaskUpdate } from "../../../../contracts/tasks";
import { requestBodyText, requestUrl } from "../../../../test/support/fetch";
import type { ChatHistoryMessage } from "../../components/features/chat/chatTypes";
import { OpenClawSocketProvider } from "../../hooks/useOpenClawSocket";
export type FakeWebSocketListener = (event: { code?: number; data?: string }) => void;
function task(overrides: Partial<Task> & Pick<Task, "number" | "title">): Task {
    return {
        number: overrides.number,
        title: overrides.title,
        body: overrides.body ?? "",
        state: overrides.state ?? "OPEN",
        labels: overrides.labels ?? [],
        assignees: overrides.assignees ?? [
            {
                login: "mira-2026",
                name: "Mira",
            },
        ],
        createdAt: overrides.createdAt ?? "2026-06-19T08:00:00.000Z",
        updatedAt: overrides.updatedAt ?? "2026-06-19T08:00:00.000Z",
        url: overrides.url ?? `/tasks/${overrides.number}`,
        automation: overrides.automation,
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
        lastAttemptAt: "2026-06-23T08:00:00.000Z",
        meta: {},
        source: "backend",
        status: "fresh",
        updatedAt: "2026-06-23T08:00:00.000Z",
        ...overrides,
    };
}

function databaseOverviewFixture(): DatabaseOverviewResponse {
    return {
        bloatEstimates: [],
        checkedAt: "2026-06-23T08:00:00.000Z",
        databases: [],
        deadTuples: [],
        overview: {
            averageCacheHitRatio: 99,
            connections: {},
            pgStatStatementsEnabled: true,
            pgbouncer: {
                avgQueryTime: 1,
                avgTransactionTime: 2,
                clientConnections: 1,
                maxWait: 0,
                serverConnections: 1,
                waitingClients: 0,
            },
            torrentCounts: {
                bitmagnet: 2,
                comet: 1,
            },
            totalBackends: 2,
            totalDatabaseSizeBytes: 1024,
        },
        pgbouncerPools: [],
        pgbouncerStats: [],
        sqlite: {
            attention: [],
            backup: {
                count: 0,
                current: true,
                reviewAgeHours: 48,
            },
            databaseBytes: 1024,
            fileName: "mira-dashboard.db",
            foreignKeysEnabled: true,
            freeBytes: 0,
            freePages: 0,
            freePercent: 0,
            journalMode: "wal",
            migrations: {
                applied: 1,
                current: true,
                latest: 1,
            },
            pageCount: 4,
            pageSize: 256,
            permissions: {
                secure: true,
            },
            shmBytes: 0,
            status: "healthy",
            storageBytes: 1024,
            walAutoCheckpointPages: 1000,
            walBytes: 0,
        },
        topQueries: [],
    };
}

function appObservabilityMetrics(): AppObservabilityMetrics {
    return {
        cacheRefresh: {
            active: 0,
            averageDurationMs: 4,
            coalesced: 2,
            failures: 1,
            lastDurationMs: 5,
            maxDurationMs: 8,
            refreshes: 3,
            requests: 5,
            totalDurationMs: 12,
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
        database: {
            available: true,
            averageDurationMs: 1,
            fileBytes: 4096,
            freelistBytes: 0,
            freelistPages: 0,
            freelistPercent: 0,
            latencyMs: 0.5,
            lockErrors: 0,
            maxDurationMs: 2,
            operations: 4,
            shmBytes: 0,
            walBytes: 0,
        },
        gateway: {
            connectFailures: 0,
            connected: true,
            connections: 1,
            disconnects: 0,
            pendingRequests: 0,
            reconnects: 0,
        },
        processes: {
            active: 0,
            averageDurationMs: 10,
            failed: 0,
            lastDurationMs: 10,
            maxDurationMs: 10,
            started: 1,
            succeeded: 1,
            totalDurationMs: 10,
        },
        runtime: {
            eventLoopDelayMs: 0.25,
            externalBytes: 1024,
            heapTotalBytes: 4096,
            heapUsedBytes: 2048,
            rssBytes: 8192,
            uptimeSeconds: 123,
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
            ticks: 2,
            workerCapacity: 2,
            workerCount: 1,
            workerOnline: true,
        },
    };
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
    return jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
        return Promise.try(() => {
            const url = requestUrl(input);
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
                        item.id === id
                            ? {
                                  ...item,
                                  isRead: true,
                              }
                            : item
                    )
                );
                return Response.json({
                    isOk: true,
                });
            }
            if (url === "/api/notifications/mark-all-read" && method === "POST") {
                notifications.splice(
                    0,
                    notifications.length,
                    ...notifications.map((item) => ({
                        ...item,
                        isRead: true,
                    }))
                );
                return Response.json({
                    isOk: true,
                });
            }
            if (url === "/api/notifications/clear-read" && method === "POST") {
                const before = notifications.length;
                notifications.splice(
                    0,
                    notifications.length,
                    ...notifications.filter((item) => !item.isRead)
                );
                return Response.json({
                    deleted: before - notifications.length,
                    isOk: true,
                });
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
                return Response.json({
                    deleted: before - notifications.length,
                    isOk: true,
                });
            }
            throw new Error(`Unexpected notification API call: ${method} ${url}`);
        });
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
            queries: {
                retry: false,
            },
            mutations: {
                retry: false,
            },
        },
    });
    const view = render(
        createElement(
            QueryClientProvider,
            {
                client: queryClient,
            },
            children
        )
    );
    return {
        ...view,
        queryClient,
    };
}

function renderWithQueryClientAndRouter(children: ReactNode, initialEntry = "/") {
    const rootRoute = createRootRoute({
        component: () => createElement(Outlet),
    });
    const indexRoute = createRoute({
        getParentRoute: () => rootRoute,
        path: "/",
        component: () => createElement("div", undefined, children),
    });
    const reportsRoute = createRoute({
        getParentRoute: () => rootRoute,
        path: "/reports",
        component: () => createElement("div", undefined, children),
    });
    const router = createRouter({
        history: createMemoryHistory({
            initialEntries: [initialEntry],
        }),
        routeTree: rootRoute.addChildren([indexRoute, reportsRoute]),
    });
    const queryClient = new QueryClient({
        defaultOptions: {
            queries: {
                retry: false,
            },
            mutations: {
                retry: false,
            },
        },
    });
    const view = render(
        createElement(
            QueryClientProvider,
            {
                client: queryClient,
            },
            createElement(RouterProvider, {
                router,
            })
        )
    );
    return {
        ...view,
        queryClient,
        router,
    };
}

function renderHookWithQueryClient<Result>(callback: () => Result) {
    const queryClient = new QueryClient({
        defaultOptions: {
            queries: {
                retry: false,
            },
            mutations: {
                retry: false,
            },
        },
    });
    const wrapper = ({ children }: { children: ReactNode }) =>
        createElement(
            QueryClientProvider,
            {
                client: queryClient,
            },
            children
        );
    return {
        ...renderHook(callback, {
            wrapper,
        }),
        queryClient,
    };
}

function openClawSocketWrapper({ children }: { children: ReactNode }) {
    return createElement(OpenClawSocketProvider, undefined, children);
}

function patchWritableCollection(
    collection: object,
    entries: Array<[string, unknown]>,
    utilities: {
        writeDelete?: (key: string) => void;
        writeUpsert?: (item: Partial<Record<string, unknown>>) => void;
    }
) {
    const isReadyDescriptor = Object.getOwnPropertyDescriptor(collection, "isReady");
    const iteratorDescriptor = Object.getOwnPropertyDescriptor(
        collection,
        Symbol.iterator
    );
    const utilitiesDescriptor = Object.getOwnPropertyDescriptor(collection, "utils");
    Object.defineProperties(collection, {
        isReady: {
            configurable: true,
            value: () => true,
        },
        [Symbol.iterator]: {
            configurable: true,
            value: function* collectionIterator() {
                yield* entries;
            },
        },
        utils: {
            configurable: true,
            value: utilities,
        },
    });
    return () => {
        if (isReadyDescriptor) {
            Object.defineProperty(collection, "isReady", isReadyDescriptor);
        } else {
            delete (collection as Record<string, unknown>).isReady;
        }
        if (iteratorDescriptor) {
            Object.defineProperty(collection, Symbol.iterator, iteratorDescriptor);
        } else {
            delete (collection as Record<symbol, unknown>)[Symbol.iterator];
        }
        if (utilitiesDescriptor) {
            Object.defineProperty(collection, "utils", utilitiesDescriptor);
        }
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

function latestSocketRequest(socket: { readonly sent: string[] }): {
    id: string;
    method?: string;
    timeoutMs?: number;
} {
    const serializedRequest = socket.sent.at(-1);
    if (!serializedRequest) {
        throw new Error("Expected a WebSocket request");
    }
    return JSON.parse(serializedRequest) as {
        id: string;
        method?: string;
        timeoutMs?: number;
    };
}

function claimSecurityVerification(event: Event): void {
    event.preventDefault();
}

function inlineRasterImage(mimeType: string, bytes: Uint8Array) {
    const encoded = btoa(String.fromCodePoint(...bytes));
    return {
        image: {
            data: encoded,
            mimeType,
            type: "image" as const,
        },
        url: `data:${mimeType};base64,${encoded}`,
    };
}

export function createFrontendBehaviorHarness() {
    function dashboardDiagnostics(
        overrides: {
            backendCommit?: string;
            frontendCommit?: string;
            sessionCount?: number;
        } = {}
    ): DashboardDiagnosticsResponse {
        const backendCommit = overrides.backendCommit ?? "backend-sha";
        const frontendCommit = overrides.frontendCommit ?? "frontend-sha";
        return {
            checks: {
                database: {
                    currentSchemaVersion: 1,
                    maximumCompatibleSchemaVersion: 1,
                    minimumCompatibleSchemaVersion: 1,
                    ready: true,
                    targetSchemaVersion: 1,
                },
                frontend: {
                    ready: true,
                },
                release: {
                    ready: true,
                    source: "manifest",
                },
                worker: {
                    ready: true,
                },
            },
            dependencies: {
                gatewayConnected: true,
            },
            observability: appObservabilityMetrics(),
            releaseDetails: {
                backendCommit,
                frontendCommit,
                ready: true,
                source: "manifest",
            },
            sessionCount: overrides.sessionCount ?? 1,
            status: "isReady",
        };
    }
    function dashboardMetrics(): Metrics {
        return {
            ...appObservabilityMetrics(),
            cpu: {
                count: 4,
                loadAvg: [0.1, 0.2, 0.3],
                loadPercent: 5,
                model: "test cpu",
            },
            disk: {
                percent: 25,
                total: 1000,
                totalGB: 1,
                used: 250,
                usedGB: 0.25,
            },
            http: {
                averageDurationMs: 2,
                errors: 0,
                maxDurationMs: 3,
                requests: 2,
                routes: [],
            },
            memory: {
                free: 60,
                percent: 40,
                total: 100,
                totalGB: 0.1,
                used: 40,
                usedGB: 0.04,
            },
            network: {
                downloadMbps: 1,
                uploadMbps: 2,
            },
            polling: {
                snapshots: [],
            },
            system: {
                hostname: "dashboard-test",
                platform: "linux",
                uptime: 123,
            },
            timestamp: 123_456,
            tokens: {
                byAgent: [
                    {
                        label: "Mira",
                        model: "codex",
                        tokens: 42,
                        type: "MAIN",
                    },
                ],
                byModel: {
                    codex: 42,
                },
                sessionsByModel: {
                    codex: 1,
                },
                total: 42,
            },
        };
    }
    function createApi(tasks: Task[], taskUpdates: Record<number, TaskUpdate[]> = {}) {
        return jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
            return Promise.try(() => {
                const url = requestUrl(input);
                const method = init?.method ?? "GET";
                if (url === "/api/tasks" && method === "GET") {
                    return Response.json(tasks);
                }
                const updatesMatch = /^\/api\/tasks\/(\d+)\/updates$/u.exec(url);
                if (updatesMatch && method === "GET") {
                    return Response.json(taskUpdates[Number(updatesMatch[1])] ?? []);
                }
                if (url === "/api/tasks" && method === "POST") {
                    const payload = JSON.parse(requestBodyText(init?.body, "{}")) as {
                        title: string;
                        body: string;
                        labels: string[];
                        assignee: string;
                    };
                    const created = task({
                        number: tasks.length + 1,
                        title: payload.title,
                        body: payload.body,
                        labels: payload.labels.map((name) => ({
                            name,
                        })),
                        assignees: [
                            {
                                login: payload.assignee,
                                name: payload.assignee,
                            },
                        ],
                        updatedAt: "2026-06-19T09:00:00.000Z",
                    });
                    tasks.unshift(created);
                    return Response.json(created, {
                        status: 201,
                    });
                }
                throw new Error(`Unexpected frontend API call: ${method} ${url}`);
            });
        });
    }
    class FakeWebSocket {
        static instances: FakeWebSocket[] = [];
        static readonly CONNECTING = 0;
        static readonly OPEN = 1;
        static readonly CLOSING = 2;
        static readonly CLOSED = 3;
        private readonly listeners = new Map<string, FakeWebSocketListener[]>();
        readonly sent: string[] = [];
        readonly url: string;
        readyState = FakeWebSocket.CONNECTING;
        constructor(url: string) {
            this.url = url;
            FakeWebSocket.instances.push(this);
        }
        private dispatch(
            type: string,
            event: {
                code?: number;
                data?: string;
            } = {}
        ) {
            const listeners = this.listeners.get(type) || [];
            for (const listener of listeners) {
                listener(event);
            }
        }
        addEventListener(type: string, listener: FakeWebSocketListener) {
            this.listeners.set(type, [...(this.listeners.get(type) || []), listener]);
        }
        send(data: string) {
            this.sent.push(data);
        }
        close(code = 1000) {
            this.readyState = FakeWebSocket.CLOSED;
            this.dispatch("close", {
                code,
            });
        }
        open() {
            this.readyState = FakeWebSocket.OPEN;
            this.dispatch("open");
        }
        message(data: unknown) {
            this.dispatch("message", {
                data: JSON.stringify(data),
            });
        }
        error() {
            this.dispatch("error");
        }
    }
    return {
        FakeWebSocket,
        cacheEnvelopeFixture,
        chatMessage,
        claimSecurityVerification,
        createApi,
        createNotificationsApi,
        dashboardDiagnostics,
        dashboardMetrics,
        databaseOverviewFixture,
        getButtonByText,
        inlineRasterImage,
        latestSocketRequest,
        notification,
        openClawSocketWrapper,
        patchWritableCollection,
        renderHookWithQueryClient,
        renderWithQueryClient,
        renderWithQueryClientAndRouter,
        task,
    };
}
