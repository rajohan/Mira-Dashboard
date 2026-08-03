import { afterEach, beforeEach, describe, expect, it, jest } from "bun:test";

import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement } from "react";

import { requestUrl } from "../../../../test/support/fetch";
import { Docker } from "../../pages/Docker";
import { Terminal } from "../../pages/Terminal";
import { authActions } from "../../stores/authStore";
import { createPageBehaviorHarness } from "../support/pageBehaviorHarness";
describe("Dashboard terminal and Docker pages", () => {
    const {
        FakeWebSocket,
        animationFrameState,
        apiResponse,
        cancelAnimationFrameForTest,
        clickElement,
        flushQueuedTimers,
        jobsApiState,
        logsApiState,
        originalGlobals,
        renderPage,
        requestAnimationFrameForTest,
        resetLogsCollectionForTest,
        resetSessionsCollectionForTest,
        scrollIntoViewMock,
        terminalApiState,
    } = createPageBehaviorHarness();
    beforeEach(() => {
        FakeWebSocket.instances = [];
        terminalApiState.expectedExecCwd = "/tmp";
        terminalApiState.wasJobStopped = false;
        logsApiState.dashboardRequests = 0;
        logsApiState.openclawHundredLineRequests = 0;
        logsApiState.simulateOpenclawTruncation = false;
        logsApiState.unavailableReason = undefined;
        jobsApiState.cronName = "heartbeat";
        jobsApiState.heartbeatDisableIntent = undefined;
        jobsApiState.heartbeatEnabled = true;
        jobsApiState.heartbeatIntervalSeconds = 1800;
        jobsApiState.heartbeatRuns = [
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
        ];
        const sessionLastSeenAt = Date.now();
        authActions.setSession({
            authenticated: true,
            isBootstrapRequired: false,
            session: {
                authMethod: "webauthn",
                expiresAt: new Date(
                    sessionLastSeenAt + 30 * 24 * 60 * 60_000
                ).toISOString(),
                lastSeenAt: new Date(sessionLastSeenAt).toISOString(),
                mfaEnabled: true,
                sessionId: "11111111111111111111111111111111",
            },
            user: {
                id: 1,
                username: "mira",
            },
        });
        Object.defineProperties(globalThis, {
            fetch: {
                configurable: true,
                value: jest.fn((input: RequestInfo | URL, init?: RequestInit) =>
                    Promise.try(() =>
                        apiResponse(requestUrl(input), init?.method ?? "GET", init)
                    )
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
        scrollIntoViewMock.mockReset();
        Element.prototype.scrollIntoView = scrollIntoViewMock;
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
        if (originalGlobals.scrollIntoViewDescriptor) {
            Object.defineProperty(
                Element.prototype,
                "scrollIntoView",
                originalGlobals.scrollIntoViewDescriptor
            );
        } else {
            Reflect.deleteProperty(Element.prototype, "scrollIntoView");
        }
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
        const stopButton = await screen.findByRole("button", {
            name: /stop/i,
        });
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
        clickElement(
            screen.getByRole("button", {
                name: /clear/i,
            })
        );
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
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/cache/docker.summary/refresh",
            expect.objectContaining({
                method: "POST",
            })
        );
        clickElement(
            screen.getByRole("button", {
                name: /run updater now/i,
            })
        );
        await waitFor(() => {
            expect(screen.getByText(/"isSuccess": true/i)).toBeInTheDocument();
        });
        clickElement(
            screen.getByRole("button", {
                name: /update now/i,
            })
        );
        expect(screen.getByText("Run manual update")).toBeInTheDocument();
        clickElement(
            screen.getByRole("button", {
                name: /^update now$/i,
            })
        );
        await waitFor(() => {
            expect(
                screen.getByText(/Manual updater run finished\. updated=1 failed=0/i)
            ).toBeInTheDocument();
        });
        clickElement(
            screen.getByRole("button", {
                name: /dismiss/i,
            })
        );
        expect(
            screen.queryByText(/Manual updater run finished/i)
        ).not.toBeInTheDocument();
        clickElement(
            screen.getByRole("button", {
                name: /restart stack/i,
            })
        );
        await waitFor(() => {
            expect(screen.getByText("stack restarted")).toBeInTheDocument();
        });
        clickElement(screen.getAllByLabelText(/restart dashboard/i)[0]!);
        await waitFor(() => {
            expect(screen.getByText("container action output")).toBeInTheDocument();
        });
        clickElement(screen.getAllByLabelText(/show logs for dashboard/i)[0]!);
        expect(await screen.findByText("dashboard log line")).toBeInTheDocument();
        clickElement(
            screen.getByRole("button", {
                name: "200 lines",
            })
        );
        clickElement(
            screen.getByRole("menuitem", {
                name: "500 lines",
            })
        );
        await waitFor(() => {
            expect(screen.getByText("more dashboard log lines")).toBeInTheDocument();
        });
        clickElement(screen.getByLabelText(/close dashboard logs/i));
        await waitFor(() => {
            expect(
                screen.queryByRole("dialog", {
                    name: /dashboard logs/i,
                })
            ).not.toBeInTheDocument();
        });
        clickElement(screen.getAllByLabelText(/open console for dashboard/i)[0]!);
        const consoleCommandInput = screen.getByPlaceholderText(
            /command to run inside container/i
        );
        expect(consoleCommandInput.parentElement?.parentElement).toHaveClass(
            "min-w-0",
            "flex-1"
        );
        expect(
            screen.getByRole("button", {
                name: "Send",
            }).parentElement
        ).toHaveClass("sm:min-w-44", "sm:items-center");
        await user.type(consoleCommandInput, "echo hello{enter}");
        await waitFor(() => {
            expect(fetchMock).toHaveBeenCalledWith(
                "/api/docker/exec/start",
                expect.objectContaining({
                    method: "POST",
                })
            );
        });
        clickElement(screen.getByLabelText(/close dashboard console/i));
        await waitFor(() => {
            expect(
                screen.queryByRole("dialog", {
                    name: /dashboard console/i,
                })
            ).not.toBeInTheDocument();
        });
        clickElement(screen.getByLabelText(/open details for dashboard/i));
        expect(await screen.findByText("Networks")).toBeInTheDocument();
        expect(screen.getByText("MAC: 02:42:ac:14:00:02")).toBeInTheDocument();
        clickElement(screen.getByLabelText(/close dashboard/i));
        clickElement(
            screen.getAllByRole("button", {
                name: /remove unused/i,
            })[0]!
        );
        await waitFor(() => {
            expect(screen.getByText("pruned")).toBeInTheDocument();
        });
        clickElement(
            screen.getAllByRole("button", {
                name: /delete unused:<none>/i,
            })[0]!
        );
        expect(screen.getByText("Delete image")).toBeInTheDocument();
        clickElement(
            screen.getByRole("button", {
                name: /^delete$/i,
            })
        );
        await waitFor(() => {
            expect(screen.getByText(/Deleted Docker image/i)).toBeInTheDocument();
        });
        clickElement(
            screen.getAllByRole("button", {
                name: /delete unused-volume/i,
            })[0]!
        );
        expect(screen.getByText("Delete volume")).toBeInTheDocument();
        clickElement(
            screen.getByRole("button", {
                name: /^delete$/i,
            })
        );
        await waitFor(() => {
            expect(
                screen.getByText(/Deleted Docker volume unused-volume/i)
            ).toBeInTheDocument();
        });
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/docker/exec/start",
            expect.objectContaining({
                method: "POST",
            })
        );
        view.unmount();
        view.queryClient.clear();
    }, 10_000);
    it("shows Docker console start failures in the action output pane", async () => {
        const user = userEvent.setup();
        const fetchMock = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
            return Promise.try(() => {
                const url = requestUrl(input);
                const method = init?.method ?? "GET";
                if (method === "POST" && url === "/api/docker/exec/start") {
                    return Response.json(
                        {
                            error: {
                                code: "service_unavailable",
                                message: "console unavailable",
                                requestId: "docker-console-unavailable",
                            },
                        },
                        {
                            status: 503,
                        }
                    );
                }
                return apiResponse(url, method, init);
            });
        });
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
        const consoleDialog = screen.getByRole("dialog", {
            name: /dashboard console/i,
        });
        expect(
            within(consoleDialog).getByText(/Failed to start Docker console/i)
        ).toBeInTheDocument();
        expect(
            within(consoleDialog).getByText(/console unavailable/i)
        ).toBeInTheDocument();
        view.unmount();
        view.queryClient.clear();
    });
    it("dispatches security verification for a protected Docker stack restart", async () => {
        const verificationCodes: string[] = [];
        let view: ReturnType<typeof renderPage> | undefined;
        const onVerificationRequired = (event: Event) => {
            const code = (
                event as CustomEvent<{
                    code?: string;
                }>
            ).detail?.code;
            if (code) {
                verificationCodes.push(code);
            }
        };
        const fetchMock = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
            return Promise.try(() => {
                const url = requestUrl(input);
                const method = init?.method ?? "GET";
                if (method === "POST" && url === "/api/docker/stack/action") {
                    return Response.json(
                        {
                            error: {
                                code: "step_up_required",
                                message: "Recent MFA verification is required",
                                requestId: "docker-stack-step-up",
                            },
                        },
                        {
                            status: 403,
                        }
                    );
                }
                return apiResponse(url, method, init);
            });
        });
        addEventListener("mira:security-verification-required", onVerificationRequired);
        try {
            Object.defineProperty(globalThis, "fetch", {
                configurable: true,
                value: fetchMock,
                writable: true,
            });
            view = renderPage(createElement(Docker));
            await waitFor(() => {
                expect(screen.getByText("Updater overview")).toBeInTheDocument();
            });
            clickElement(
                screen.getByRole("button", {
                    name: /restart stack/i,
                })
            );
            await waitFor(() => {
                expect(verificationCodes).toContain("step_up_required");
            });
            expect(
                screen.getByText(/Recent MFA verification is required/i)
            ).toBeInTheDocument();
        } finally {
            view?.unmount();
            view?.queryClient.clear();
            removeEventListener(
                "mira:security-verification-required",
                onVerificationRequired
            );
        }
    });
    it("clears stale Docker detail stats when live container stats are absent", async () => {
        const fetchMock = jest.fn(
            async (input: RequestInfo | URL, init?: RequestInit) => {
                const url = requestUrl(input);
                const method = init?.method ?? "GET";
                if (url === "/api/cache/docker.summary" && method === "GET") {
                    const response = apiResponse(url, method, init);
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
                if (url === "/api/docker/containers" && method === "GET") {
                    const response = apiResponse(url, method, init);
                    const payload = (await response.json()) as {
                        containers: Array<Record<string, unknown>>;
                        mode: "isolated" | "live";
                    };
                    return Response.json({
                        containers: payload.containers.map((container) => ({
                            ...container,
                            stats: undefined,
                        })),
                        mode: payload.mode,
                    });
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
                    ([url]) => requestUrl(url) === "/api/docker/containers"
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
    it("renders isolated Docker inventory as an explicit read-only snapshot", async () => {
        const fetchMock = jest.fn(
            async (input: RequestInfo | URL, init?: RequestInit) => {
                const url = requestUrl(input);
                const method = init?.method ?? "GET";
                if (url === "/api/docker/containers" && method === "GET") {
                    const response = apiResponse(url, method, init);
                    const payload = (await response.json()) as {
                        containers: Array<Record<string, unknown>>;
                    };
                    return Response.json({
                        containers: payload.containers,
                        mode: "isolated",
                    });
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
        expect(await screen.findByText("Isolated Docker snapshot")).toBeInTheDocument();
        expect(
            screen.getByText(/Live details, logs, console, refreshes, and mutations/)
        ).toBeInTheDocument();
        expect(
            screen.getByRole("button", {
                name: /restart stack/i,
            })
        ).toBeDisabled();
        expect(
            screen.getByRole("button", {
                name: /run updater now/i,
            })
        ).toBeDisabled();
        for (const button of screen.getAllByRole("button", {
            name: /show logs for dashboard/i,
        })) {
            expect(button).toBeDisabled();
        }
        expect(
            fetchMock.mock.calls.some(
                ([url, init]) =>
                    requestUrl(url) === "/api/cache/docker.summary/refresh" &&
                    init?.method === "POST"
            )
        ).toBe(false);
        view.unmount();
        view.queryClient.clear();
    });
});
