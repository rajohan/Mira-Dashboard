import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
    createMemoryHistory,
    createRootRoute,
    createRoute,
    createRouter,
    Outlet,
    RouterProvider,
} from "@tanstack/react-router";
import { act, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, jest } from "bun:test";
import { createElement, type ReactNode } from "react";

import {
    agentsCollection,
    preloadAgentsCollection,
    writeAgentsFromWebSocket,
} from "../collections/agents";
import {
    logsCollection,
    preloadLogsCollection,
    writeLogFromWebSocket,
} from "../collections/logs";
import {
    deleteSessionFromCollection,
    preloadSessionsCollection,
    replaceSessionsFromWebSocket,
    sessionsCollection,
} from "../collections/sessions";
import type { ChatHistoryMessage } from "../components/features/chat/chatTypes";
import {
    attachmentKind,
    extractImages,
    extractThinkingBlocks,
    extractToolCalls,
    gatewayAttachments,
    normalizeChatHistoryMessage,
    normalizeText,
    normalizeVisibleChatHistoryMessages,
    optimisticAttachmentDisplay,
} from "../components/features/chat/chatTypes";
import {
    base64ToText,
    chatErrorMessage,
    dataUrlToBase64,
    dedupeMessages,
    displayMimeType,
    isRecoveredAssistantText,
    mergeWithRecentOptimisticMessages,
    messageDeleteKey,
    messageIdentity,
    readFileAsDataUrl,
} from "../components/features/chat/chatUtilities";
import {
    buildSlashCommandSuggestions,
    slashCommandCanonicalName,
} from "../components/features/chat/slashCommands";
import {
    formatBytes as formatDatabaseBytes,
    formatNumber as formatDatabaseNumber,
    truncateQuery,
} from "../components/features/database/databaseUtilities";
import {
    formatBytes as formatDockerBytes,
    formatDockerMemory,
    formatFullVersionDisplay,
    formatTimestamp,
    formatUpdaterTransition,
    formatVersionDisplay,
} from "../components/features/docker/dockerFormatters";
import { TaskDetailModal } from "../components/features/tasks/TaskDetailModal";
import { TaskOverlay } from "../components/features/tasks/TaskOverlay";
import { Layout } from "../components/layout/Layout";
import { NotificationBell } from "../components/layout/NotificationBell";
import { Badge, getSessionTypeVariant } from "../components/ui/Badge";
import { ConfirmModal } from "../components/ui/ConfirmModal";
import { Dropdown } from "../components/ui/Dropdown";
import { SearchInput } from "../components/ui/SearchInput";
import {
    useAgentsConfig,
    useAgentsStatus,
    useAgentStatus,
    useAgentTaskHistory,
} from "../hooks/useAgents";
import { apiFetch, UnauthorizedError } from "../hooks/useApi";
import {
    useClearKopiaBackupAttention,
    useClearWalgBackupAttention,
    useKopiaBackup,
    useRunKopiaBackup,
    useRunWalgBackup,
    useWalgBackup,
} from "../hooks/useBackups";
import {
    useCacheEntry,
    useCacheHeartbeat,
    useRefreshCacheEntry,
} from "../hooks/useCache";
import {
    type OpenClawConfig,
    useConfig,
    useCreateBackup,
    useRestartGateway,
    useSkills,
    useToggleSkill,
    useUpdateConfig,
} from "../hooks/useConfig";
import {
    useCronJobs,
    useDeleteCronJob,
    useRunCronJobNow,
    useToggleCronJob,
    useUpdateCronJob,
} from "../hooks/useCron";
import { useDatabaseOverview } from "../hooks/useDatabase";
import { useFileContent, useFiles, useSaveFile } from "../hooks/useFiles";
import { useHealth } from "../hooks/useHealth";
import { useLogContent, useLogFiles } from "../hooks/useLogs";
import { useMetrics } from "../hooks/useMetrics";
import { useMoltbookData } from "../hooks/useMoltbook";
import type { NotificationItem } from "../hooks/useNotifications";
import {
    useCreateNotification,
    useMarkAllNotificationsRead,
} from "../hooks/useNotifications";
import { OpenClawSocketProvider, useOpenClawSocket } from "../hooks/useOpenClawSocket";
import { OPS_ACTIONS, useExecJob, useStartOpsAction } from "../hooks/useOpsActions";
import {
    useApprovePullRequest,
    useApprovePullRequestReview,
    useDeployDashboard,
    useProductionCheckout,
    usePullRequestDeployments,
    usePullRequests,
    useRejectPullRequest,
    useUpdatePullRequestBranch,
} from "../hooks/usePullRequests";
import { hasQuotaStatus, useQuotas } from "../hooks/useQuotas";
import {
    useRunScheduledJobNow,
    useScheduledJobRuns,
    useScheduledJobs,
    useUpdateScheduledJob,
} from "../hooks/useScheduledJobs";
import { useDeleteSession, useSessionAction } from "../hooks/useSessions";
import {
    taskKeys,
    useAssignTask,
    useCreateTaskUpdate,
    useDeleteTask,
    useDeleteTaskUpdate,
    useMoveTask,
    useTaskUpdates,
    useUpdateTask,
    useUpdateTaskUpdate,
} from "../hooks/useTasks";
import {
    changeDirectory,
    getCompletions,
    stopTerminalJob,
    useStartTerminalCommand,
    useTerminalHistory,
    useTerminalJob,
} from "../hooks/useTerminal";
import { useWeather } from "../hooks/useWeather";
import { createSocketClient } from "../lib/socket/socketClient";
import { handleSocketMessage } from "../lib/socket/socketMessageRouter";
import { compareLogEntriesByLineId } from "../pages/Logs";
import { Reports } from "../pages/Reports";
import { Tasks } from "../pages/Tasks";
import { authActions, authStore } from "../stores/authStore";
import type { Task } from "../types/task";
import {
    formatCronLastStatus,
    formatCronTimestamp,
    getCronJobId,
    getCronJobName,
    getCronStateValue,
    getCronStatusVariant,
    isCronExpressionValid,
    sortCronJobs,
} from "../utils/cronUtilities";
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
} from "../utils/date";
import {
    getFileExtension,
    getLanguage,
    getSyntaxClass,
    isBinaryFile,
    isCodeFile,
    isImageFile,
    isJsonFile,
    isMarkdownFile,
} from "../utils/fileUtilities";
import {
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
} from "../utils/format";
import {
    formatLogTime,
    getLevelColor,
    getSubsystemColor,
    parseLogLine,
} from "../utils/logUtilities";
import {
    formatSessionType,
    getTypeSortOrder,
    sortSessionsByTypeAndActivity,
} from "../utils/sessionUtilities";
import { getColumnId, getPriority, isTaskMatchSearch } from "../utils/taskUtilities";

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
        history: createMemoryHistory({ initialEntries: [initialEntry] }),
        routeTree: rootRoute.addChildren([indexRoute, reportsRoute]),
    });
    const queryClient = new QueryClient({
        defaultOptions: {
            queries: { retry: false },
            mutations: { retry: false },
        },
    });
    const view = render(
        createElement(
            QueryClientProvider,
            { client: queryClient },
            createElement(RouterProvider, { router })
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

type FakeWebSocketListener = (event: { data?: string }) => void;

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

    private dispatch(type: string, event: { data?: string } = {}) {
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

    close() {
        this.readyState = FakeWebSocket.CLOSED;
        this.dispatch("close");
    }

    open() {
        this.readyState = FakeWebSocket.OPEN;
        this.dispatch("open");
    }

    message(data: unknown) {
        this.dispatch("message", { data: JSON.stringify(data) });
    }

    error() {
        this.dispatch("error");
    }
}

describe("Mira Dashboard frontend behavior", () => {
    beforeEach(() => {
        authActions.clearSession();
    });

    afterEach(() => {
        authActions.clearSession();
    });

    it("loads the app shell, router, login route, and local devtools modules", async () => {
        const [{ default: App }, { router }, { Login }, { default: DashboardDevtools }] =
            await Promise.all([
                import("../App"),
                import("../router"),
                import("../pages/Login"),
                import("../components/devtools/DashboardDevtools"),
            ]);

        expect(App).toBeTypeOf("function");
        expect(Login).toBeTypeOf("function");
        expect(DashboardDevtools).toBeTypeOf("function");
        expect(router.navigate).toBeTypeOf("function");

        const originalFetch = fetch;
        Object.defineProperty(globalThis, "fetch", {
            configurable: true,
            value: async (input: Parameters<typeof fetch>[0]) => {
                const url = String(input);
                if (url === "/api/auth/session") {
                    return Response.json({
                        authenticated: false,
                        isBootstrapRequired: true,
                        user: undefined,
                    });
                }
                if (url === "/api/auth/bootstrap") {
                    return Response.json({
                        hasGatewayToken: false,
                        isBootstrapRequired: true,
                    });
                }
                throw new Error(`Unexpected app shell fetch: ${url}`);
            },
            writable: true,
        });

        try {
            await router.navigate({ to: "/login" });
            const view = render(createElement(App));
            await waitFor(() => {
                expect(screen.getByText("Create first user")).toBeInTheDocument();
            });
            expect(screen.getByLabelText("Gateway Token")).toBeInTheDocument();
            view.unmount();

            const devtoolsView = render(createElement(DashboardDevtools));
            expect(devtoolsView.container.firstChild).toBeTruthy();
            devtoolsView.unmount();
        } finally {
            Object.defineProperty(globalThis, "fetch", {
                configurable: true,
                value: originalFetch,
                writable: true,
            });
        }
    });

    it("renders the authenticated layout shell with navigation status and logout", async () => {
        authActions.setSession({
            authenticated: true,
            isBootstrapRequired: false,
            user: { id: 1, username: "raymond" },
        });
        const originalFetch = fetch;
        const originalWebSocket = WebSocket;
        const apiCalls: string[] = [];
        class LayoutWebSocket {
            static readonly CONNECTING = 0;
            static readonly OPEN = 1;
            static readonly CLOSING = 2;
            static readonly CLOSED = 3;
            private readonly listeners = new Map<string, Array<() => void>>();
            readyState = LayoutWebSocket.CONNECTING;
            readonly sent: string[] = [];

            addEventListener(type: string, listener: () => void) {
                this.listeners.set(type, [...(this.listeners.get(type) || []), listener]);
            }

            send(data: string) {
                this.sent.push(data);
            }

            close() {
                this.readyState = LayoutWebSocket.CLOSED;
            }
        }
        const fetchForLayoutShell = async (
            input: Parameters<typeof fetch>[0],
            init?: RequestInit
        ) => {
            const url = String(input);
            apiCalls.push(`${init?.method ?? "GET"} ${url}`);
            if (url === "/api/health") {
                return Response.json({
                    backendCommit: "backend-sha",
                    gatewayConnected: true,
                    sessionCount: 1,
                    status: "isOk",
                });
            }
            if (url === "/api/cache/system.host") {
                return Response.json({
                    consecutiveFailures: 0,
                    data: { version: { current: "2026.6.9" } },
                    errorCode: undefined,
                    errorMessage: undefined,
                    expiresAt: undefined,
                    key: "system.host",
                    lastAttemptAt: "2026-06-25T00:00:00.000Z",
                    meta: {},
                    source: "system",
                    status: "fresh",
                    updatedAt: "2026-06-25T00:00:00.000Z",
                });
            }
            if (url === "/api/pull-requests") {
                return Response.json({
                    pullRequests: [
                        {
                            author: { login: "mira-2026" },
                            baseRefName: "main",
                            createdAt: "2026-06-25T00:00:00.000Z",
                            headRefName: "test/layout",
                            isDraft: false,
                            number: 192,
                            title: "Expand coverage",
                            updatedAt: "2026-06-25T00:00:00.000Z",
                            url: "https://github.test/pr/192",
                        },
                    ],
                });
            }
            if (url === "/api/notifications") {
                return Response.json({ items: [], readCount: 0, unreadCount: 0 });
            }
            if (url === "/api/auth/logout" && init?.method === "POST") {
                return Response.json({ isOk: true });
            }
            if (url === "/api/auth/session") {
                return Response.json({
                    authenticated: false,
                    isBootstrapRequired: false,
                    user: undefined,
                });
            }
            throw new Error(
                `Unexpected layout shell fetch: ${init?.method ?? "GET"} ${url}`
            );
        };
        Object.defineProperties(globalThis, {
            fetch: {
                configurable: true,
                value: fetchForLayoutShell,
                writable: true,
            },
            WebSocket: {
                configurable: true,
                value: LayoutWebSocket,
                writable: true,
            },
        });

        const rootRoute = createRootRoute({
            component: () => createElement(Outlet),
        });
        const authenticatedRoute = createRoute({
            getParentRoute: () => rootRoute,
            id: "authenticated",
            component: () =>
                createElement(
                    Layout,
                    undefined,
                    createElement("section", undefined, "Layout child content")
                ),
        });
        const indexRoute = createRoute({
            getParentRoute: () => authenticatedRoute,
            path: "/",
            component: () => createElement("div", undefined, "Index child"),
        });
        const loginRoute = createRoute({
            getParentRoute: () => rootRoute,
            path: "/login",
            component: () => createElement("div", undefined, "Login route"),
        });
        const testRouter = createRouter({
            history: createMemoryHistory({ initialEntries: ["/"] }),
            routeTree: rootRoute.addChildren([
                loginRoute,
                authenticatedRoute.addChildren([indexRoute]),
            ]),
        });
        const queryClient = new QueryClient({
            defaultOptions: {
                mutations: { retry: false },
                queries: { retry: false, staleTime: Infinity },
            },
        });
        const routedShell = createElement(
            OpenClawSocketProvider,
            undefined,
            createElement(RouterProvider, { router: testRouter })
        );

        try {
            const view = render(
                createElement(QueryClientProvider, { client: queryClient }, routedShell)
            );
            await waitFor(() => {
                expect(screen.getByText("Mira Dashboard")).toBeInTheDocument();
                expect(screen.getByText("Layout child content")).toBeInTheDocument();
                expect(screen.getByLabelText("1 open pull requests")).toBeInTheDocument();
            });

            expect(screen.getByTitle("Backend connected")).toBeInTheDocument();
            expect(screen.getByText("v2026.6.9")).toBeInTheDocument();
            await userEvent.click(screen.getByLabelText("Open navigation menu"));
            expect(
                screen.getAllByLabelText("Close navigation menu").length
            ).toBeGreaterThan(1);

            await userEvent.click(screen.getByText("Log out"));
            await waitFor(() => {
                expect(apiCalls).toContain("POST /api/auth/logout");
            });
            act(() => {
                view.unmount();
            });
        } finally {
            queryClient.clear();
            Object.defineProperties(globalThis, {
                fetch: {
                    configurable: true,
                    value: originalFetch,
                    writable: true,
                },
                WebSocket: {
                    configurable: true,
                    value: originalWebSocket,
                    writable: true,
                },
            });
        }
    });

    it("drives login page bootstrap, failed login, successful login, and navigation", async () => {
        const { Login } = await import("../pages/Login");
        const originalFetch = fetch;
        const calls: string[] = [];
        let loginAttempts = 0;
        Object.defineProperty(globalThis, "fetch", {
            configurable: true,
            value: async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
                const url = String(input);
                calls.push(`${init?.method ?? "GET"} ${url}`);
                if (url === "/api/auth/bootstrap") {
                    return Response.json({
                        hasGatewayToken: true,
                        isBootstrapRequired: false,
                    });
                }
                if (url === "/api/auth/login" && init?.method === "POST") {
                    const body = JSON.parse(String(init.body || "{}")) as {
                        password?: string;
                        username?: string;
                    };
                    expect(body.username).toBe("raymond");
                    loginAttempts += 1;
                    if (body.password !== "correct-password") {
                        return Response.json(
                            { error: "Invalid credentials" },
                            { status: 401 }
                        );
                    }
                    return Response.json({ isOk: true });
                }
                if (url === "/api/auth/session") {
                    return Response.json({
                        authenticated: loginAttempts > 1,
                        isBootstrapRequired: false,
                        user:
                            loginAttempts > 1
                                ? { id: 1, username: "raymond" }
                                : undefined,
                    });
                }
                throw new Error(
                    `Unexpected login fetch: ${init?.method ?? "GET"} ${url}`
                );
            },
            writable: true,
        });

        const rootRoute = createRootRoute({
            component: () => createElement(Outlet),
        });
        const indexRoute = createRoute({
            getParentRoute: () => rootRoute,
            path: "/",
            component: () => createElement("div", undefined, "Logged in"),
        });
        const loginRoute = createRoute({
            getParentRoute: () => rootRoute,
            path: "/login",
            component: Login,
        });
        const testRouter = createRouter({
            history: createMemoryHistory({ initialEntries: ["/login"] }),
            routeTree: rootRoute.addChildren([indexRoute, loginRoute]),
        });

        try {
            const view = render(createElement(RouterProvider, { router: testRouter }));
            await waitFor(() => {
                expect(screen.getByText("Log in")).toBeInTheDocument();
                expect(screen.queryByLabelText("Gateway Token")).not.toBeInTheDocument();
            });

            await userEvent.type(screen.getByLabelText("Username"), " raymond ");
            await userEvent.type(screen.getByLabelText("Password"), "wrong");
            await userEvent.click(screen.getByRole("button", { name: "Log in" }));
            await waitFor(() => {
                expect(screen.getByText("Invalid credentials")).toBeInTheDocument();
                expect(calls).toContain("GET /api/auth/bootstrap");
            });

            const passwordInput = screen.getByLabelText("Password");
            await userEvent.clear(passwordInput);
            await userEvent.type(passwordInput, "correct-password");
            await userEvent.click(screen.getByRole("button", { name: "Log in" }));
            await waitFor(() => {
                expect(screen.getByText("Logged in")).toBeInTheDocument();
            });
            expect(calls).toContain("POST /api/auth/login");

            view.unmount();
        } finally {
            Object.defineProperty(globalThis, "fetch", {
                configurable: true,
                value: originalFetch,
                writable: true,
            });
        }
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

    it("initializes, refreshes, and clears auth state through the shared auth store", async () => {
        const fetchMock = jest.fn(
            async (input: RequestInfo | URL, init?: RequestInit) => {
                const url = String(input);
                const method = init?.method ?? "GET";

                if (url === "/api/auth/session" && method === "GET") {
                    return Response.json({
                        authenticated: true,
                        isBootstrapRequired: false,
                        user: { id: 2, username: "mira" },
                    });
                }

                if (url === "/api/auth/logout" && method === "POST") {
                    return new Response(undefined, { status: 204 });
                }

                throw new Error(`Unexpected auth API call: ${method} ${url}`);
            }
        );
        Object.defineProperty(globalThis, "fetch", {
            configurable: true,
            value: fetchMock,
            writable: true,
        });

        await authActions.initialize();
        expect(authStore.state).toMatchObject({
            isAuthenticated: true,
            isInitialized: true,
            user: { id: 2, username: "mira" },
        });

        await authActions.logout();
        expect(authStore.state).toMatchObject({
            isAuthenticated: false,
            isInitialized: true,
            user: undefined,
        });
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/auth/logout",
            expect.objectContaining({
                credentials: "include",
                method: "POST",
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

    it("drives socket client request, response, error, and disconnect behavior", async () => {
        const originalWebSocket = WebSocket;
        FakeWebSocket.instances = [];
        Object.defineProperty(globalThis, "WebSocket", {
            configurable: true,
            value: FakeWebSocket,
            writable: true,
        });
        const events: string[] = [];

        try {
            const client = createSocketClient({
                url: "ws://dashboard.test/socket",
                onOpen: () => {
                    events.push("open");
                },
                onClose: () => {
                    events.push("close");
                },
                onError: () => {
                    events.push("error");
                },
                onMessage: () => {
                    events.push("message");
                },
            });

            await expect(client.request("before-open")).rejects.toThrow(
                "WebSocket not connected"
            );

            client.connect();
            client.connect();
            const socket = FakeWebSocket.instances[0]!;
            expect(FakeWebSocket.instances).toHaveLength(1);
            expect(socket.url).toBe("ws://dashboard.test/socket");

            socket.open();
            expect(client.isOpen()).toBe(true);
            expect(events).toContain("open");

            const requestPromise = client.request<{ answer: number }>("answer", {
                question: true,
            });
            expect(JSON.parse(socket.sent[0]!)).toEqual({
                type: "req",
                id: "1",
                method: "answer",
                params: { question: true },
            });
            socket.message({
                type: "response",
                id: "1",
                isOk: true,
                payload: { answer: 42 },
            });
            await expect(requestPromise).resolves.toEqual({ answer: 42 });

            const rejectedPromise = client.request("fail");
            socket.message({
                type: "response",
                id: "2",
                isOk: false,
                error: "nope",
            });
            await expect(rejectedPromise).rejects.toBe("nope");

            socket.message({ type: "event", event: "agents.list", payload: [] });
            socket.error();
            expect(events).toContain("message");
            expect(events).toContain("error");

            const pendingPromise = client.request("pending");
            client.disconnect();
            await expect(pendingPromise).rejects.toThrow("WebSocket disconnected");
            expect(client.isOpen()).toBe(false);
        } finally {
            Object.defineProperty(globalThis, "WebSocket", {
                configurable: true,
                value: originalWebSocket,
                writable: true,
            });
        }
    });

    it("connects the OpenClaw socket provider, publishes messages, and cleans up", async () => {
        const originalWebSocket = WebSocket;
        FakeWebSocket.instances = [];
        Object.defineProperty(globalThis, "WebSocket", {
            configurable: true,
            value: FakeWebSocket,
            writable: true,
        });
        authActions.setSession({
            authenticated: true,
            isBootstrapRequired: false,
            user: { id: 1, username: "raymond" },
        });
        const receivedMessages: unknown[] = [];
        const lifecycle: string[] = [];

        try {
            const { result, unmount } = renderHook(
                () =>
                    useOpenClawSocket({
                        onConnect: () => {
                            lifecycle.push("connect");
                        },
                        onDisconnect: () => {
                            lifecycle.push("disconnect");
                        },
                    }),
                { wrapper: openClawSocketWrapper }
            );

            await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
            const socket = FakeWebSocket.instances[0]!;
            const unsubscribe = result.current.subscribe((message) => {
                receivedMessages.push(message);
            });

            act(() => {
                socket.open();
            });
            await waitFor(() => expect(result.current.isConnected).toBe(true));
            expect(lifecycle).toContain("connect");
            act(() => {
                socket.message({ type: "response", id: "1", isOk: true, payload: [] });
            });

            const request = result.current.request<{ pong: true }>("ping", {
                value: 1,
            });
            expect(JSON.parse(socket.sent.at(-1)!)).toEqual({
                type: "req",
                id: "2",
                method: "ping",
                params: { value: 1 },
            });
            act(() => {
                socket.message({
                    type: "response",
                    id: "2",
                    isOk: true,
                    payload: { pong: true },
                });
            });
            await expect(request).resolves.toEqual({ pong: true });

            act(() => {
                socket.message({ type: "state", gatewayConnected: false });
            });
            await waitFor(() => expect(result.current.isConnected).toBe(false));
            expect(receivedMessages).toContainEqual({
                type: "state",
                gatewayConnected: false,
            });

            unsubscribe();
            act(() => {
                result.current.disconnect();
            });
            expect(result.current.isConnected).toBe(false);
            unmount();
        } finally {
            authActions.clearSession();
            Object.defineProperty(globalThis, "WebSocket", {
                configurable: true,
                value: originalWebSocket,
                writable: true,
            });
        }
    });

    it("writes live agent, log, and session updates into ready collections", () => {
        preloadAgentsCollection();
        preloadLogsCollection();
        preloadSessionsCollection();

        const agentUpserts: Array<Partial<Record<string, unknown>>> = [];
        const restoreAgents = patchWritableCollection(agentsCollection, [], {
            writeUpsert: (item) => {
                agentUpserts.push(item);
            },
        });
        try {
            writeAgentsFromWebSocket([
                { id: "mira-2026", name: "Mira", status: "online" },
            ]);
            expect(agentUpserts).toEqual([
                { id: "mira-2026", name: "Mira", status: "online" },
            ]);
        } finally {
            restoreAgents();
        }

        const logUpserts: Array<Partial<Record<string, unknown>>> = [];
        const restoreLogs = patchWritableCollection(logsCollection, [], {
            writeUpsert: (item) => {
                logUpserts.push(item);
            },
        });
        try {
            writeLogFromWebSocket(
                '{"_meta":{"logLevelName":"INFO","date":"2026-06-23T08:00:00.000Z"},"0":"[gateway] connected"}',
                "42"
            );
            writeLogFromWebSocket("");
            writeLogFromWebSocket("{bad json");
            handleSocketMessage({ type: "log_file", file: "openclaw.log" });
            handleSocketMessage({
                history: true,
                line: "history from socket should be ignored",
                lineId: "100",
                type: "log",
            });
            handleSocketMessage({
                line: "live from socket should be written while history is loading",
                lineId: "101",
                type: "log",
            });
            handleSocketMessage({ type: "log_history_complete", count: 1 });
            expect(logUpserts[0]).toMatchObject({
                level: "info",
                lineId: "42",
                subsystem: "gateway",
                msg: "connected",
            });
            expect(logUpserts[1]).toMatchObject({
                id: expect.stringContaining("{bad json"),
                dedupeKey: "|||{bad json",
                subsystem: "",
                msg: "{bad json",
                raw: "{bad json",
            });
            expect(logUpserts).toHaveLength(3);
            expect(logUpserts[2]).toMatchObject({
                lineId: "101",
                msg: "live from socket should be written while history is loading",
            });
        } finally {
            restoreLogs();
        }

        const sessionDeletes: string[] = [];
        const sessionUpserts: Array<Partial<Record<string, unknown>>> = [];
        const restoreSessions = patchWritableCollection(
            sessionsCollection,
            [
                ["old-session", { key: "old-session" }],
                ["fallback-id", { key: "fallback-id" }],
            ],
            {
                writeDelete: (key) => {
                    sessionDeletes.push(key);
                },
                writeUpsert: (item) => {
                    sessionUpserts.push(item);
                },
            }
        );
        try {
            replaceSessionsFromWebSocket([
                {
                    id: "fallback-id",
                    key: " ".repeat(3),
                    type: "main",
                    displayLabel: "Fallback",
                },
                { id: "", key: " ".repeat(3), type: "invalid" },
            ]);
            expect(sessionDeletes).toEqual(["old-session"]);
            expect(sessionUpserts).toEqual([
                {
                    id: "fallback-id",
                    key: " ".repeat(3),
                    type: "main",
                    displayLabel: "Fallback",
                },
            ]);

            deleteSessionFromCollection("fallback-id");
            expect(sessionDeletes).toEqual(["old-session", "fallback-id"]);
        } finally {
            restoreSessions();
        }
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
                    return Response.json({
                        content: "info line\nerror line",
                        lineIds: ["10", false, 20, { id: "30" }, "40"],
                    });
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

                if (url === "/api/agents/status" && method === "GET") {
                    return Response.json({
                        agents: [
                            {
                                id: "main",
                                name: "Mira",
                                status: "online",
                                currentTask: "Expanding tests",
                            },
                        ],
                        timestamp: 1_782_475_200_000,
                    });
                }

                if (url === "/api/agents/config" && method === "GET") {
                    return Response.json({
                        defaults: {
                            model: { primary: "codex", fallbacks: ["kimi"] },
                        },
                        list: [
                            {
                                default: true,
                                id: "main",
                                model: { primary: "codex", fallbacks: ["kimi"] },
                                subagents: { allowAgents: ["coder"] },
                            },
                        ],
                    });
                }

                if (url === "/api/agents/tasks/history?limit=3" && method === "GET") {
                    return Response.json({
                        tasks: [
                            {
                                archivedAt: "2026-06-23T08:00:00.000Z",
                                task: "Finished a coverage batch",
                            },
                        ],
                        timestamp: 1_782_475_201_000,
                    });
                }

                if (url === "/api/agents/main/status" && method === "GET") {
                    return Response.json({
                        id: "main",
                        name: "Mira",
                        status: "online",
                        currentTask: "Expanding tests",
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
            expect(logContent.result.current.data).toEqual({
                content: "info line\nerror line",
                lineIds: ["10", undefined, 20, undefined, "40"],
            })
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

        const agentsStatus = renderHookWithQueryClient(() => useAgentsStatus());
        await waitFor(() =>
            expect(agentsStatus.result.current.data?.agents[0]?.currentTask).toBe(
                "Expanding tests"
            )
        );

        const agentsConfig = renderHookWithQueryClient(() => useAgentsConfig());
        await waitFor(() =>
            expect(agentsConfig.result.current.data?.defaults.model?.primary).toBe(
                "codex"
            )
        );

        const agentTaskHistory = renderHookWithQueryClient(() => useAgentTaskHistory(3));
        await waitFor(() =>
            expect(agentTaskHistory.result.current.data?.tasks[0]?.task).toBe(
                "Finished a coverage batch"
            )
        );

        const agentStatus = renderHookWithQueryClient(() => useAgentStatus("main"));
        await waitFor(() =>
            expect(agentStatus.result.current.data?.currentTask).toBe("Expanding tests")
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

    it("fetches health and metrics through dashboard hooks", async () => {
        const fetchMock = jest.fn(
            async (input: RequestInfo | URL, init?: RequestInit) => {
                const url = String(input);
                const method = init?.method ?? "GET";

                if (url === "/api/health" && method === "GET") {
                    return Response.json({
                        status: "isOk",
                        gatewayConnected: true,
                        sessionCount: 2,
                        backendCommit: "abc123",
                    });
                }

                if (url === "/api/metrics" && method === "GET") {
                    return Response.json({
                        cpu: {
                            count: 4,
                            model: "test cpu",
                            loadAvg: [0.1, 0.2, 0.3],
                            loadPercent: 5,
                        },
                        memory: {
                            total: 100,
                            used: 40,
                            free: 60,
                            percent: 40,
                            totalGB: 0.1,
                            usedGB: 0.04,
                        },
                        disk: {
                            total: 1000,
                            used: 250,
                            percent: 25,
                            totalGB: 1,
                            usedGB: 0.25,
                        },
                        system: {
                            uptime: 123,
                            platform: "linux",
                            hostname: "dashboard-test",
                        },
                        network: { downloadMbps: 1, uploadMbps: 2 },
                        tokens: {
                            total: 42,
                            byModel: { codex: 42 },
                            sessionsByModel: { codex: 1 },
                            byAgent: [
                                {
                                    label: "Mira",
                                    model: "codex",
                                    tokens: 42,
                                    type: "MAIN",
                                },
                            ],
                        },
                        timestamp: 123_456,
                    });
                }

                throw new Error(`Unexpected health API call: ${method} ${url}`);
            }
        );
        Object.defineProperty(globalThis, "fetch", {
            configurable: true,
            value: fetchMock,
            writable: true,
        });

        const health = renderHookWithQueryClient(() => useHealth());
        await waitFor(() => expect(health.result.current.data?.status).toBe("isOk"));

        const metrics = renderHookWithQueryClient(() => useMetrics());
        await waitFor(() => expect(metrics.result.current.data?.tokens.total).toBe(42));
    });

    it("fetches and refreshes cache-backed dashboard data through hooks", async () => {
        const fetchMock = jest.fn(
            async (input: RequestInfo | URL, init?: RequestInit) => {
                const url = String(input);
                const method = init?.method ?? "GET";

                if (url === "/api/cache/heartbeat" && method === "GET") {
                    return Response.json({
                        generatedAt: "2026-06-23T08:00:00.000Z",
                        count: 1,
                        entries: [
                            {
                                key: "weather.spydeberg",
                                source: "weather",
                                status: "fresh",
                                updatedAt: "2026-06-23T08:00:00.000Z",
                                lastAttemptAt: "2026-06-23T08:00:00.000Z",
                                expiresAt: "2026-06-23T09:00:00.000Z",
                                consecutiveFailures: 0,
                                data: { location: "Spydeberg" },
                                meta: {},
                            },
                        ],
                    });
                }

                if (url === "/api/cache/weather.spydeberg" && method === "GET") {
                    return Response.json({
                        key: "weather.spydeberg",
                        source: "weather",
                        status: "fresh",
                        consecutiveFailures: 0,
                        data: {
                            location: "Spydeberg",
                            temperatureC: 20,
                            description: "Clear",
                            forecast: [],
                            fetchedAt: 123,
                        },
                        meta: {},
                    });
                }

                if (url === "/api/cache/quotas.summary" && method === "GET") {
                    return Response.json({
                        key: "quotas.summary",
                        source: "quota",
                        status: "fresh",
                        consecutiveFailures: 0,
                        data: {
                            checkedAt: 123,
                            cacheAgeMs: 100,
                            openrouter: {
                                usage: 1,
                                totalCredits: 10,
                                remaining: 9,
                                usageMonthly: 1,
                                percentUsed: 10,
                            },
                            elevenlabs: { status: "not_configured" },
                            synthetic: { status: "error", note: "offline" },
                            openai: {
                                fiveHourLeftPercent: 90,
                                weeklyLeftPercent: 80,
                                percentUsed: 10,
                            },
                        },
                        meta: {},
                    });
                }

                if (url === "/api/cache/moltbook.home" && method === "GET") {
                    return Response.json({
                        key: "moltbook.home",
                        source: "moltbook",
                        status: "fresh",
                        consecutiveFailures: 0,
                        data: {
                            pendingRequestCount: 1,
                            unreadMessageCount: 2,
                            activityOnYourPostsCount: 0,
                            activityOnYourPosts: [],
                            postsFromAccountsYouFollowCount: 1,
                            exploreCount: 1,
                            nextActions: ["reply"],
                            fetchedAt: "2026-06-23T08:00:00.000Z",
                        },
                        meta: {},
                    });
                }

                if (url === "/api/cache/moltbook.feed.hot" && method === "GET") {
                    return Response.json({
                        key: "moltbook.feed.hot",
                        source: "moltbook",
                        status: "fresh",
                        consecutiveFailures: 0,
                        data: {
                            posts: [
                                {
                                    post_id: "post-1",
                                    title: "Hello",
                                    content_preview: "Preview",
                                    author_name: "mira",
                                    upvotes: 3,
                                    downvotes: 0,
                                    comment_count: 1,
                                    created_at: "2026-06-23T08:00:00.000Z",
                                    submolt_name: "agents",
                                },
                            ],
                        },
                        meta: {},
                    });
                }

                if (url === "/api/cache/moltbook.feed.new" && method === "GET") {
                    return Response.json({
                        key: "moltbook.feed.new",
                        source: "moltbook",
                        status: "fresh",
                        consecutiveFailures: 0,
                        data: {
                            posts: [
                                {
                                    id: "post-2",
                                    title: "Nested author",
                                    content: "Full post",
                                    author: {
                                        name: "raymond",
                                        display_name: "Raymond",
                                        avatar_url: "/avatar.png",
                                    },
                                    created_at: "2026-06-23T08:30:00.000Z",
                                    submolt_name: "dashboard",
                                    you_follow_author: true,
                                },
                            ],
                        },
                        meta: {},
                    });
                }

                if (url === "/api/cache/moltbook.profile" && method === "GET") {
                    return Response.json({
                        key: "moltbook.profile",
                        source: "moltbook",
                        status: "fresh",
                        consecutiveFailures: 0,
                        data: { agent: { id: "mira", name: "Mira" } },
                        meta: {},
                    });
                }

                if (url === "/api/cache/moltbook.my-content" && method === "GET") {
                    return Response.json({
                        key: "moltbook.my-content",
                        source: "moltbook",
                        status: "fresh",
                        consecutiveFailures: 0,
                        data: { posts: [], comments: [] },
                        meta: {},
                    });
                }

                if (url === "/api/cache/weather.spydeberg/refresh" && method === "POST") {
                    return Response.json({
                        isOk: true,
                        entry: {
                            key: "weather.spydeberg",
                            source: "weather",
                            status: "fresh",
                            consecutiveFailures: 0,
                            data: { location: "Spydeberg" },
                            meta: {},
                        },
                    });
                }

                throw new Error(`Unexpected cache API call: ${method} ${url}`);
            }
        );
        Object.defineProperty(globalThis, "fetch", {
            configurable: true,
            value: fetchMock,
            writable: true,
        });

        const cacheHeartbeat = renderHookWithQueryClient(() => useCacheHeartbeat());
        await waitFor(() => expect(cacheHeartbeat.result.current.data?.count).toBe(1));

        const weatherEntry = renderHookWithQueryClient(() =>
            useCacheEntry<{ location: string }>("weather.spydeberg")
        );
        await waitFor(() =>
            expect(weatherEntry.result.current.data?.data.location).toBe("Spydeberg")
        );

        const weather = renderHookWithQueryClient(() => useWeather());
        await waitFor(() =>
            expect(weather.result.current.data?.location).toBe("Spydeberg")
        );

        const quotas = renderHookWithQueryClient(() => useQuotas());
        await waitFor(() =>
            expect(quotas.result.current.data?.openrouter).toMatchObject({
                remaining: 9,
            })
        );

        const moltbook = renderHookWithQueryClient(() => useMoltbookData("hot"));
        await waitFor(() => expect(moltbook.result.current.posts[0]?.id).toBe("post-1"));
        await waitFor(() => expect(moltbook.result.current.profile?.name).toBe("Mira"));
        act(() => {
            moltbook.result.current.refetch();
        });
        await waitFor(() =>
            expect(fetchMock).toHaveBeenCalledWith(
                "/api/cache/moltbook.home",
                expect.objectContaining({ credentials: "include" })
            )
        );

        const newestMoltbook = renderHookWithQueryClient(() => useMoltbookData("new"));
        await waitFor(() =>
            expect(newestMoltbook.result.current.posts[0]).toMatchObject({
                id: "post-2",
                content: "Full post",
                author: {
                    name: "raymond",
                    display_name: "Raymond",
                    avatar_url: "/avatar.png",
                },
                upvotes: 0,
                you_follow_author: true,
            })
        );

        const refreshCache = renderHookWithQueryClient(() => useRefreshCacheEntry());
        await expect(
            refreshCache.result.current.mutateAsync(" weather.spydeberg ,, ")
        ).resolves.toMatchObject({ keys: ["weather.spydeberg"] });
    });

    it("fetches and mutates cron jobs through hooks", async () => {
        const fetchMock = jest.fn(
            async (input: RequestInfo | URL, init?: RequestInit) => {
                const url = String(input);
                const method = init?.method ?? "GET";

                if (url === "/api/cron/jobs" && method === "GET") {
                    return Response.json({
                        jobs: [{ id: "cron-1", name: "Cron One", enabled: true }],
                    });
                }

                if (url === "/api/cron/jobs/cron-1/toggle" && method === "POST") {
                    expect(JSON.parse(String(init?.body))).toEqual({ enabled: false });
                    return Response.json({ isOk: true });
                }

                if (url === "/api/cron/jobs/cron-1/update" && method === "POST") {
                    expect(JSON.parse(String(init?.body))).toEqual({
                        patch: { schedule: { kind: "interval", every: "5m" } },
                    });
                    return Response.json({ isOk: true });
                }

                if (url === "/api/cron/jobs/cron-1/run" && method === "POST") {
                    return Response.json({ isOk: true });
                }

                if (url === "/api/cron/jobs/cron-1/delete" && method === "POST") {
                    return Response.json({ isOk: true });
                }

                throw new Error(`Unexpected cron API call: ${method} ${url}`);
            }
        );
        Object.defineProperty(globalThis, "fetch", {
            configurable: true,
            value: fetchMock,
            writable: true,
        });

        const cronJobs = renderHookWithQueryClient(() => useCronJobs());
        await waitFor(() => expect(cronJobs.result.current.data?.[0]?.id).toBe("cron-1"));

        const toggleCron = renderHookWithQueryClient(() => useToggleCronJob());
        await toggleCron.result.current.mutateAsync({ id: "cron-1", enabled: false });

        const updateCron = renderHookWithQueryClient(() => useUpdateCronJob());
        await updateCron.result.current.mutateAsync({
            id: "cron-1",
            patch: { schedule: { kind: "interval", every: "5m" } },
        });

        const runCron = renderHookWithQueryClient(() => useRunCronJobNow());
        await runCron.result.current.mutateAsync({ id: "cron-1" });

        const deleteCron = renderHookWithQueryClient(() => useDeleteCronJob());
        await deleteCron.result.current.mutateAsync({ id: "cron-1" });
    });

    it("fetches and mutates config, skills, and service operations through hooks", async () => {
        const fetchMock = jest.fn(
            async (input: RequestInfo | URL, init?: RequestInit) => {
                const url = String(input);
                const method = init?.method ?? "GET";

                if (url === "/api/config" && method === "GET") {
                    return Response.json({
                        __hash: "hash-1",
                        agents: { defaults: { model: { primary: "codex" } } },
                    });
                }

                if (url === "/api/config" && method === "PUT") {
                    expect(JSON.parse(String(init?.body))).toEqual({
                        __hash: "hash-1",
                        agents: { defaults: { model: { primary: "codex" } } },
                    });
                    return Response.json({ isOk: true, result: { hash: "hash-2" } });
                }

                if (url === "/api/skills" && method === "GET") {
                    return Response.json({
                        skills: [
                            {
                                name: "weather",
                                path: "skills.entries.weather",
                                enabled: true,
                                source: "workspace",
                            },
                        ],
                    });
                }

                if (url === "/api/skills/weather" && method === "POST") {
                    expect(JSON.parse(String(init?.body))).toEqual({
                        __hash: "hash-1",
                        enabled: false,
                    });
                    return Response.json({ isOk: true });
                }

                if (url === "/api/backup" && method === "POST") {
                    return Response.json({
                        createdAt: "2026-06-23T08:00:00.000Z",
                        hash: "hash-1",
                        config: { agents: {} },
                    });
                }

                if (url === "/api/restart" && method === "POST") {
                    return new Response(undefined, { status: 204 });
                }

                throw new Error(`Unexpected config API call: ${method} ${url}`);
            }
        );
        Object.defineProperty(globalThis, "fetch", {
            configurable: true,
            value: fetchMock,
            writable: true,
        });

        const config = renderHookWithQueryClient(() => useConfig());
        await waitFor(() => expect(config.result.current.data?.__hash).toBe("hash-1"));

        const skills = renderHookWithQueryClient(() => useSkills());
        await waitFor(() =>
            expect(skills.result.current.data?.[0]?.name).toBe("weather")
        );

        const toggleSkill = renderHookWithQueryClient(() => useToggleSkill());
        toggleSkill.queryClient.setQueryData(["config"], { __hash: "hash-1" });
        await toggleSkill.result.current.mutateAsync({
            name: "weather",
            enabled: false,
        });

        const updateConfig = renderHookWithQueryClient(() => useUpdateConfig());
        await updateConfig.result.current.mutateAsync({
            __hash: "hash-1",
            agents: { defaults: { model: { primary: "codex" } } },
        });
        expect(
            updateConfig.queryClient.getQueryData<{ __hash?: string }>(["config"])?.__hash
        ).toBe("hash-2");

        const restartGateway = renderHookWithQueryClient(() => useRestartGateway());
        await expect(
            restartGateway.result.current.mutateAsync()
        ).resolves.toBeUndefined();

        const backup = renderHookWithQueryClient(() => useCreateBackup());
        await expect(backup.result.current.mutateAsync()).resolves.toMatchObject({
            hash: "hash-1",
        });
    });

    it("preserves cached nested config when update response only returns a hash", async () => {
        const fetchMock = jest.fn(
            async (input: RequestInfo | URL, init?: RequestInit) => {
                const url = String(input);
                const method = init?.method ?? "GET";

                if (url === "/api/config" && method === "GET") {
                    return Response.json({
                        __hash: "hash-1",
                        agents: {
                            defaults: { model: { primary: "codex" } },
                            list: [{ id: "ops", name: "Ops" }],
                        },
                    });
                }

                if (url === "/api/config" && method === "PUT") {
                    return Response.json({ isOk: true, result: { hash: "hash-2" } });
                }

                throw new Error(`Unexpected config API call: ${method} ${url}`);
            }
        );
        Object.defineProperty(globalThis, "fetch", {
            configurable: true,
            value: fetchMock,
            writable: true,
        });

        const updateConfig = renderHookWithQueryClient(() => useUpdateConfig());
        updateConfig.queryClient.setQueryData<OpenClawConfig>(["config"], {
            __hash: "hash-1",
            agents: {
                defaults: { model: { primary: "codex" } },
                list: [{ id: "ops", name: "Ops" }],
            },
        });
        await updateConfig.result.current.mutateAsync({
            agents: { defaults: { model: { primary: "gpt-5.5" } } },
        });

        expect(
            updateConfig.queryClient.getQueryData<OpenClawConfig>(["config"])
        ).toMatchObject({
            __hash: "hash-2",
            agents: {
                defaults: { model: { primary: "codex" } },
                list: [{ id: "ops", name: "Ops" }],
            },
        });
    });

    it("fetches database overview and mutates sessions through hooks", async () => {
        const fetchMock = jest.fn(
            async (input: RequestInfo | URL, init?: RequestInit) => {
                const url = String(input);
                const method = init?.method ?? "GET";

                if (url === "/api/database/overview" && method === "GET") {
                    return Response.json({
                        overview: {
                            totalDatabaseSizeBytes: 1024,
                            totalBackends: 2,
                            averageCacheHitRatio: 99,
                            connections: {},
                            pgStatStatementsEnabled: true,
                            torrentCounts: { comet: 1, bitmagnet: 2 },
                            pgbouncer: {
                                clientConnections: 1,
                                serverConnections: 1,
                                waitingClients: 0,
                                maxWait: 0,
                                avgQueryTime: 1,
                                avgTransactionTime: 2,
                            },
                        },
                        databases: [],
                        deadTuples: [],
                        topQueries: [],
                        pgbouncerPools: [],
                        pgbouncerStats: [],
                    });
                }

                if (url === "/api/sessions/session-1/action" && method === "POST") {
                    expect(JSON.parse(String(init?.body))).toEqual({ action: "compact" });
                    return new Response(undefined, { status: 204 });
                }

                if (url === "/api/sessions/session-1" && method === "DELETE") {
                    return Response.json({ isOk: true });
                }

                throw new Error(`Unexpected database/session API call: ${method} ${url}`);
            }
        );
        Object.defineProperty(globalThis, "fetch", {
            configurable: true,
            value: fetchMock,
            writable: true,
        });

        const database = renderHookWithQueryClient(() => useDatabaseOverview());
        await waitFor(() =>
            expect(database.result.current.data?.overview.totalBackends).toBe(2)
        );

        const sessionAction = renderHookWithQueryClient(() => useSessionAction());
        await sessionAction.result.current.mutateAsync({
            key: "session-1",
            action: "compact",
        });

        const deleteSession = renderHookWithQueryClient(() => useDeleteSession());
        await deleteSession.result.current.mutateAsync("session-1");
    });

    it("runs terminal and exec operations through hooks", async () => {
        const fetchMock = jest.fn(
            async (input: RequestInfo | URL, init?: RequestInit) => {
                const url = String(input);
                const method = init?.method ?? "GET";

                if (url === "/api/exec/start" && method === "POST") {
                    const body = JSON.parse(String(init?.body)) as {
                        command?: string;
                        cwd?: string;
                        shell?: boolean;
                    };
                    if (body.command === "pwd") {
                        expect(body).toEqual({
                            command: "pwd",
                            cwd: "/tmp",
                        });
                    } else {
                        expect(body).toMatchObject({
                            command: OPS_ACTIONS[0]!.command,
                            shell: true,
                        });
                    }
                    return Response.json({ jobId: "job-1" });
                }

                if (url === "/api/exec/job-1" && method === "GET") {
                    return Response.json({
                        jobId: "job-1",
                        status: "done",
                        code: 0,
                        stdout: "/tmp",
                        stderr: "",
                        startedAt: 1,
                        endedAt: 2,
                    });
                }

                if (url === "/api/terminal/complete" && method === "POST") {
                    expect(JSON.parse(String(init?.body))).toEqual({
                        partial: "sr",
                        cwd: "/tmp",
                    });
                    return Response.json({
                        commonPrefix: "src",
                        completions: [
                            { completion: "src", display: "src/", type: "directory" },
                        ],
                    });
                }

                if (url === "/api/terminal/cd" && method === "POST") {
                    expect(JSON.parse(String(init?.body))).toEqual({
                        path: "src",
                        cwd: "/tmp",
                    });
                    return Response.json({ isSuccess: true, newCwd: "/tmp/src" });
                }

                if (url === "/api/exec/job-1/stop" && method === "POST") {
                    return new Response(undefined, { status: 204 });
                }

                throw new Error(`Unexpected terminal API call: ${method} ${url}`);
            }
        );
        Object.defineProperty(globalThis, "fetch", {
            configurable: true,
            value: fetchMock,
            writable: true,
        });

        const terminalStart = renderHookWithQueryClient(() => useStartTerminalCommand());
        await expect(
            terminalStart.result.current.mutateAsync({ command: "pwd", cwd: "/tmp" })
        ).resolves.toEqual({ jobId: "job-1" });

        const opsStart = renderHookWithQueryClient(() => useStartOpsAction());
        await expect(
            opsStart.result.current.mutateAsync(OPS_ACTIONS[0]!)
        ).resolves.toEqual({ jobId: "job-1" });

        const opsJob = renderHookWithQueryClient(() => useExecJob("job-1"));
        await waitFor(() => expect(opsJob.result.current.data?.status).toBe("done"));

        const terminalJob = renderHookWithQueryClient(() => useTerminalJob("job-1"));
        await waitFor(() => expect(terminalJob.result.current.data?.stdout).toBe("/tmp"));

        await expect(getCompletions("sr", "/tmp")).resolves.toMatchObject({
            commonPrefix: "src",
        });
        await expect(changeDirectory("src", "/tmp")).resolves.toEqual({
            isSuccess: true,
            newCwd: "/tmp/src",
        });
        await expect(stopTerminalJob("job-1")).resolves.toBeUndefined();

        const terminalHistory = renderHookWithQueryClient(() => useTerminalHistory());
        let historyId = "";
        act(() => {
            historyId = terminalHistory.result.current.addCommand({
                command: "pwd",
                cwd: "/tmp",
                jobId: "job-1",
                status: "running",
                stdout: "",
                stderr: "",
                startedAt: 1,
            });
        });
        expect(terminalHistory.result.current.history).toHaveLength(1);
        act(() => {
            terminalHistory.result.current.updateCommand(historyId, {
                status: "done",
                stdout: "/tmp",
            });
        });
        expect(terminalHistory.result.current.history[0]).toMatchObject({
            status: "done",
            stdout: "/tmp",
        });
        act(() => {
            terminalHistory.result.current.clearHistory();
        });
        expect(terminalHistory.result.current.history).toEqual([]);
    });

    it("mutates pull request review and deploy operations through hooks", async () => {
        const fetchMock = jest.fn(
            async (input: RequestInfo | URL, init?: RequestInit) => {
                const url = String(input);
                const method = init?.method ?? "GET";

                if (url === "/api/pull-requests/189/approve" && method === "POST") {
                    expect(JSON.parse(String(init?.body))).toEqual({ deploy: true });
                    return Response.json({ isOk: true, message: "approved" });
                }

                if (
                    url === "/api/pull-requests/189/review-approval" &&
                    method === "POST"
                ) {
                    return Response.json({
                        isOk: true,
                        message: "review approved",
                        pullRequest: {
                            number: 189,
                            title: "Updated review",
                            url: "/pull/189",
                            headRefName: "tests",
                            baseRefName: "main",
                            author: {},
                            createdAt: "2026-06-23T08:00:00.000Z",
                            updatedAt: "2026-06-23T09:00:00.000Z",
                            isDraft: false,
                        },
                    });
                }

                if (url === "/api/pull-requests/189/update-branch" && method === "POST") {
                    return Response.json({
                        isOk: true,
                        message: "updated",
                        pullRequest: {
                            number: 189,
                            title: "Updated branch",
                            url: "/pull/189",
                            headRefName: "tests",
                            baseRefName: "main",
                            author: {},
                            createdAt: "2026-06-23T08:00:00.000Z",
                            updatedAt: "2026-06-23T09:00:00.000Z",
                            isDraft: false,
                        },
                    });
                }

                if (url === "/api/pull-requests/189/reject" && method === "POST") {
                    expect(JSON.parse(String(init?.body))).toEqual({
                        comment: "needs work",
                    });
                    return Response.json({ isOk: true, message: "rejected" });
                }

                if (url === "/api/pull-requests/deploy" && method === "POST") {
                    return Response.json({
                        isOk: true,
                        deployment: {
                            id: "deploy-2",
                            status: "building",
                            startedAt: "2026-06-23T08:00:00.000Z",
                            updatedAt: "2026-06-23T08:00:00.000Z",
                        },
                    });
                }

                throw new Error(`Unexpected pull request API call: ${method} ${url}`);
            }
        );
        Object.defineProperty(globalThis, "fetch", {
            configurable: true,
            value: fetchMock,
            writable: true,
        });

        const approvePullRequest = renderHookWithQueryClient(() =>
            useApprovePullRequest()
        );
        await approvePullRequest.result.current.mutateAsync({
            number: 189,
            willDeploy: true,
        });

        const approveReview = renderHookWithQueryClient(() =>
            useApprovePullRequestReview()
        );
        await expect(
            approveReview.result.current.mutateAsync({ number: 189 })
        ).resolves.toMatchObject({ message: "review approved" });

        const updateBranch = renderHookWithQueryClient(() =>
            useUpdatePullRequestBranch()
        );
        await expect(
            updateBranch.result.current.mutateAsync({ number: 189 })
        ).resolves.toMatchObject({ message: "updated" });

        const rejectPullRequest = renderHookWithQueryClient(() => useRejectPullRequest());
        await rejectPullRequest.result.current.mutateAsync({
            number: 189,
            comment: "needs work",
        });

        const deploy = renderHookWithQueryClient(() => useDeployDashboard());
        await expect(deploy.result.current.mutateAsync()).resolves.toMatchObject({
            deployment: { id: "deploy-2" },
        });
    });

    it("drives task update, move, assignment, deletion, and progress update hooks", async () => {
        const clearedAutomation = JSON.parse("null") as null;
        const fetchMock = jest.fn(
            async (input: RequestInfo | URL, init?: RequestInit) => {
                const url = String(input);
                const method = init?.method ?? "GET";

                if (url === "/api/tasks/1/updates" && method === "GET") {
                    return Response.json([
                        {
                            id: 7,
                            taskId: 1,
                            author: "mira-2026",
                            messageMd: "Initial update",
                            createdAt: "2026-06-23T08:00:00.000Z",
                            updatedAt: "2026-06-23T08:00:00.000Z",
                        },
                    ]);
                }

                if (url === "/api/tasks/1" && method === "PATCH") {
                    expect(JSON.parse(String(init?.body))).toEqual({
                        title: "Updated task",
                        automation: clearedAutomation,
                    });
                    return Response.json(task({ number: 1, title: "Updated task" }));
                }

                if (url === "/api/tasks/1/move" && method === "POST") {
                    expect(JSON.parse(String(init?.body))).toEqual({
                        columnLabel: "done",
                    });
                    return Response.json(
                        task({
                            number: 1,
                            title: "Moved task",
                            labels: [{ name: "done" }],
                        })
                    );
                }

                if (url === "/api/tasks/1/assign" && method === "POST") {
                    expect(JSON.parse(String(init?.body))).toEqual({
                        assignee: "mira-2026",
                    });
                    return Response.json(
                        task({
                            number: 1,
                            title: "Assigned task",
                            assignees: [{ login: "mira-2026", name: "Mira" }],
                        })
                    );
                }

                if (url === "/api/tasks/1" && method === "DELETE") {
                    return new Response(undefined, { status: 204 });
                }

                if (url === "/api/tasks/1/updates" && method === "POST") {
                    expect(JSON.parse(String(init?.body))).toEqual({
                        author: "mira-2026",
                        messageMd: "Progress",
                    });
                    return Response.json({
                        id: 8,
                        taskId: 1,
                        author: "mira-2026",
                        messageMd: "Progress",
                        createdAt: "2026-06-23T09:00:00.000Z",
                        updatedAt: "2026-06-23T09:00:00.000Z",
                    });
                }

                if (url === "/api/tasks/1/updates/7" && method === "PATCH") {
                    expect(JSON.parse(String(init?.body))).toEqual({
                        author: "rajohan",
                        messageMd: "Edited",
                    });
                    return Response.json({
                        id: 7,
                        taskId: 1,
                        author: "rajohan",
                        messageMd: "Edited",
                        createdAt: "2026-06-23T08:00:00.000Z",
                    });
                }

                if (url === "/api/tasks/1/updates/7" && method === "DELETE") {
                    return new Response(undefined, { status: 204 });
                }

                throw new Error(`Unexpected task API call: ${method} ${url}`);
            }
        );
        Object.defineProperty(globalThis, "fetch", {
            configurable: true,
            value: fetchMock,
            writable: true,
        });

        const updates = renderHookWithQueryClient(() => useTaskUpdates(1));
        await waitFor(() =>
            expect(updates.result.current.data?.[0]?.messageMd).toBe("Initial update")
        );

        const updateTask = renderHookWithQueryClient(() => useUpdateTask());
        updateTask.queryClient.setQueryData(taskKeys.list(), [
            task({ number: 1, title: "Old task" }),
        ]);
        await expect(
            updateTask.result.current.mutateAsync({
                number: 1,
                updates: { title: "Updated task", automation: clearedAutomation },
            })
        ).resolves.toMatchObject({ title: "Updated task" });

        const moveTask = renderHookWithQueryClient(() => useMoveTask());
        await expect(
            moveTask.result.current.mutateAsync({ number: 1, columnLabel: "done" })
        ).resolves.toMatchObject({ title: "Moved task" });

        const assignTask = renderHookWithQueryClient(() => useAssignTask());
        await expect(
            assignTask.result.current.mutateAsync({
                number: 1,
                assignee: "mira-2026",
            })
        ).resolves.toMatchObject({ title: "Assigned task" });

        const createUpdate = renderHookWithQueryClient(() => useCreateTaskUpdate());
        await expect(
            createUpdate.result.current.mutateAsync({
                taskId: 1,
                author: "mira-2026",
                messageMd: "Progress",
            })
        ).resolves.toMatchObject({ id: 8, messageMd: "Progress" });

        const editUpdate = renderHookWithQueryClient(() => useUpdateTaskUpdate());
        await expect(
            editUpdate.result.current.mutateAsync({
                taskId: 1,
                updateId: 7,
                author: "rajohan",
                messageMd: "Edited",
            })
        ).resolves.toMatchObject({ author: "rajohan", messageMd: "Edited" });

        const deleteUpdate = renderHookWithQueryClient(() => useDeleteTaskUpdate());
        await expect(
            deleteUpdate.result.current.mutateAsync({ taskId: 1, updateId: 7 })
        ).resolves.toBeUndefined();

        const deleteTask = renderHookWithQueryClient(() => useDeleteTask());
        await expect(
            deleteTask.result.current.mutateAsync({ number: 1 })
        ).resolves.toBeUndefined();
    });

    it("drives backup attention, notification creation, quota guards, overlay, and date format behavior", async () => {
        const fetchMock = jest.fn(
            async (input: RequestInfo | URL, init?: RequestInit) => {
                const url = String(input);
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
                    expect(JSON.parse(String(init?.body))).toEqual({
                        title: "Functional coverage",
                        description: "Created from a hook",
                        source: "tests",
                    });
                    return Response.json({ isOk: true, id: 123 });
                }

                if (url === "/api/notifications/mark-all-read" && method === "POST") {
                    return Response.json({ isOk: true });
                }

                throw new Error(`Unexpected extended hook API call: ${method} ${url}`);
            }
        );
        Object.defineProperty(globalThis, "fetch", {
            configurable: true,
            value: fetchMock,
            writable: true,
        });

        const runWalg = renderHookWithQueryClient(() => useRunWalgBackup());
        await expect(runWalg.result.current.mutateAsync()).resolves.toMatchObject({
            job: { id: "walg-1", status: "running" },
        });

        const clearKopia = renderHookWithQueryClient(() =>
            useClearKopiaBackupAttention()
        );
        await expect(clearKopia.result.current.mutateAsync()).resolves.toMatchObject({
            cleared: { id: "kopia-attention" },
        });

        const clearWalg = renderHookWithQueryClient(() => useClearWalgBackupAttention());
        await expect(clearWalg.result.current.mutateAsync()).resolves.toMatchObject({
            cleared: { id: "walg-attention" },
        });

        const createNotification = renderHookWithQueryClient(() =>
            useCreateNotification()
        );
        await expect(
            createNotification.result.current.mutateAsync({
                title: "Functional coverage",
                description: "Created from a hook",
                source: "tests",
            })
        ).resolves.toEqual({ isOk: true, id: 123 });

        const markAllRead = renderHookWithQueryClient(() =>
            useMarkAllNotificationsRead()
        );
        await expect(markAllRead.result.current.mutateAsync()).resolves.toEqual({
            isOk: true,
        });

        expect(hasQuotaStatus({ status: "error", note: "offline" })).toBe(true);
        expect(hasQuotaStatus({ status: "fresh" })).toBe(false);
        expect(hasQuotaStatus(undefined)).toBe(false);

        render(
            createElement(TaskOverlay, {
                task: task({
                    number: 9,
                    title: "Recurring overlay task",
                    labels: [{ name: "priority-low" }],
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
        expect(formatDuration(undefined)).toBe("Unknown");
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
                metadata: { reportId: 42 },
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

        renderWithQueryClientAndRouter(createElement(NotificationBell));

        await user.click(
            await screen.findByRole("button", {
                name: /open notifications, 1 unread/i,
            })
        );
        expect(await screen.findByText("Cache refresh failed")).toBeInTheDocument();
        expect(screen.getByText("Backup complete")).toBeInTheDocument();
        expect(screen.getByText("Open report").closest("a")?.getAttribute("href")).toBe(
            "/reports?reportId=42"
        );

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

    it("renders dashboard reports and switches report filters", async () => {
        const fetchMock = jest.fn(async (input: RequestInfo | URL) => {
            const url = String(input);
            const [path, query = ""] = url.split("?");
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
            return Response.json({ items: [] });
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
        await user.click(screen.getByRole("button", { name: /heartbeat/i }));
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
        const fetchMock = jest.fn(async (input: RequestInfo | URL) => {
            const url = String(input);
            const [path, query = ""] = url.split("?");
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
            return Response.json({ items: [] });
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
        await user.click(screen.getByRole("button", { name: /heartbeat/i }));
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
        ).toMatchObject({ subsystem: "worker", msg: "Nested ready" });
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
            compareLogEntriesByLineId({ lineId: "10" }, { lineId: "20" })
        ).toBeLessThan(0);
        expect(
            compareLogEntriesByLineId({ lineId: "20" }, { lineId: "10" })
        ).toBeGreaterThan(0);
        expect(compareLogEntriesByLineId({ lineId: "10" }, {})).toBeLessThan(0);
        expect(compareLogEntriesByLineId({}, { lineId: "10" })).toBeGreaterThan(0);
        expect(
            compareLogEntriesByLineId({ lineId: " " }, { lineId: "10" })
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
        expect(formatCronLastStatus(undefined)).toBe("UNKNOWN");
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
        expect(formatDuration(undefined)).toBe("Unknown");
        expect(formatUtcTimeOfDayInAppTimeZone("bad")).toBe("--:--");
        expect(formatUtcTimeOfDayInAppTimeZone("12:30", "2026-01-15T00:00:00.000Z")).toBe(
            "13:30"
        );
        expect(appTimeOfDayToUtcTimeOfDay("bad")).toBe("bad");
        expect(appTimeOfDayToUtcTimeOfDay("13:30", "2026-01-15T00:00:00.000Z")).toBe(
            "12:30"
        );
    });

    it("keeps chat utility behavior stable for slash commands, diagnostics, and optimistic messages", async () => {
        expect(chatErrorMessage(new Error("  failed  "), "fallback")).toBe("failed");
        expect(chatErrorMessage("failed", "fallback")).toBe("fallback");
        expect(dataUrlToBase64("data:text/plain;base64,SGVsbG8=")).toBe("SGVsbG8=");
        expect(dataUrlToBase64("SGVsbG8=")).toBe("SGVsbG8=");
        expect(base64ToText("SGVsbG8=")).toBe("Hello");
        expect(base64ToText("***")).toBeUndefined();
        await expect(
            readFileAsDataUrl(new File(["hello"], "hello.txt"))
        ).resolves.toMatch(/^data:/);
        expect(displayMimeType(new File(["hello"], "hello.txt"))).toBe(
            "application/octet-stream"
        );
        expect(
            displayMimeType(new File(["hello"], "hello.txt", { type: "text/plain" }))
        ).toBe("text/plain");

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
            chatMessage({ role: "system", text: "local system" }),
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
            chatMessage({ role: "assistant", text: "no timestamp" }),
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
    });

    it("normalizes chat content blocks, attachments, hidden tool media, and formatter helpers", () => {
        const contentBlocks = [
            { type: "text", text: "hello" },
            { type: "thinking", thinking: "considering" },
            { type: "toolCall", id: "call-1", name: "exec", arguments: { cmd: "pwd" } },
            { type: "image", data: "abc", mimeType: "image/png" },
        ];
        expect(extractImages(contentBlocks)).toHaveLength(1);
        expect(extractThinkingBlocks(contentBlocks)).toEqual([{ text: "considering" }]);
        expect(extractToolCalls(contentBlocks)).toEqual([
            { id: "call-1", name: "exec", arguments: { cmd: "pwd" } },
        ]);
        expect(normalizeText(contentBlocks)).toBe("hello\n\n[image]");
        expect(attachmentKind("image/png")).toBe("image");
        expect(attachmentKind("application/json")).toBe("text");
        expect(attachmentKind("application/pdf")).toBe("file");

        const sendAttachment = {
            id: "att-1",
            file: new File(["hello"], "hello.txt", { type: "text/plain" }),
            fileName: "hello.txt",
            mimeType: "text/plain",
            sizeBytes: 5,
            contentBase64: "aGVsbG8=",
            kind: "text" as const,
        };
        expect(gatewayAttachments([sendAttachment])).toEqual([
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

        const normalized = normalizeChatHistoryMessage({
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

        const visible = normalizeVisibleChatHistoryMessages([
            {
                role: "tool",
                content: '<file name="tool.png" mime="image/png">abc</file>',
                toolCallId: "tool-1",
                toolName: "image",
            },
            { role: "assistant", content: "done" },
        ]);
        expect(visible).toHaveLength(1);
        expect(visible[0]?.attachments?.[0]?.fileName).toBe("tool.png");

        expect(formatDatabaseNumber(123_456)).toBe("123,456");
        expect(formatDatabaseNumber(NaN)).toBe("0");
        expect(formatDatabaseBytes(0)).toBe("0 B");
        expect(formatDatabaseBytes(1536)).toBe("1.5 KB");
        expect(truncateQuery("short", 12)).toBe("short");
        expect(truncateQuery("select " + "x".repeat(20), 12)).toBe("select xxxxx...");
        expect(formatDockerBytes(0)).toBe("0 B");
        expect(formatDockerBytes(1024 ** 2)).toBe("1.0 MB");
        expect(formatDockerMemory(undefined)).toBe("—");
        expect(formatDockerMemory("512MiB / 1GiB")).toBe("512 MB / 1.0 GB");
        expect(formatDockerMemory("bad")).toBe("bad");
        expect(formatTimestamp("not-a-date")).toBe("not-a-date");
        expect(formatTimestamp(undefined)).toBe("—");
        expect(formatVersionDisplay(undefined, "sha256:abcdef1234567890")).toBe(
            "sha256:abcde"
        );
        expect(formatVersionDisplay(undefined, undefined)).toBe("—");
        expect(formatFullVersionDisplay("v1", "digest")).toBe("v1 (digest)");
        expect(formatFullVersionDisplay(undefined, undefined)).toBe("—");
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

    it("drives task detail modal editing, assignment, movement, and progress updates", async () => {
        const user = userEvent.setup();
        const onClose = jest.fn();
        const onMove = jest.fn(async () => {});
        const onAssign = jest.fn(async () => {});
        const onDelete = jest.fn(async () => {});
        const onUpdate = jest.fn(async () =>
            task({ number: 7, title: "Edited detail task" })
        );
        const onAddUpdate = jest.fn(async () => {});
        const onEditUpdate = jest.fn(async () => {});
        const onDeleteUpdate = jest.fn(async () => {});
        const detailTask = task({
            number: 7,
            title: "Detail task",
            body: "**Investigate** behavior",
            labels: [{ name: "priority-high" }, { name: "in-progress" }],
            assignees: [{ login: "mira-2026", name: "Mira" }],
            automation: {
                type: "cron",
                recurring: true,
                cronJobId: "cron-7",
                scheduleSummary: "Every hour",
                sessionTarget: "agent:main:main",
                enabled: true,
                lastRunStatus: "success",
                lastRunAtMs: Date.UTC(2026, 5, 23, 8),
                nextRunAtMs: Date.UTC(2026, 5, 23, 9),
                lastDurationMs: 125_000,
                model: "codex",
                thinking: "high",
                source: "cron",
            },
        });

        render(
            createElement(TaskDetailModal, {
                task: detailTask,
                onClose,
                onMove,
                onAssign,
                onDelete,
                onUpdate,
                updates: [
                    {
                        id: 11,
                        taskId: 7,
                        author: "mira-2026",
                        messageMd: "First **progress** update",
                        createdAt: "2026-06-23T08:00:00.000Z",
                    },
                ],
                onAddUpdate,
                onEditUpdate,
                onDeleteUpdate,
            })
        );

        expect(screen.getByText("#7: Detail task")).toBeInTheDocument();
        expect(screen.getByText("Backed by OpenClaw cron")).toBeInTheDocument();
        expect(screen.getByText("2m 5s")).toBeInTheDocument();

        await user.click(screen.getByRole("button", { name: "Mark Done" }));
        expect(onMove).toHaveBeenCalledWith("done");

        await user.click(screen.getByRole("button", { name: "Assign to Raymond" }));
        expect(onAssign).toHaveBeenCalledWith("rajohan");

        await user.click(screen.getByRole("button", { name: "Edit" }));
        await user.clear(screen.getByLabelText("Title"));
        await user.type(screen.getByLabelText("Title"), "Edited detail task");
        await user.clear(screen.getByLabelText("Cron job ID"));
        await user.type(screen.getByLabelText("Cron job ID"), "cron-edited");
        await user.click(screen.getByRole("button", { name: "Save Changes" }));
        expect(onUpdate).toHaveBeenCalledWith(
            expect.objectContaining({
                title: "Edited detail task",
                automation: expect.objectContaining({ cronJobId: "cron-edited" }),
            })
        );

        await user.type(screen.getByLabelText("Add progress update"), "More progress");
        await user.click(screen.getByRole("button", { name: "Add Update" }));
        expect(onAddUpdate).toHaveBeenCalledWith("More progress");

        await user.click(
            screen.getByRole("button", { name: "Edit progress update #11" })
        );
        await user.clear(screen.getByLabelText("Message for progress update #11"));
        await user.type(
            screen.getByLabelText("Message for progress update #11"),
            "Edited progress"
        );
        await user.click(screen.getByRole("button", { name: "Save" }));
        expect(onEditUpdate).toHaveBeenCalledWith(11, "Edited progress");

        await user.click(
            screen.getByRole("button", { name: "Delete progress update #11" })
        );
        expect(onDeleteUpdate).toHaveBeenCalledWith(11);

        await user.click(screen.getByRole("button", { name: "Delete" }));
        expect(onDelete).toHaveBeenCalled();

        await user.click(screen.getByRole("button", { name: "Close task details" }));
        expect(onClose).toHaveBeenCalled();
    }, 10_000);

    it("renders shared UI controls with accessible confirm, search, and badge behavior", async () => {
        const user = userEvent.setup();
        const onConfirm = jest.fn();
        const onCancel = jest.fn();
        const onSearch = jest.fn();

        render(
            createElement(
                "div",
                undefined,
                createElement(ConfirmModal, {
                    isOpen: true,
                    title: "Delete task",
                    message: "This cannot be undone.",
                    confirmLabel: "Delete",
                    danger: true,
                    onConfirm,
                    onCancel,
                }),
                createElement(SearchInput, {
                    value: "cache",
                    label: "Search tasks",
                    onChange: onSearch,
                }),
                createElement(Badge, {
                    variant: "cron",
                    className: "extra",
                    children: "CRON",
                })
            )
        );

        expect(screen.getByText("This cannot be undone.")).toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "Delete" }));
        expect(onConfirm).toHaveBeenCalled();
        await user.click(screen.getByRole("button", { name: "Cancel" }));
        expect(onCancel).toHaveBeenCalled();

        await user.click(screen.getByRole("button", { name: "Clear search tasks" }));
        expect(onSearch).toHaveBeenCalledWith("");
        expect(screen.getByText("CRON")).toHaveClass("extra");
        expect(getSessionTypeVariant("subagent")).toBe("subagent");
        expect(getSessionTypeVariant(undefined)).toBe("default");
    });

    it("renders dropdown menu actions and disabled items", async () => {
        const user = userEvent.setup();
        const onDropdownAction = jest.fn();

        render(
            createElement(Dropdown, {
                label: "Actions",
                items: [
                    { label: "Run now", onClick: onDropdownAction },
                    {
                        label: "Disabled action",
                        disabled: true,
                        onClick: onDropdownAction,
                    },
                ],
            })
        );
        await user.click(screen.getByRole("button", { name: "Actions" }));
        const disabled = screen.getByRole("menuitem", { name: "Disabled action" });
        expect(disabled).toHaveAttribute("aria-disabled", "true");

        await user.click(screen.getByRole("menuitem", { name: "Run now" }));
        expect(onDropdownAction).toHaveBeenCalledTimes(1);
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

    it("filters the task board by assignee and search text", async () => {
        const tasks = [
            task({
                number: 10,
                title: "Mira backend follow-up",
                assignees: [{ login: "mira-2026", name: "Mira" }],
                labels: [{ name: "priority-high" }],
            }),
            task({
                number: 11,
                title: "Raymond review queue",
                assignees: [{ login: "rajohan", name: "Raymond" }],
                labels: [{ name: "blocked" }],
            }),
        ];
        Object.defineProperty(globalThis, "fetch", {
            configurable: true,
            value: createApi(tasks),
            writable: true,
        });
        const user = userEvent.setup();

        renderWithQueryClient(createElement(Tasks));

        expect(await screen.findByText("Mira backend follow-up")).toBeInTheDocument();
        expect(screen.getByText("Raymond review queue")).toBeInTheDocument();

        await user.click(screen.getByRole("button", { name: "Raymond" }));
        expect(screen.queryByText("Mira backend follow-up")).not.toBeInTheDocument();
        expect(screen.getByText("Raymond review queue")).toBeInTheDocument();

        await user.type(screen.getByPlaceholderText("Search tasks..."), "nothing");
        expect(
            screen.getByText("No tasks match the current filters.")
        ).toBeInTheDocument();

        await user.click(screen.getByRole("button", { name: "Clear filters" }));
        expect(await screen.findByText("Mira backend follow-up")).toBeInTheDocument();
        expect(screen.getByText("Raymond review queue")).toBeInTheDocument();
    });

    it("keeps task board ordering aligned with triage priority", async () => {
        const tasks = [
            task({
                number: 20,
                title: "Low priority newer",
                labels: [{ name: "priority-low" }, { name: "in-progress" }],
                updatedAt: "2026-06-23T12:00:00.000Z",
            }),
            task({
                number: 21,
                title: "High priority older",
                labels: [{ name: "priority-high" }, { name: "in-progress" }],
                updatedAt: "2026-06-23T08:00:00.000Z",
            }),
            task({
                number: 22,
                title: "Medium priority middle",
                labels: [{ name: "priority-medium" }, { name: "in-progress" }],
                updatedAt: "2026-06-23T10:00:00.000Z",
            }),
            task({
                number: 23,
                title: "Done newer low",
                labels: [{ name: "priority-low" }, { name: "done" }],
                state: "CLOSED",
                updatedAt: "2026-06-24T08:00:00.000Z",
            }),
            task({
                number: 24,
                title: "Done older high",
                labels: [{ name: "priority-high" }, { name: "done" }],
                state: "CLOSED",
                updatedAt: "2026-06-22T08:00:00.000Z",
            }),
        ];
        Object.defineProperty(globalThis, "fetch", {
            configurable: true,
            value: createApi(tasks),
            writable: true,
        });

        renderWithQueryClient(createElement(Tasks));

        await screen.findByText("High priority older");

        const taskOpenLabels = screen
            .getAllByRole("button", { name: /Open task #/u })
            .map((button) => button.getAttribute("aria-label"));
        expect(taskOpenLabels).toEqual([
            "Open task #21: High priority older",
            "Open task #22: Medium priority middle",
            "Open task #20: Low priority newer",
            "Open task #23: Done newer low",
            "Open task #24: Done older high",
        ]);
    });

    it("renders empty and retry states for the task board", async () => {
        const user = userEvent.setup();
        const fetchMock = jest
            .fn()
            .mockResolvedValueOnce(
                Response.json({ error: "Tasks unavailable" }, { status: 503 })
            )
            .mockResolvedValueOnce(Response.json([]));
        Object.defineProperty(globalThis, "fetch", {
            configurable: true,
            value: fetchMock,
            writable: true,
        });

        renderWithQueryClient(createElement(Tasks));

        expect(await screen.findByText("Tasks unavailable")).toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "Retry" }));
        expect(await screen.findByText("No tasks yet.")).toBeInTheDocument();
        expect(
            screen.getByText("Create a task when there is new work to track.")
        ).toBeInTheDocument();
        expect(fetchMock).toHaveBeenCalledTimes(2);
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
