import { afterEach, beforeEach, describe, expect, it, jest } from "bun:test";

import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement, type ReactNode } from "react";

import { requestUrl } from "../../../../test/support/fetch";
import { defaultDisableUntilDraft } from "../../components/features/jobs/jobDisableIntentModel";
import { Agents } from "../../pages/Agents";
import { Dashboard } from "../../pages/Dashboard";
import { Database } from "../../pages/Database";
import { Delivery } from "../../pages/Delivery";
import { Docker } from "../../pages/Docker";
import { Files } from "../../pages/Files";
import { Jobs } from "../../pages/Jobs";
import { Logs } from "../../pages/Logs";
import { Moltbook } from "../../pages/Moltbook";
import { Settings } from "../../pages/Settings";
import { Terminal } from "../../pages/Terminal";
import { authActions } from "../../stores/authStore";
import { createPageBehaviorHarness } from "../support/pageBehaviorHarness";
describe("Dashboard core pages", () => {
    const {
        FakeWebSocket,
        animationFrameState,
        apiResponse,
        cancelAnimationFrameForTest,
        jobsApiState,
        logsApiState,
        originalGlobals,
        parseRequestBody,
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
    it("avoids a nearly expired end-of-day disable default", () => {
        const shortlyBeforeOsloMidnight = Date.parse("2026-07-21T21:58:30.000Z");
        expect(defaultDisableUntilDraft(shortlyBeforeOsloMidnight)).toEqual({
            day: 22,
            hour: "00",
            minute: "58",
            month: 7,
            year: 2026,
        });
    });
    it("renders the main data pages from their API contracts", async () => {
        const pages: Array<
            [
                ReactNode,
                string,
                {
                    withRouter?: boolean;
                    withSocket?: boolean;
                }?,
            ]
        > = [
            [createElement(Agents), "Active (1)"],
            [
                createElement(Dashboard),
                "Spydeberg",
                {
                    withSocket: true,
                },
            ],
            [createElement(Database), "SQLite runtime"],
            [createElement(Docker), "dashboard"],
            [createElement(Files), "README.md"],
            [createElement(Jobs), "Heartbeat"],
            [
                createElement(Logs),
                "1 entry",
                {
                    withSocket: true,
                },
            ],
            [createElement(Moltbook), "Dashboard testing"],
            [createElement(Delivery), "Expand backend coverage"],
            [
                createElement(Settings),
                "Two-step login",
                {
                    withRouter: true,
                },
            ],
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
    it("separates Moltbook feed sorting from the content tabs", async () => {
        const view = renderPage(createElement(Moltbook));
        const feedSort = await screen.findByRole("group", {
            name: "Moltbook feed sort",
        });
        const contentTabs = screen.getByRole("group", {
            name: "Moltbook content",
        });
        expect(contentTabs.parentElement?.tagName).toBe("DIV");
        expect(contentTabs.parentElement?.parentElement).toBe(
            feedSort.parentElement?.parentElement?.parentElement
        );
        expect(feedSort.parentElement).not.toBe(contentTabs.parentElement);
        expect(feedSort.parentElement).toHaveClass("mb-4", "lg:mb-6");
        view.unmount();
        view.queryClient.clear();
    });
    it("labels and dismisses file save errors", async () => {
        const user = userEvent.setup();
        const originalFetch = fetch;
        let view: ReturnType<typeof renderPage> | undefined;
        try {
            Object.defineProperty(globalThis, "fetch", {
                configurable: true,
                value: jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
                    return Promise.try(() => {
                        const url = requestUrl(input);
                        const method = init?.method ?? "GET";
                        if (method === "PUT" && url === "/api/files/README.md") {
                            return Response.json(
                                {
                                    error: {
                                        code: "internal_error",
                                        message: "Save failed",
                                        requestId: "file-save-failure",
                                    },
                                },
                                {
                                    status: 500,
                                }
                            );
                        }
                        return apiResponse(url, method, init);
                    });
                }),
                writable: true,
            });
            view = renderPage(createElement(Files));
            await user.click(
                await screen.findByRole("button", {
                    name: "README.md",
                })
            );
            await user.click(
                await screen.findByRole("button", {
                    name: "Raw",
                })
            );
            const editor = await screen.findByRole("textbox");
            await user.clear(editor);
            await user.type(editor, "# Updated Dashboard");
            await user.click(
                screen.getByRole("button", {
                    name: "Save",
                })
            );
            expect(await screen.findByText("Save failed")).toBeInTheDocument();
            await user.click(
                screen.getByRole("button", {
                    name: "Dismiss file error",
                })
            );
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
                const url = requestUrl(input);
                const method = init?.method ?? "GET";
                if (url === "/api/cache/database.summary") {
                    databaseRequestCount += 1;
                    if (databaseRequestCount === 1) {
                        return apiResponse(url, method, init);
                    }
                    const response = apiResponse(url, method, init);
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
        expect(await screen.findByText("SQLite runtime")).toBeInTheDocument();
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
        expect(screen.getByText("SQLite runtime")).toBeInTheDocument();
        view.unmount();
        view.queryClient.clear();
    });
    it("switches database sources without mixing SQLite and PostgreSQL metrics", async () => {
        const user = userEvent.setup();
        const view = renderPage(createElement(Database));
        expect(await screen.findByText("Reusable space")).toBeInTheDocument();
        expect(screen.getByText("SQLite runtime")).toBeInTheDocument();
        expect(screen.queryByText("metabase")).not.toBeInTheDocument();
        const sqliteButton = screen.getByRole("button", {
            name: "Dashboard SQLite",
        });
        const postgresButton = screen.getByRole("button", {
            name: "PostgreSQL (1)",
        });
        expect(sqliteButton).toHaveAttribute("aria-pressed", "true");
        expect(
            sqliteButton.compareDocumentPosition(postgresButton) &
                Node.DOCUMENT_POSITION_FOLLOWING
        ).toBeTruthy();
        await user.click(postgresButton);
        const restoredPostgresRows = await screen.findAllByText("metabase");
        expect(restoredPostgresRows.length).toBeGreaterThan(0);
        expect(screen.queryByText("SQLite runtime")).not.toBeInTheDocument();
        view.unmount();
        view.queryClient.clear();
    });
    it("places database attention directly below each source overview", async () => {
        const user = userEvent.setup();
        Object.defineProperty(globalThis, "fetch", {
            configurable: true,
            value: jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
                const url = requestUrl(input);
                const method = init?.method ?? "GET";
                const response = apiResponse(url, method, init);
                if (url !== "/api/cache/database.summary") {
                    return response;
                }
                const envelope = (await response.json()) as {
                    data: {
                        overview: Record<string, unknown>;
                        sqlite: {
                            attention: string[];
                            status: "healthy" | "review";
                        };
                    };
                };
                envelope.data.overview.maintenance = {
                    estimatedReclaimableBytes: 6_442_450_944,
                    estimatedReclaimablePercent: 75,
                    highDeadTupleTableCount: 1,
                    hintCount: 3,
                    isBloatAssessmentIncomplete: false,
                    physicalTableBytes: 8_589_934_592,
                    requiresBloatReview: true,
                    reviewMinimumBytes: 1_073_741_824,
                    reviewThresholdBytes: 5_368_709_120,
                    reviewThresholdPercent: 25,
                    slowQueryCount: 1,
                    status: "review",
                    unassessedPhysicalBytes: 0,
                    unassessedTableCount: 0,
                };
                envelope.data.sqlite.attention = ["SQLite test maintenance reason"];
                envelope.data.sqlite.status = "review";
                return Response.json(envelope);
            }),
            writable: true,
        });
        const view = renderPage(createElement(Database));
        await screen.findByText("SQLite runtime");
        const sqliteOverview =
            screen.getByText("Database file").parentElement?.parentElement;
        const sqliteAttention = screen.getByRole("heading", {
            name: "SQLite needs attention",
        }).parentElement;
        expect(sqliteOverview?.nextElementSibling).toBe(sqliteAttention);
        expect(screen.getByText("SQLite test maintenance reason")).toBeInTheDocument();
        await user.click(
            screen.getByRole("button", {
                name: "PostgreSQL (1)",
            })
        );
        const postgresOverviewLabel = await screen.findByText("Comet torrents");
        const postgresOverview = postgresOverviewLabel.parentElement?.parentElement;
        const postgresAttention = screen.getByRole("heading", {
            name: "PostgreSQL needs attention",
        }).parentElement;
        expect(postgresOverview?.nextElementSibling).toBe(postgresAttention);
        expect(
            screen.getByText("1 query averages at least 500 ms. Review query performance")
        ).toBeInTheDocument();
        view.unmount();
        view.queryClient.clear();
    });
    it("shows the agents error state without the configured-agents empty state", async () => {
        Object.defineProperty(globalThis, "fetch", {
            configurable: true,
            value: jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
                return Promise.try(() => {
                    const url = requestUrl(input);
                    const method = init?.method ?? "GET";
                    if (url === "/api/agents/status" && method === "GET") {
                        return Response.json(
                            {
                                error: {
                                    code: "service_unavailable",
                                    message: "Agents status unavailable",
                                    requestId: "agents-status-unavailable",
                                },
                            },
                            {
                                status: 503,
                            }
                        );
                    }
                    return apiResponse(url, method, init);
                });
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
        const fetchMock = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
            return Promise.try(() => {
                const url = requestUrl(input);
                const method = init?.method ?? "GET";
                if (url === "/api/jobs" && method === "GET") {
                    scheduledJobsRequestCount += 1;
                    if (scheduledJobsRequestCount > 1) {
                        return Response.json(
                            {
                                error: {
                                    code: "service_unavailable",
                                    message: "Scheduled jobs temporarily unavailable",
                                    requestId: "scheduled-jobs-unavailable",
                                },
                            },
                            {
                                status: 503,
                            }
                        );
                    }
                }
                if (url === "/api/cron/jobs" && method === "GET") {
                    cronJobsRequestCount += 1;
                    if (cronJobsRequestCount > 1) {
                        return Response.json(
                            {
                                error: {
                                    code: "service_unavailable",
                                    message: "Cron jobs temporarily unavailable",
                                    requestId: "cron-jobs-unavailable",
                                },
                            },
                            {
                                status: 503,
                            }
                        );
                    }
                }
                return apiResponse(url, method, init);
            });
        });
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
        await user.click(
            screen.getByRole("button", {
                name: /openclaw cron/i,
            })
        );
        const cronJobRows = await screen.findAllByText("heartbeat");
        expect(cronJobRows.length).toBeGreaterThan(0);
        await act(async () => {
            await view.queryClient.invalidateQueries({
                queryKey: ["cron", "jobs"],
            });
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
    it("falls back safely when a stored disabled-until timestamp is invalid", async () => {
        jobsApiState.heartbeatEnabled = false;
        jobsApiState.heartbeatDisableIntent = {
            mode: "until",
            comment: "Stored maintenance window",
            until: "not-a-date",
        };
        const user = userEvent.setup();
        const view = renderPage(createElement(Jobs));
        await user.click(
            await screen.findByRole("button", {
                name: "Edit disabled reason",
            })
        );
        expect(
            screen.getByRole("heading", {
                name: "Edit disabled state",
            })
        ).toBeInTheDocument();
        expect(
            screen.getByRole("button", {
                name: /choose disabled until date, selected \d{2}\/\d{2}\/\d{4}/i,
            })
        ).toBeInTheDocument();
        view.unmount();
        view.queryClient.clear();
    });
    it("links git workspace repositories and refreshes every Moltbook cache", async () => {
        const user = userEvent.setup();
        const fetchMock = fetch as unknown as ReturnType<typeof jest.fn>;
        const view = renderPage(createElement(Dashboard), {
            withSocket: true,
        });
        const dashboardRepoLink = await screen.findByRole("link", {
            name: /open mira dashboard on github/i,
        });
        expect(dashboardRepoLink).toHaveAttribute(
            "href",
            "https://github.com/rajohan/Mira-Dashboard"
        );
        await user.click(
            screen.getByRole("button", {
                name: /force update moltbook/i,
            })
        );
        await waitFor(() => {
            for (const key of [
                "moltbook.home",
                "moltbook.feed.hot",
                "moltbook.feed.new",
                "moltbook.profile",
                "moltbook.my-content",
            ]) {
                expect(fetchMock).toHaveBeenCalledWith(
                    `/api/cache/${key}/refresh`,
                    expect.objectContaining({
                        method: "POST",
                    })
                );
            }
        });
        view.unmount();
        view.queryClient.clear();
    });
    it("drives settings backup, restart, skill toggle, and save flows", async () => {
        const user = userEvent.setup();
        const createObjectUrl = jest.fn(() => "blob:settings-backup");
        const revokeObjectUrl = jest.fn();
        const originalCreateObjectUrl = URL.createObjectURL.bind(URL);
        const originalRevokeObjectUrl = URL.revokeObjectURL.bind(URL);
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
            renderPage(createElement(Settings), {
                withRouter: true,
            });
            expect(await screen.findByText("Two-step login")).toBeInTheDocument();
            const dashboardSettingsButton = screen.getByRole("button", {
                name: "Dashboard settings",
            });
            const openClawSettingsButton = screen.getByRole("button", {
                name: "OpenClaw settings",
            });
            expect(dashboardSettingsButton).toHaveAttribute("aria-pressed", "true");
            expect(
                dashboardSettingsButton.compareDocumentPosition(openClawSettingsButton) &
                    Node.DOCUMENT_POSITION_FOLLOWING
            ).toBeTruthy();
            await user.click(openClawSettingsButton);
            expect(await screen.findByText("Model Configuration")).toBeInTheDocument();
            await user.click(
                screen.getByRole("button", {
                    name: /^backup$/i,
                })
            );
            await waitFor(() => expect(createObjectUrl).toHaveBeenCalled());
            expect(anchorClick).toHaveBeenCalled();
            expect(revokeObjectUrl).toHaveBeenCalledWith("blob:settings-backup");
            await user.click(
                screen.getByRole("button", {
                    name: /^session$/i,
                })
            );
            await user.clear(screen.getByLabelText(/idle timeout/i));
            await user.type(screen.getByLabelText(/idle timeout/i), "45");
            await user.click(
                screen
                    .getAllByRole("button", {
                        name: /^save$/i,
                    })
                    .at(-1)!
            );
            expect(await screen.findByText("Session settings saved")).toBeInTheDocument();
            await user.click(
                screen.getByRole("button", {
                    name: /^heartbeat$/i,
                })
            );
            await user.clear(screen.getByLabelText("Interval (seconds)"));
            await user.type(screen.getByLabelText("Interval (seconds)"), "120");
            await user.clear(screen.getByLabelText("Target Channel"));
            await user.type(screen.getByLabelText("Target Channel"), "ops-room");
            await user.click(
                screen
                    .getAllByRole("button", {
                        name: /^save$/i,
                    })
                    .at(-1)!
            );
            expect(
                await screen.findByText("Heartbeat settings saved")
            ).toBeInTheDocument();
            await user.click(
                screen.getByRole("button", {
                    name: /^skills$/i,
                })
            );
            await user.click(
                screen.getByRole("switch", {
                    name: "Toggle task-tracking",
                })
            );
            await user.click(
                screen.getByRole("button", {
                    name: /^restart$/i,
                })
            );
            const restartDialog = screen.getByRole("dialog", {
                name: "Restart Gateway",
            });
            const restartDialogButtons = [...restartDialog.querySelectorAll("button")];
            await user.click(restartDialogButtons.at(-1)!);
            await waitFor(() =>
                expect(
                    (
                        fetch as unknown as {
                            mock: {
                                calls: Array<[string, RequestInit | undefined]>;
                            };
                        }
                    ).mock.calls.some(
                        ([url, init]) => url === "/api/restart" && init?.method === "POST"
                    )
                ).toBe(true)
            );
            const fetchCalls = (
                fetch as unknown as {
                    mock: {
                        calls: Array<[string, RequestInit | undefined]>;
                    };
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
                        session: {
                            reset: {
                                idleMinutes: 45,
                            },
                        },
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
                        expect.objectContaining({
                            method: "POST",
                        }),
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
        await user.click(
            screen.getByRole("button", {
                name: /save schedule/i,
            })
        );
        await waitFor(() => {
            expect(screen.getAllByText("Schedule: Every 1h").length).toBeGreaterThan(0);
        });
        const disableDraftBeforeOpen = defaultDisableUntilDraft();
        await user.click(screen.getByLabelText("Enabled"));
        expect(
            screen.getByRole("heading", {
                name: "Disable job",
            })
        ).toBeInTheDocument();
        const disabledUntilGroup = screen.getByRole("group", {
            name: "Disabled until",
        });
        const disabledUntilDateButton = within(disabledUntilGroup).getByRole("button", {
            name: /choose disabled until date, selected \d{2}\/\d{2}\/\d{4}/i,
        });
        const disableCommentInput = screen.getByLabelText("Comment");
        const disableDraftAfterOpen = defaultDisableUntilDraft();
        const expectedDisableDates = [disableDraftBeforeOpen, disableDraftAfterOpen].map(
            ({ day, month, year }) =>
                `${String(day).padStart(2, "0")}/${String(month).padStart(2, "0")}/${year}`
        );
        expect(
            expectedDisableDates.some((date) =>
                disabledUntilDateButton.textContent?.includes(date)
            )
        ).toBe(true);
        expect(screen.getByTestId("date-time-picker-fields")).toHaveClass(
            "min-w-0",
            "grid-cols-1"
        );
        expect(
            screen.getByRole("button", {
                name: /disabled until hour: \d{2}/i,
            })
        ).toBeInTheDocument();
        expect(
            screen.getByRole("button", {
                name: /disabled until minute: \d{2}/i,
            })
        ).toBeInTheDocument();
        await user.click(disabledUntilDateButton);
        const calendar = screen.getByTestId("date-picker-calendar");
        const previousMonthButton = calendar.querySelector<HTMLButtonElement>(
            ":scope .rdp-button_previous"
        );
        const nextMonthButton = calendar.querySelector<HTMLButtonElement>(
            ":scope .rdp-button_next"
        );
        expect(previousMonthButton).not.toBeNull();
        expect(previousMonthButton).toHaveClass("hover:bg-primary-700!");
        expect(nextMonthButton).toHaveClass("hover:bg-primary-700!");
        await user.click(previousMonthButton as HTMLButtonElement);
        const pastDayButton = calendar.querySelector<HTMLButtonElement>(
            ":scope .rdp-day:not(.rdp-outside) .rdp-day_button:not(:disabled)"
        );
        expect(pastDayButton).not.toBeNull();
        expect(pastDayButton).toHaveClass("hover:enabled:bg-primary-700!");
        await user.click(pastDayButton as HTMLButtonElement);
        await user.type(disableCommentInput, "Paused Dashboard maintenance");
        await user.click(
            screen.getByRole("button", {
                name: "Disable job",
            })
        );
        expect(disabledUntilGroup).toHaveTextContent("Choose a future date and time.");
        expect(disableCommentInput.parentElement).not.toHaveTextContent(
            "Choose a future date and time."
        );
        await user.click(
            screen.getByRole("button", {
                name: /disabled duration: until a date/i,
            })
        );
        await user.click(screen.getByText("Indefinitely"));
        await user.click(
            screen.getByRole("button", {
                name: "Disable job",
            })
        );
        await waitFor(() => {
            expect(
                screen.queryByRole("heading", {
                    name: "Disable job",
                })
            ).not.toBeInTheDocument();
            expect(screen.getByText("Paused Dashboard maintenance")).toBeInTheDocument();
        });
        await user.click(
            screen.getByRole("button", {
                name: /run now/i,
            })
        );
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
        await user.click(
            screen.getByRole("button", {
                name: /trigger now/i,
            })
        );
        await waitFor(() => {
            expect(screen.getByText(/Triggered/)).toBeInTheDocument();
        });
        await user.click(screen.getByLabelText("Enabled"));
        expect(
            screen.getByRole("heading", {
                name: "Disable job",
            })
        ).toBeInTheDocument();
        await user.click(
            screen.getByRole("button", {
                name: /disabled duration: until a date/i,
            })
        );
        await user.click(screen.getByText("Indefinitely"));
        await user.type(screen.getByLabelText("Comment"), "Paused during chat work");
        await user.click(
            screen.getByRole("button", {
                name: "Disable job",
            })
        );
        await waitFor(() => {
            expect(
                screen.queryByRole("heading", {
                    name: "Disable job",
                })
            ).not.toBeInTheDocument();
        });
        await user.click(
            screen.getByRole("button", {
                name: /^edit$/i,
            })
        );
        await user.clear(screen.getByLabelText("Name"));
        await user.type(screen.getByLabelText("Name"), "heartbeat-updated");
        await user.click(
            screen.getByRole("button", {
                name: /save edits/i,
            })
        );
        await waitFor(() => {
            expect(screen.getAllByText("heartbeat-updated").length).toBeGreaterThan(0);
        });
        await user.click(
            screen.getByRole("button", {
                name: /^delete$/i,
            })
        );
        expect(
            screen.getByRole("heading", {
                name: "Delete cron job",
            })
        ).toBeInTheDocument();
        await user.click(
            screen.getByRole("button", {
                name: /^delete cron job$/i,
            })
        );
        await waitFor(() => {
            expect(screen.queryByText("Delete cron job")).not.toBeInTheDocument();
        });
        view.unmount();
        view.queryClient.clear();
    }, 15_000);
});
