import { afterEach, beforeEach, describe, expect, it, jest } from "bun:test";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
    createMemoryHistory,
    createRootRoute,
    createRoute,
    createRouter,
    Outlet,
    RouterProvider,
} from "@tanstack/react-router";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement } from "react";

import type { DashboardDiagnosticsResponse } from "../../../../contracts/health";
import { requestBodyText, requestUrl } from "../../../../test/support/fetch";
import { Layout } from "../../components/layout/Layout";
import { apiFetch } from "../../hooks/useApi";
import { OpenClawSocketProvider } from "../../hooks/useOpenClawSocket";
import { ApiError, UnauthorizedError } from "../../lib/apiError";
import {
    notifyAuthSessionRotated,
    UNAUTHORIZED_EVENT_NAME,
    uninstallAuthSessionRotationSync,
} from "../../lib/authBoundary";
import {
    cancelSecurityVerification,
    completeSecurityVerification,
    refreshSecurityVerificationDeadline,
    SECURITY_VERIFICATION_CANCELLED_EVENT_NAME,
    waitForSecurityVerification,
} from "../../lib/securityVerification";
import {
    hasRecentUserActivity,
    installUserActivityTracking,
    resetUserActivityForTests,
} from "../../lib/userActivity";
import { authActions, authStore } from "../../stores/authStore";
import { createFrontendBehaviorHarness } from "../support/frontendBehaviorHarness";
describe("Dashboard app shell and authentication", () => {
    const { claimSecurityVerification, dashboardDiagnostics } =
        createFrontendBehaviorHarness();
    beforeEach(() => {
        authActions.clearSession();
        resetUserActivityForTests();
    });
    afterEach(() => {
        uninstallAuthSessionRotationSync();
        authActions.clearSession();
        resetUserActivityForTests();
    });
    it("loads the app shell, router, login route, and local devtools modules", async () => {
        const [
            { default: App },
            { normalizeChatSearch, router },
            { Login },
            { default: DashboardDevtools },
        ] = await Promise.all([
            import("../../App"),
            import("../../router"),
            import("../../pages/Login"),
            import("../../components/devtools/DashboardDevtools"),
        ]);
        expect(App).toBeTypeOf("function");
        expect(Login).toBeTypeOf("function");
        expect(DashboardDevtools).toBeTypeOf("function");
        expect(router.navigate).toBeTypeOf("function");
        expect(Object.keys(router.routesByPath)).toContain("/delivery");
        expect(Object.keys(router.routesByPath)).not.toContain("/pull-requests");
        expect(
            normalizeChatSearch({
                session: " agent:ops:main:heartbeat ",
            })
        ).toEqual({
            session: "agent:ops:main:heartbeat",
        });
        expect(
            normalizeChatSearch({
                session: " ".repeat(3),
            })
        ).toEqual({});
        expect(
            normalizeChatSearch({
                session: 42,
            })
        ).toEqual({});
        const originalFetch = fetch;
        Object.defineProperty(globalThis, "fetch", {
            configurable: true,
            value: (input: Parameters<typeof fetch>[0]) => {
                return Promise.try(() => {
                    const url = requestUrl(input);
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
                });
            },
            writable: true,
        });
        try {
            await router.navigate({
                to: "/login",
            });
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
            authActions.clearSession();
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
            session: {
                authMethod: "webauthn",
                expiresAt: "2026-08-24T12:00:00.000Z",
                lastSeenAt: "2026-07-25T04:00:00.000Z",
                mfaEnabled: true,
                sessionId: "11111111111111111111111111111111",
            },
            user: {
                id: 1,
                username: "raymond",
            },
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
        const fetchForLayoutShell = (
            input: Parameters<typeof fetch>[0],
            init?: RequestInit
        ) => {
            return Promise.try(() => {
                const url = requestUrl(input);
                apiCalls.push(`${init?.method ?? "GET"} ${url}`);
                if (url === "/api/health/diagnostics") {
                    return Response.json(dashboardDiagnostics());
                }
                if (url === "/api/cache/system.host") {
                    return Response.json({
                        consecutiveFailures: 0,
                        data: {
                            checkedAt: "2026-06-25T00:00:00.000Z",
                            disk: {
                                percent: 25,
                                totalBytes: 1000,
                                usedBytes: 250,
                            },
                            hostname: "dashboard-test",
                            memory: {
                                freeBytes: 600,
                                freeMb: 600 / (1024 * 1024),
                                totalBytes: 1000,
                                usedBytes: 400,
                            },
                            platform: "linux",
                            uptimeSeconds: 123,
                            version: {
                                checkedAt: 1_750_809_600_000,
                                current: "2026.6.9",
                                latest: "2026.6.9",
                                updateAvailable: false,
                            },
                        },
                        errorCode: null,
                        errorMessage: null,
                        expiresAt: null,
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
                                author: {
                                    login: "mira-2026",
                                },
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
                    return Response.json({
                        items: [],
                        readCount: 0,
                        unreadCount: 0,
                    });
                }
                if (url === "/api/auth/logout" && init?.method === "POST") {
                    return Response.json({
                        isOk: true,
                    });
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
            });
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
        const tasksRoute = createRoute({
            getParentRoute: () => authenticatedRoute,
            path: "/tasks",
            validateSearch: (search: Record<string, unknown>) => ({
                view: typeof search.view === "string" ? search.view : undefined,
            }),
            component: () => createElement("div", undefined, "Tasks child"),
        });
        const loginRoute = createRoute({
            getParentRoute: () => rootRoute,
            path: "/login",
            component: () => createElement("div", undefined, "Login route"),
        });
        const testRouter = createRouter({
            history: createMemoryHistory({
                initialEntries: ["/"],
            }),
            routeTree: rootRoute.addChildren([
                loginRoute,
                authenticatedRoute.addChildren([indexRoute, tasksRoute]),
            ]),
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
        const routedShell = createElement(
            OpenClawSocketProvider,
            undefined,
            createElement(RouterProvider, {
                router: testRouter,
            })
        );
        try {
            const view = render(
                createElement(
                    QueryClientProvider,
                    {
                        client: queryClient,
                    },
                    routedShell
                )
            );
            await waitFor(() => {
                expect(screen.getByText("Mira Dashboard")).toBeInTheDocument();
                expect(screen.getByText("Layout child content")).toBeInTheDocument();
                expect(screen.getByLabelText("1 open pull requests")).toBeInTheDocument();
            });
            expect(screen.getByText("v2026.6.9")).toBeInTheDocument();
            expect(
                screen.getByRole("link", {
                    name: /Delivery/u,
                })
            ).toHaveAttribute("href", "/delivery");
            const systemStatus = screen.getByRole("button", {
                name: /System status: .+\. Open details/u,
            });
            expect(screen.queryByText("WK")).not.toBeInTheDocument();
            await userEvent.click(systemStatus);
            expect(screen.getByText("System status")).toBeInTheDocument();
            expect(screen.getByText("WebSocket")).toBeInTheDocument();
            expect(screen.getAllByText("Backend")).toHaveLength(2);
            expect(screen.getByText("Worker")).toBeInTheDocument();
            expect(screen.getAllByText("online ●")).toHaveLength(2);
            expect(screen.getByText("Frontend")).toBeInTheDocument();
            expect(screen.getByText("Version mismatch")).toBeInTheDocument();
            expect(screen.queryByText(/Version mismatch \(FE/u)).not.toBeInTheDocument();
            const readyHealth = queryClient.getQueryData<DashboardDiagnosticsResponse>([
                "health",
            ]);
            expect(readyHealth).toBeDefined();
            if (!readyHealth) {
                throw new TypeError("Expected health data after layout initialization");
            }
            act(() => {
                queryClient.setQueryData<DashboardDiagnosticsResponse>(["health"], {
                    ...readyHealth,
                    checks: {
                        ...readyHealth.checks,
                        worker: {
                            ready: false,
                        },
                    },
                    status: "notReady",
                });
            });
            await waitFor(() => {
                expect(screen.getByText(/Offline ○/u)).toBeInTheDocument();
            });
            const healthQuery = queryClient
                .getQueryCache()
                .find<DashboardDiagnosticsResponse>({
                    queryKey: ["health"],
                });
            act(() => {
                healthQuery?.setState({
                    data: undefined,
                    fetchStatus: "idle",
                    status: "pending",
                });
            });
            await waitFor(() => {
                expect(screen.getByText(/status unavailable \?/u)).toBeInTheDocument();
            });
            await userEvent.click(screen.getByLabelText("Open navigation menu"));
            expect(
                screen.getAllByLabelText("Close navigation menu").length
            ).toBeGreaterThan(1);
            const pageScroll = screen.getByText("Layout child content").parentElement;
            expect(pageScroll).toBeInstanceOf(HTMLDivElement);
            if (!(pageScroll instanceof HTMLDivElement)) {
                throw new TypeError("Layout page scroll container not found");
            }
            pageScroll.scrollTop = 480;
            pageScroll.scrollLeft = 24;
            await act(async () => {
                await testRouter.navigate({
                    to: "/tasks",
                });
            });
            expect(pageScroll.scrollTop).toBe(0);
            expect(pageScroll.scrollLeft).toBe(0);
            expect(screen.getAllByLabelText("Close navigation menu")).toHaveLength(1);
            pageScroll.scrollTop = 320;
            pageScroll.scrollLeft = 16;
            await act(async () => {
                await testRouter.navigate({
                    to: "/tasks",
                    search: {
                        view: "queued",
                    },
                });
            });
            expect(pageScroll.scrollTop).toBe(320);
            expect(pageScroll.scrollLeft).toBe(16);
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
        const { Login } = await import("../../pages/Login");
        const originalFetch = fetch;
        const calls: string[] = [];
        let loginAttempts = 0;
        Object.defineProperty(globalThis, "fetch", {
            configurable: true,
            value: (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
                return Promise.try(() => {
                    const url = requestUrl(input);
                    calls.push(`${init?.method ?? "GET"} ${url}`);
                    if (url === "/api/auth/bootstrap") {
                        return Response.json({
                            hasGatewayToken: true,
                            isBootstrapRequired: false,
                        });
                    }
                    if (url === "/api/auth/login" && init?.method === "POST") {
                        const body = JSON.parse(requestBodyText(init.body, "{}")) as {
                            password?: string;
                            username?: string;
                        };
                        expect(body.username).toBe("raymond");
                        loginAttempts += 1;
                        if (body.password !== "correct-password") {
                            return Response.json(
                                {
                                    error: {
                                        code: "unauthorized",
                                        message: "Invalid credentials",
                                        requestId: "login-invalid-credentials",
                                    },
                                },
                                {
                                    status: 401,
                                }
                            );
                        }
                        return Response.json({
                            authenticated: true,
                            mfaRequired: false,
                            user: {
                                id: 1,
                                username: "raymond",
                            },
                        });
                    }
                    if (url === "/api/auth/session") {
                        return Response.json({
                            authenticated: loginAttempts > 1,
                            isBootstrapRequired: false,
                            session:
                                loginAttempts > 1
                                    ? {
                                          authMethod: "password",
                                          expiresAt: "2026-08-24T12:00:00.000Z",
                                          lastSeenAt: "2026-07-24T12:00:00.000Z",
                                          mfaEnabled: true,
                                          sessionId: "11111111111111111111111111111111",
                                      }
                                    : undefined,
                            user:
                                loginAttempts > 1
                                    ? {
                                          id: 1,
                                          username: "raymond",
                                      }
                                    : undefined,
                        });
                    }
                    throw new Error(
                        `Unexpected login fetch: ${init?.method ?? "GET"} ${url}`
                    );
                });
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
            history: createMemoryHistory({
                initialEntries: ["/login"],
            }),
            routeTree: rootRoute.addChildren([indexRoute, loginRoute]),
        });
        try {
            const view = render(
                createElement(RouterProvider, {
                    router: testRouter,
                })
            );
            await waitFor(() => {
                expect(screen.getByText("Continue")).toBeInTheDocument();
                expect(screen.queryByLabelText("Gateway Token")).not.toBeInTheDocument();
            });
            await userEvent.type(screen.getByLabelText("Username"), " raymond ");
            await userEvent.type(screen.getByLabelText("Password"), "wrong");
            await userEvent.click(
                screen.getByRole("button", {
                    name: "Continue",
                })
            );
            await waitFor(() => {
                expect(screen.getByText("Invalid credentials")).toBeInTheDocument();
                expect(calls).toContain("GET /api/auth/bootstrap");
            });
            const passwordInput = screen.getByLabelText("Password");
            await userEvent.clear(passwordInput);
            await userEvent.type(passwordInput, "correct-password");
            await userEvent.click(
                screen.getByRole("button", {
                    name: "Continue",
                })
            );
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
    it("does not issue a frontend session until TOTP login completes", async () => {
        const { Login } = await import("../../pages/Login");
        const originalFetch = fetch;
        const calls: string[] = [];
        let isFactorVerified = false;
        Object.defineProperty(globalThis, "fetch", {
            configurable: true,
            value: (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
                return Promise.try(() => {
                    const url = requestUrl(input);
                    calls.push(`${init?.method ?? "GET"} ${url}`);
                    if (url === "/api/auth/bootstrap") {
                        return Response.json({
                            hasGatewayToken: true,
                            isBootstrapRequired: false,
                        });
                    }
                    if (url === "/api/auth/login" && init?.method === "POST") {
                        return Response.json(
                            {
                                authenticated: false,
                                methods: ["totp", "recovery"],
                                mfaRequired: true,
                            },
                            {
                                status: 202,
                            }
                        );
                    }
                    if (url === "/api/auth/login/totp" && init?.method === "POST") {
                        expect(JSON.parse(requestBodyText(init.body))).toEqual({
                            code: "123456",
                        });
                        isFactorVerified = true;
                        return Response.json({
                            authenticated: true,
                            mfaRequired: false,
                        });
                    }
                    if (url === "/api/auth/session") {
                        return Response.json({
                            authenticated: isFactorVerified,
                            isBootstrapRequired: false,
                            session: isFactorVerified
                                ? {
                                      authMethod: "totp",
                                      expiresAt: "2026-08-24T12:00:00.000Z",
                                      lastSeenAt: "2026-07-24T12:00:00.000Z",
                                      mfaEnabled: true,
                                      sessionId: "11111111111111111111111111111111",
                                  }
                                : undefined,
                            user: isFactorVerified
                                ? {
                                      id: 1,
                                      username: "raymond",
                                  }
                                : undefined,
                        });
                    }
                    throw new Error(
                        `Unexpected MFA login fetch: ${init?.method ?? "GET"} ${url}`
                    );
                });
            },
            writable: true,
        });
        const rootRoute = createRootRoute({
            component: () => createElement(Outlet),
        });
        const indexRoute = createRoute({
            component: () => createElement("div", undefined, "MFA session ready"),
            getParentRoute: () => rootRoute,
            path: "/",
        });
        const loginRoute = createRoute({
            component: Login,
            getParentRoute: () => rootRoute,
            path: "/login",
        });
        const testRouter = createRouter({
            history: createMemoryHistory({
                initialEntries: ["/login"],
            }),
            routeTree: rootRoute.addChildren([indexRoute, loginRoute]),
        });
        try {
            const view = render(
                createElement(RouterProvider, {
                    router: testRouter,
                })
            );
            await screen.findByRole("button", {
                name: "Continue",
            });
            await userEvent.type(screen.getByLabelText("Username"), "raymond");
            await userEvent.type(screen.getByLabelText("Password"), "correct-password");
            await userEvent.click(
                screen.getByRole("button", {
                    name: "Continue",
                })
            );
            await screen.findByRole("button", {
                name: "Authenticator app",
            });
            expect(calls).not.toContain("GET /api/auth/session");
            await userEvent.click(
                screen.getByRole("button", {
                    name: "Authenticator app",
                })
            );
            await userEvent.type(screen.getByLabelText("6-digit code"), "123456");
            await userEvent.click(
                screen.getByRole("button", {
                    name: "Verify",
                })
            );
            await screen.findByText("MFA session ready");
            expect(calls).toContain("POST /api/auth/login/totp");
            expect(calls).toContain("GET /api/auth/session");
            view.unmount();
        } finally {
            authActions.clearSession();
            Object.defineProperty(globalThis, "fetch", {
                configurable: true,
                value: originalFetch,
                writable: true,
            });
        }
    });
    it("handles API authorization failures through the shared auth boundary", () => {
        authActions.setSession({
            authenticated: true,
            isBootstrapRequired: false,
            session: {
                authMethod: "webauthn",
                expiresAt: "2026-08-24T12:00:00.000Z",
                lastSeenAt: "2026-07-25T04:00:00.000Z",
                mfaEnabled: true,
                sessionId: "11111111111111111111111111111111",
            },
            user: {
                id: 1,
                username: "raymond",
            },
        });
        const unauthorizedEvents: Event[] = [];
        const unauthorizedHandler = (event: Event) => {
            unauthorizedEvents.push(event);
        };
        addEventListener(UNAUTHORIZED_EVENT_NAME, unauthorizedHandler);
        Object.defineProperty(globalThis, "fetch", {
            configurable: true,
            value: jest.fn((input: RequestInfo | URL) => {
                return Promise.try(() => {
                    if (requestUrl(input) === "/api/tasks") {
                        return Response.json(
                            {
                                error: {
                                    code: "unauthorized",
                                    message: "Unauthorized",
                                    requestId: "tasks-unauthorized",
                                },
                            },
                            {
                                status: 401,
                            }
                        );
                    }
                    if (requestUrl(input) === "/api/auth/session") {
                        return Response.json({
                            authenticated: false,
                            isBootstrapRequired: false,
                        });
                    }
                    throw new Error(
                        `Unexpected authorization-boundary request: ${requestUrl(input)}`
                    );
                });
            }),
            writable: true,
        });
        try {
            expect(apiFetch("/tasks")).rejects.toBeInstanceOf(UnauthorizedError);
            expect(authStore.state.isAuthenticated).toBe(false);
            expect(unauthorizedEvents).toHaveLength(1);
            expect(fetch).toHaveBeenCalledTimes(2);
        } finally {
            removeEventListener(UNAUTHORIZED_EVENT_NAME, unauthorizedHandler);
        }
    });
    it("retries a stale 401 against the browser's rotated session", () => {
        authActions.setSession({
            authenticated: true,
            isBootstrapRequired: false,
            session: {
                authMethod: "webauthn",
                expiresAt: "2026-08-24T12:00:00.000Z",
                lastSeenAt: "2026-07-25T04:00:00.000Z",
                mfaEnabled: true,
                sessionId: "11111111111111111111111111111111",
            },
            user: {
                id: 1,
                username: "raymond",
            },
        });
        let taskRequests = 0;
        const unauthorizedHandler = jest.fn();
        addEventListener(UNAUTHORIZED_EVENT_NAME, unauthorizedHandler);
        Object.defineProperty(globalThis, "fetch", {
            configurable: true,
            value: jest.fn((input: RequestInfo | URL) => {
                return Promise.try(() => {
                    if (requestUrl(input) === "/api/auth/session") {
                        return Response.json({
                            authenticated: true,
                            isBootstrapRequired: false,
                            session: {
                                authMethod: "webauthn",
                                expiresAt: "2026-08-24T12:00:00.000Z",
                                lastSeenAt: "2026-07-25T04:01:00.000Z",
                                mfaEnabled: true,
                                sessionId: "22222222222222222222222222222222",
                            },
                            user: {
                                id: 1,
                                username: "raymond",
                            },
                        });
                    }
                    if (requestUrl(input) === "/api/tasks") {
                        taskRequests += 1;
                        return taskRequests === 1
                            ? Response.json(
                                  {
                                      error: {
                                          code: "unauthorized",
                                          message: "Unauthorized",
                                          requestId: "tasks-stale-session",
                                      },
                                  },
                                  {
                                      status: 401,
                                  }
                              )
                            : Response.json({
                                  isOk: true,
                              });
                    }
                    throw new Error(`Unexpected stale-401 request: ${requestUrl(input)}`);
                });
            }),
            writable: true,
        });
        try {
            notifyAuthSessionRotated();
            expect(apiFetch("/tasks")).resolves.toEqual({
                isOk: true,
            });
            expect(taskRequests).toBe(2);
            expect(authStore.state.sessionId).toBe("22222222222222222222222222222222");
            expect(unauthorizedHandler).not.toHaveBeenCalled();
        } finally {
            removeEventListener(UNAUTHORIZED_EVENT_NAME, unauthorizedHandler);
        }
    });
    it("recovers a stale 401 independently of verification replay opt-out", () => {
        authActions.setSession({
            authenticated: true,
            isBootstrapRequired: false,
            session: {
                authMethod: "webauthn",
                expiresAt: "2026-08-24T12:00:00.000Z",
                lastSeenAt: "2026-07-25T04:00:00.000Z",
                mfaEnabled: true,
                sessionId: "11111111111111111111111111111111",
            },
            user: {
                id: 1,
                username: "raymond",
            },
        });
        let confirmationRequests = 0;
        Object.defineProperty(globalThis, "fetch", {
            configurable: true,
            value: jest.fn(
                (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
                    return Promise.try(() => {
                        if (requestUrl(input) === "/api/auth/session") {
                            return Response.json({
                                authenticated: true,
                                isBootstrapRequired: false,
                                session: {
                                    authMethod: "webauthn",
                                    expiresAt: "2026-08-24T12:00:00.000Z",
                                    lastSeenAt: "2026-07-25T04:01:00.000Z",
                                    mfaEnabled: true,
                                    sessionId: "22222222222222222222222222222222",
                                },
                                user: {
                                    id: 1,
                                    username: "raymond",
                                },
                            });
                        }
                        if (
                            requestUrl(input) === "/api/account/security/totp/confirm" &&
                            init?.method === "POST"
                        ) {
                            confirmationRequests += 1;
                            return confirmationRequests === 1
                                ? Response.json(
                                      {
                                          error: {
                                              code: "unauthorized",
                                              message: "Unauthorized",
                                              requestId: "totp-stale-session",
                                          },
                                      },
                                      {
                                          status: 401,
                                      }
                                  )
                                : Response.json({
                                      isOk: true,
                                  });
                        }
                        throw new Error(
                            `Unexpected verification-opt-out recovery request: ${requestUrl(input)}`
                        );
                    });
                }
            ),
            writable: true,
        });
        notifyAuthSessionRotated();
        expect(
            apiFetch("/account/security/totp/confirm", {
                body: JSON.stringify({
                    code: "123456",
                    factorId: "01900000-0000-7000-8000-000000000099",
                }),
                canRetryAfterSecurityVerification: false,
                method: "POST",
            })
        ).resolves.toEqual({
            isOk: true,
        });
        expect(confirmationRequests).toBe(2);
        expect(authStore.state.sessionId).toBe("22222222222222222222222222222222");
    });
    it("refreshes idle-session activity only after a real browser interaction", () => {
        expect(hasRecentUserActivity()).toBe(false);
        installUserActivityTracking();
        dispatchEvent(new Event("pointerdown"));
        expect(hasRecentUserActivity()).toBe(true);
    });
    it("surfaces privileged-action step-up requirements through one global event", async () => {
        const verificationEvents: CustomEvent[] = [];
        const handler = (event: Event) => {
            verificationEvents.push(event as CustomEvent);
        };
        addEventListener("mira:security-verification-required", handler);
        Object.defineProperty(globalThis, "fetch", {
            configurable: true,
            value: jest.fn(() =>
                Promise.try(() =>
                    Response.json(
                        {
                            error: {
                                code: "recent_verification_required",
                                message: "Recent password verification is required",
                                requestId: "privileged-step-up",
                            },
                        },
                        {
                            status: 403,
                        }
                    )
                )
            ),
            writable: true,
        });
        try {
            let error: unknown;
            try {
                await apiFetch("/restart", {
                    method: "POST",
                });
            } catch (error_) {
                error = error_;
            }
            expect(error).toBeInstanceOf(ApiError);
            expect(error).toEqual(
                expect.objectContaining({
                    code: "recent_verification_required",
                    status: 403,
                })
            );
            expect(verificationEvents).toHaveLength(1);
            expect(verificationEvents[0]?.detail).toEqual({
                code: "recent_verification_required",
            });
        } finally {
            removeEventListener("mira:security-verification-required", handler);
        }
    });
    it("retries an API action once after the shared verification flow completes", async () => {
        let requestCount = 0;
        const verificationHandler = jest.fn(claimSecurityVerification);
        addEventListener("mira:security-verification-required", verificationHandler);
        Object.defineProperty(globalThis, "fetch", {
            configurable: true,
            value: jest.fn(() => {
                return Promise.try(() => {
                    requestCount += 1;
                    return requestCount === 1
                        ? Response.json(
                              {
                                  error: {
                                      code: "step_up_required",
                                      message: "Recent MFA verification is required",
                                      requestId: "privileged-retry-step-up",
                                  },
                              },
                              {
                                  status: 403,
                              }
                          )
                        : Response.json({
                              isOk: true,
                          });
                });
            }),
            writable: true,
        });
        try {
            const request = apiFetch<{
                isOk: boolean;
            }>("/privileged", {
                method: "POST",
            });
            await waitFor(() => {
                expect(verificationHandler).toHaveBeenCalledTimes(1);
            });
            expect(requestCount).toBe(1);
            completeSecurityVerification();
            expect(request).resolves.toEqual({
                isOk: true,
            });
            expect(requestCount).toBe(2);
        } finally {
            removeEventListener(
                "mira:security-verification-required",
                verificationHandler
            );
        }
    });
    it("does not replay a one-shot request body after verification", async () => {
        let requestCount = 0;
        const verificationHandler = jest.fn(claimSecurityVerification);
        addEventListener("mira:security-verification-required", verificationHandler);
        Object.defineProperty(globalThis, "fetch", {
            configurable: true,
            value: jest.fn(() => {
                return Promise.try(() => {
                    requestCount += 1;
                    return requestCount === 1
                        ? Response.json(
                              {
                                  error: {
                                      code: "step_up_required",
                                      message: "Recent MFA verification is required",
                                      requestId: "privileged-stream-step-up",
                                  },
                              },
                              {
                                  status: 403,
                              }
                          )
                        : Response.json({
                              isOk: true,
                          });
                });
            }),
            writable: true,
        });
        try {
            const request = apiFetch<{
                isOk: boolean;
            }>("/privileged-stream", {
                body: new ReadableStream<Uint8Array>(),
                method: "POST",
            });
            const settledRequest = request.catch((error: unknown) => error);
            await waitFor(() => {
                expect(verificationHandler).toHaveBeenCalledTimes(1);
            });
            expect(requestCount).toBe(1);
            completeSecurityVerification();
            expect(await settledRequest).toBeInstanceOf(ApiError);
            expect(requestCount).toBe(1);
        } finally {
            removeEventListener(
                "mira:security-verification-required",
                verificationHandler
            );
        }
    });
    it("bounds a claimed verification wait when the host never settles it", () => {
        jest.useFakeTimers();
        const verificationHandler = claimSecurityVerification;
        const cancellationHandler = jest.fn();
        addEventListener("mira:security-verification-required", verificationHandler);
        addEventListener(SECURITY_VERIFICATION_CANCELLED_EVENT_NAME, cancellationHandler);
        try {
            const verification = waitForSecurityVerification("step_up_required", 1000);
            jest.advanceTimersByTime(1000);
            expect(verification).resolves.toBe(false);
            expect(cancellationHandler).not.toHaveBeenCalled();
            cancelSecurityVerification();
            expect(cancellationHandler).toHaveBeenCalledTimes(1);
        } finally {
            removeEventListener(
                "mira:security-verification-required",
                verificationHandler
            );
            removeEventListener(
                SECURITY_VERIFICATION_CANCELLED_EVENT_NAME,
                cancellationHandler
            );
            jest.useRealTimers();
        }
    });
    it("refreshes every held request deadline when verification is submitted", () => {
        jest.useFakeTimers();
        const verificationHandler = claimSecurityVerification;
        addEventListener("mira:security-verification-required", verificationHandler);
        try {
            const verification = waitForSecurityVerification("step_up_required", 1000);
            let outcome = "pending";
            const observedSettlement = (async () => {
                const isVerified = await verification;
                outcome = isVerified ? "verified" : "cancelled";
                return "settled" as const;
            })();
            jest.advanceTimersByTime(750);
            refreshSecurityVerificationDeadline();
            jest.advanceTimersByTime(750);
            expect(
                Promise.race([
                    observedSettlement,
                    new Promise<"pending">((resolve) => {
                        queueMicrotask(() => resolve("pending"));
                    }),
                ])
            ).resolves.toBe("pending");
            expect(outcome).toBe("pending");
            jest.advanceTimersByTime(250);
            expect(verification).resolves.toBe(false);
            expect(outcome).toBe("cancelled");
        } finally {
            removeEventListener(
                "mira:security-verification-required",
                verificationHandler
            );
            jest.useRealTimers();
        }
    });
    it("parses successful, empty, and failed API responses consistently", () => {
        const fetchMock = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
            return Promise.try(() => {
                const url = requestUrl(input);
                const method = init?.method ?? "GET";
                if (url === "/api/health/live" && method === "GET") {
                    return Response.json({
                        status: "isOk",
                    });
                }
                if (url === "/api/restart" && method === "POST") {
                    return Response.json({
                        isOk: true,
                    });
                }
                if (url === "/api/empty" && method === "POST") {
                    return new Response(undefined, {
                        status: 204,
                    });
                }
                if (url === "/api/tasks" && method === "POST") {
                    return Response.json(
                        {
                            error: {
                                code: "invalid_request",
                                message: "title is required",
                                requestId: "request-task-create",
                            },
                        },
                        {
                            status: 400,
                        }
                    );
                }
                if (url === "/api/broken" && method === "GET") {
                    return new Response("not-json", {
                        status: 500,
                    });
                }
                throw new Error(`Unexpected API call: ${method} ${url}`);
            });
        });
        Object.defineProperty(globalThis, "fetch", {
            configurable: true,
            value: fetchMock,
            writable: true,
        });
        expect(apiFetch("/health/live")).resolves.toEqual({
            status: "isOk",
        });
        expect(
            apiFetch("/restart", {
                method: "POST",
            })
        ).resolves.toEqual({
            isOk: true,
        });
        expect(
            apiFetch("/empty", {
                method: "POST",
            })
        ).resolves.toBeUndefined();
        expect(
            apiFetch("/tasks", {
                body: JSON.stringify({}),
                method: "POST",
            })
        ).rejects.toThrow("title is required");
        expect(apiFetch("/broken")).rejects.toThrow("HTTP 500");
        const healthRequest = fetchMock.mock.calls.find(
            ([input]) => input === "/api/health/live"
        );
        expect(healthRequest?.[1]).toEqual(
            expect.objectContaining({
                credentials: "include",
            })
        );
        expect(new Headers(healthRequest?.[1]?.headers).get("Content-Type")).toBe(
            "application/json"
        );
    });
    it("exposes strict API error metadata and retry guidance", async () => {
        Object.defineProperty(globalThis, "fetch", {
            configurable: true,
            value: jest.fn(() =>
                Promise.try(() =>
                    Response.json(
                        {
                            error: {
                                code: "rate_limited",
                                details: {
                                    scope: "diagnostics",
                                },
                                message: "Try again later",
                                requestId: "response-body-request",
                            },
                        },
                        {
                            headers: {
                                "Retry-After": "17",
                                "X-Request-ID": "response-header-request",
                            },
                            status: 429,
                        }
                    )
                )
            ),
            writable: true,
        });
        let error: unknown;
        try {
            await apiFetch("/diagnostics");
        } catch (error_) {
            error = error_;
        }
        expect(error).toBeInstanceOf(ApiError);
        expect(error).toEqual(
            expect.objectContaining({
                code: "rate_limited",
                details: {
                    scope: "diagnostics",
                },
                message: "Try again later",
                requestId: "response-header-request",
                retryAfter: 17,
                status: 429,
            })
        );
    });
    it("initializes, refreshes, and clears auth state through the shared auth store", async () => {
        const fetchMock = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
            return Promise.try(() => {
                const url = requestUrl(input);
                const method = init?.method ?? "GET";
                if (url === "/api/auth/session" && method === "GET") {
                    return Response.json({
                        authenticated: true,
                        isBootstrapRequired: false,
                        user: {
                            id: 2,
                            username: "mira",
                        },
                    });
                }
                if (url === "/api/auth/logout" && method === "POST") {
                    return new Response(undefined, {
                        status: 204,
                    });
                }
                throw new Error(`Unexpected auth API call: ${method} ${url}`);
            });
        });
        Object.defineProperty(globalThis, "fetch", {
            configurable: true,
            value: fetchMock,
            writable: true,
        });
        await authActions.initialize();
        expect(authStore.state).toMatchObject({
            isAuthenticated: true,
            isInitialized: true,
            user: {
                id: 2,
                username: "mira",
            },
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
});
