import { afterEach, beforeEach, describe, expect, it, jest } from "bun:test";

import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement } from "react";

import { requestUrl } from "../../../../test/support/fetch";
import { Delivery } from "../../pages/Delivery";
import { authActions } from "../../stores/authStore";
import { createPageBehaviorHarness } from "../support/pageBehaviorHarness";
describe("Dashboard pull request pages", () => {
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
    it("drives pull request review, branch update, deploy, merge, and reject flows", async () => {
        const user = userEvent.setup();
        const view = renderPage(createElement(Delivery));
        await waitFor(() => {
            expect(
                screen.getByRole("heading", {
                    name: "Delivery",
                })
            ).toBeInTheDocument();
            expect(screen.getByText("Expand backend coverage")).toBeInTheDocument();
            expect(screen.getByText("Bump dashboard dependency")).toBeInTheDocument();
            expect(screen.getByText("Deploy dashboard")).toBeInTheDocument();
            expect(screen.getByText("Current dashboard release")).toBeInTheDocument();
            expect(screen.getByText("Previous dashboard release")).toBeInTheDocument();
        });
        expect(screen.getAllByText("1 PR")).toHaveLength(2);
        expect(screen.getByText("Coverage body")).toBeInTheDocument();
        await user.click(
            screen.getByRole("button", {
                name: "Approve PR",
            })
        );
        expect(
            screen.getByRole("heading", {
                name: "Approve PR",
            })
        ).toBeInTheDocument();
        await user.click(
            screen
                .getAllByRole("button", {
                    name: "Approve PR",
                })
                .at(-1)!
        );
        await waitFor(() => {
            expect(screen.getByText("Approved PR #191")).toBeInTheDocument();
        });
        await user.click(
            screen.getByRole("button", {
                name: "Update branch",
            })
        );
        await waitFor(() => {
            expect(screen.getByText("Branch update queued")).toBeInTheDocument();
        });
        await user.click(
            screen.getByRole("button", {
                name: "Deploy latest main",
            })
        );
        expect(
            screen.getByRole("heading", {
                name: "Deploy latest main",
            })
        ).toBeInTheDocument();
        await user.click(
            screen
                .getAllByRole("button", {
                    name: "Deploy latest main",
                })
                .at(-1)!
        );
        await waitFor(() => {
            expect(screen.getByText("Deploy scheduled")).toBeInTheDocument();
        });
        await user.click(
            screen.getByRole("button", {
                name: "Roll back to def45678",
            })
        );
        expect(
            screen.getByRole("heading", {
                name: "Roll back to def45678",
            })
        ).toBeInTheDocument();
        await user.click(
            screen
                .getAllByRole("button", {
                    name: "Roll back to def45678",
                })
                .at(-1)!
        );
        await waitFor(() => {
            expect(screen.getByText("Rollback to def45678 queued")).toBeInTheDocument();
        });
        await user.click(
            screen.getAllByRole("button", {
                name: "Merge only",
            })[0]!
        );
        expect(
            screen.getByRole("heading", {
                name: "Merge PR",
            })
        ).toBeInTheDocument();
        await user.click(
            screen.getByRole("button", {
                name: "Merge PR",
            })
        );
        await waitFor(() => {
            expect(screen.getByText(/Merged PR #190/)).toBeInTheDocument();
            expect(screen.getByText(/Cleaned worktree/)).toBeInTheDocument();
        });
        expect(screen.getByText("isOk")).toHaveClass("text-green-400");
        await user.click(
            screen.getAllByRole("button", {
                name: "Reject",
            })[0]!
        );
        expect(
            screen.getByRole("heading", {
                name: "Reject PR",
            })
        ).toBeInTheDocument();
        await user.click(
            screen.getByRole("button", {
                name: "Reject PR",
            })
        );
        await waitFor(() => {
            expect(screen.getByText("Rejected PR #190")).toBeInTheDocument();
        });
        view.unmount();
        view.queryClient.clear();
    });
    it("closes merge confirmations while the merge job continues", async () => {
        const user = userEvent.setup();
        const defaultFetch = globalThis.fetch;
        let finishMerge: ((response: Response) => void) | undefined;
        const mergeResponse = new Promise<Response>((resolve) => {
            finishMerge = resolve;
        });
        Object.defineProperty(globalThis, "fetch", {
            configurable: true,
            value: jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
                const url = requestUrl(input);
                const method = init?.method ?? "GET";
                if (method === "POST" && url === "/api/pull-requests/190/approve") {
                    expect(parseRequestBody(init)).toEqual({
                        deploy: true,
                        expectedHeadSha: "a".repeat(40),
                        mergeStack: false,
                    });
                    return mergeResponse;
                }
                return defaultFetch(input, init);
            }),
            writable: true,
        });
        const view = renderPage(createElement(Delivery));
        await screen.findByText("Expand backend coverage");
        await user.click(
            screen.getAllByRole("button", {
                name: "Merge + Deploy",
            })[0]!
        );
        const dialog = screen.getByRole("dialog", {
            name: "Merge + Deploy",
        });
        await user.click(
            within(dialog).getByRole("button", {
                name: "Merge + Deploy",
            })
        );
        expect(
            screen.queryByRole("dialog", {
                name: "Merge + Deploy",
            })
        ).toBeNull();
        expect(
            screen.getByText("Merging PR #190 and preparing deploy...")
        ).toBeInTheDocument();
        expect(
            screen.getAllByRole("button", {
                name: "Merge + Deploy",
            })[0]
        ).toBeDisabled();
        await waitFor(() => {
            expect(scrollIntoViewMock).toHaveBeenCalledWith({
                behavior: "smooth",
                block: "start",
            });
        });
        act(() => {
            finishMerge?.(
                Response.json({
                    isOk: true,
                    message: "PR #190 merged. Deploy started",
                })
            );
        });
        await waitFor(() => {
            expect(
                screen.getByText("PR #190 merged. Deploy started")
            ).toBeInTheDocument();
            expect(
                screen.queryByText("Merging PR #190 and preparing deploy...")
            ).toBeNull();
        });
        view.unmount();
        view.queryClient.clear();
    });
    it("shows dependent PR chains and creates GitHub stacks bottom-to-top", async () => {
        const user = userEvent.setup();
        const defaultFetch = globalThis.fetch;
        const stackCreateRequests: unknown[] = [];
        Object.defineProperty(globalThis, "fetch", {
            configurable: true,
            value: jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
                const url = requestUrl(input);
                const method = init?.method ?? "GET";
                if (url === "/api/pull-requests") {
                    return Promise.resolve(
                        Response.json({
                            pullRequests: [
                                {
                                    author: {
                                        login: "mira-2026",
                                    },
                                    baseRefName: "main",
                                    createdAt: "2026-07-30T07:00:00.000Z",
                                    headRefName: "feat/models",
                                    headRefOid: "c".repeat(40),
                                    isDraft: false,
                                    mergeable: "MERGEABLE",
                                    mergeStateStatus: "CLEAN",
                                    number: 370,
                                    previewEligible: true,
                                    reviewDecision: "APPROVED",
                                    reviewerApproved: true,
                                    statusCheckRollup: [
                                        {
                                            status: "SUCCESS",
                                        },
                                    ],
                                    title: "Add chat models",
                                    updatedAt: "2026-07-30T08:00:00.000Z",
                                    url: "https://github.com/rajohan/Mira-Dashboard/pull/370",
                                },
                                {
                                    author: {
                                        login: "mira-2026",
                                    },
                                    baseRefName: "feat/models",
                                    createdAt: "2026-07-30T08:00:00.000Z",
                                    headRefName: "feat/chat-ui",
                                    headRefOid: "d".repeat(40),
                                    isDraft: false,
                                    mergeable: "MERGEABLE",
                                    mergeStateStatus: "CLEAN",
                                    number: 371,
                                    previewEligible: true,
                                    reviewDecision: "APPROVED",
                                    reviewerApproved: true,
                                    statusCheckRollup: [
                                        {
                                            status: "SUCCESS",
                                        },
                                    ],
                                    title: "Add chat UI",
                                    updatedAt: "2026-07-30T09:00:00.000Z",
                                    url: "https://github.com/rajohan/Mira-Dashboard/pull/371",
                                },
                            ],
                        })
                    );
                }
                if (method === "POST" && url === "/api/pull-requests/stacks") {
                    stackCreateRequests.push(parseRequestBody(init));
                    return Promise.resolve(
                        Response.json({
                            isOk: true,
                            message: "GitHub stack #372 created with 2 PRs",
                        })
                    );
                }
                return defaultFetch(input, init);
            }),
            writable: true,
        });
        const view = renderPage(createElement(Delivery));
        const candidates = await screen.findByRole("region", {
            name: "GitHub stack candidates",
        });
        expect(within(candidates).getByText("#370 → #371")).toBeInTheDocument();
        expect(
            screen.getByRole("link", {
                name: "Add chat models",
            })
        ).toBeInTheDocument();
        expect(
            screen.getByRole("link", {
                name: "Add chat UI",
            })
        ).toBeInTheDocument();
        expect(
            screen.getAllByText(/in an unlinked GitHub stack candidate/u)
        ).toHaveLength(2);
        expect(
            screen.queryByRole("button", {
                name: "Merge only",
            })
        ).toBeNull();
        expect(
            screen.queryByRole("button", {
                name: "Reject",
            })
        ).toBeNull();
        expect(
            screen.getAllByText(/before reviewing, merging, or rejecting/u)
        ).toHaveLength(2);
        const runInDevButtons = screen.getAllByRole("button", {
            name: "Run in dev",
        });
        expect(runInDevButtons).toHaveLength(2);
        await user.click(runInDevButtons[1] as HTMLButtonElement);
        const previewDialog = screen.getByRole("dialog", {
            name: "Run PR in dev",
        });
        expect(
            within(previewDialog).getByText(/Included layers: #370 → #371/u)
        ).toBeInTheDocument();
        expect(
            within(previewDialog).getByText(/exact PR head dddddddd/u)
        ).toBeInTheDocument();
        await user.click(
            within(previewDialog).getByRole("button", {
                name: "Cancel",
            })
        );
        await user.click(
            within(candidates).getByRole("button", {
                name: "Create stack",
            })
        );
        expect(
            screen.getByRole("heading", {
                name: "Create GitHub stack",
            })
        ).toBeInTheDocument();
        const dialog = screen.getByRole("dialog", {
            name: "Create GitHub stack",
        });
        expect(within(dialog).getByText(/#370 → #371/u)).toBeInTheDocument();
        await user.click(
            screen.getByRole("button", {
                name: "Create GitHub stack",
            })
        );
        await waitFor(() => {
            expect(
                screen.getByText("GitHub stack #372 created with 2 PRs")
            ).toBeInTheDocument();
        });
        expect(stackCreateRequests).toEqual([
            {
                pullRequests: [370, 371],
            },
        ]);
        view.unmount();
        view.queryClient.clear();
    });
    it("keeps standalone fork controls available when its head matches main", async () => {
        const defaultFetch = globalThis.fetch;
        Object.defineProperty(globalThis, "fetch", {
            configurable: true,
            value: jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
                if (requestUrl(input) === "/api/pull-requests") {
                    return Promise.resolve(
                        Response.json({
                            pullRequests: [
                                {
                                    author: {
                                        login: "mira-2026",
                                    },
                                    baseRefName: "main",
                                    createdAt: "2026-07-30T07:00:00.000Z",
                                    headRefName: "main",
                                    headRefOid: "e".repeat(40),
                                    isCrossRepository: true,
                                    isDraft: false,
                                    mergeable: "MERGEABLE",
                                    mergeStateStatus: "CLEAN",
                                    number: 372,
                                    canReviewerApprove: true,
                                    previewEligible: false,
                                    reviewDecision: "REVIEW_REQUIRED",
                                    reviewerApproved: false,
                                    statusCheckRollup: [
                                        {
                                            status: "SUCCESS",
                                        },
                                    ],
                                    title: "Fork default branch",
                                    updatedAt: "2026-07-30T08:00:00.000Z",
                                    url: "https://github.com/rajohan/Mira-Dashboard/pull/372",
                                },
                                {
                                    author: {
                                        login: "mira-2026",
                                    },
                                    baseRefName: "main",
                                    createdAt: "2026-07-30T08:00:00.000Z",
                                    headRefName: "ordinary-root",
                                    headRefOid: "f".repeat(40),
                                    isCrossRepository: false,
                                    isDraft: false,
                                    mergeable: "MERGEABLE",
                                    mergeStateStatus: "CLEAN",
                                    number: 373,
                                    previewEligible: false,
                                    reviewDecision: "APPROVED",
                                    reviewerApproved: true,
                                    statusCheckRollup: [
                                        {
                                            status: "SUCCESS",
                                        },
                                    ],
                                    title: "Ordinary root PR",
                                    updatedAt: "2026-07-30T09:00:00.000Z",
                                    url: "https://github.com/rajohan/Mira-Dashboard/pull/373",
                                },
                            ],
                        })
                    );
                }
                return defaultFetch(input, init);
            }),
            writable: true,
        });
        const view = renderPage(createElement(Delivery));
        expect(await screen.findByText("Fork default branch")).toBeInTheDocument();
        expect(screen.queryByText(/ambiguous or incomplete dependent chain/u)).toBeNull();
        expect(
            screen.getByRole("button", {
                name: "Approve PR",
            })
        ).toBeEnabled();
        expect(
            screen.getAllByRole("button", {
                name: "Merge only",
            })
        ).toHaveLength(2);
        expect(
            screen.getAllByRole("button", {
                name: "Reject",
            })
        ).toHaveLength(2);
        view.unmount();
        view.queryClient.clear();
    });
    it("groups native stacks and merges through the selected layer with cleanup details", async () => {
        const user = userEvent.setup();
        const defaultFetch = globalThis.fetch;
        Object.defineProperty(globalThis, "fetch", {
            configurable: true,
            value: jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
                const url = requestUrl(input);
                const method = init?.method ?? "GET";
                if (url === "/api/pull-requests") {
                    return Promise.resolve(
                        Response.json({
                            pullRequests: [
                                {
                                    additions: 8,
                                    author: {
                                        login: "mira-2026",
                                    },
                                    baseRefName: "main",
                                    body: "Canonical foundation",
                                    canReviewerApprove: false,
                                    changedFiles: 2,
                                    createdAt: "2026-07-30T07:00:00.000Z",
                                    deletions: 1,
                                    headRefName: "feat/canonical-chat-v2",
                                    headRefOid: "a".repeat(40),
                                    isDraft: false,
                                    mergeable: "MERGEABLE",
                                    mergeStateStatus: "CLEAN",
                                    number: 352,
                                    previewEligible: true,
                                    reviewDecision: "APPROVED",
                                    reviewerApproved: true,
                                    stack: {
                                        baseRefName: "main",
                                        number: 360,
                                        position: 1,
                                        size: 2,
                                    },
                                    statusCheckRollup: [
                                        {
                                            conclusion: "SUCCESS",
                                            status: "COMPLETED",
                                        },
                                    ],
                                    title: "Canonical chat foundation",
                                    updatedAt: "2026-07-30T08:00:00.000Z",
                                    url: "https://github.com/rajohan/Mira-Dashboard/pull/352",
                                },
                                {
                                    additions: 14,
                                    author: {
                                        login: "mira-2026",
                                    },
                                    baseRefName: "feat/canonical-chat-v2",
                                    body: "Stacked projection",
                                    canReviewerApprove: false,
                                    changedFiles: 4,
                                    createdAt: "2026-07-30T08:00:00.000Z",
                                    deletions: 3,
                                    headRefName: "feat/chat-state-machine-matrix",
                                    headRefOid: "b".repeat(40),
                                    isDraft: false,
                                    mergeable: "MERGEABLE",
                                    mergeStateStatus: "CLEAN",
                                    number: 353,
                                    previewEligible: true,
                                    reviewDecision: "APPROVED",
                                    reviewerApproved: true,
                                    stack: {
                                        baseRefName: "main",
                                        number: 360,
                                        position: 2,
                                        size: 2,
                                    },
                                    statusCheckRollup: [
                                        {
                                            conclusion: "SUCCESS",
                                            status: "COMPLETED",
                                        },
                                    ],
                                    title: "Canonical state machine",
                                    updatedAt: "2026-07-30T09:00:00.000Z",
                                    url: "https://github.com/rajohan/Mira-Dashboard/pull/353",
                                },
                            ],
                        })
                    );
                }
                if (method === "POST" && url === "/api/pull-requests/353/approve") {
                    expect(parseRequestBody(init)).toEqual({
                        deploy: false,
                        expectedHeadSha: "b".repeat(40),
                        expectedStackHeads: [
                            {
                                headSha: "a".repeat(40),
                                number: 352,
                            },
                            {
                                headSha: "b".repeat(40),
                                number: 353,
                            },
                        ],
                        mergeStack: true,
                    });
                    return Promise.resolve(
                        Response.json({
                            cleanups: [
                                {
                                    branch: "feat/canonical-chat-v2",
                                    message:
                                        "Removed local worktree for feat/canonical-chat-v2",
                                    status: "removed",
                                },
                                {
                                    branch: "feat/chat-state-machine-matrix",
                                    message:
                                        "Removed local worktree for feat/chat-state-machine-matrix",
                                    status: "removed",
                                },
                            ],
                            isOk: true,
                            mergeStatus: "merged",
                            message: "Stack #360 merged through PR #353 (2 PRs)",
                            previewCleanups: [
                                {
                                    message: "No managed PR dev data found for #352",
                                    number: 352,
                                    status: "skipped",
                                },
                                {
                                    message: "No managed PR dev data found for #353",
                                    number: 353,
                                    status: "skipped",
                                },
                            ],
                        })
                    );
                }
                return defaultFetch(input, init);
            }),
            writable: true,
        });
        const view = renderPage(createElement(Delivery));
        await waitFor(() => {
            expect(
                screen.getByRole("link", {
                    name: "Canonical state machine",
                })
            ).toBeInTheDocument();
        });
        expect(
            screen.getByRole("region", {
                name: "GitHub stacks",
            })
        ).toBeInTheDocument();
        const stack = screen.getByLabelText("GitHub stack #360");
        expect(within(stack).getByText("Bottom → top")).toBeInTheDocument();
        expect(within(stack).getByText("1/2")).toBeInTheDocument();
        expect(within(stack).getByText("2/2")).toBeInTheDocument();
        expect(
            within(stack).getByRole("button", {
                name: "Merge stack through #353",
            })
        ).toBeEnabled();
        expect(
            within(stack).queryByRole("button", {
                name: "Reject",
            })
        ).toBeNull();
        expect(
            within(stack).getAllByText(/closing one member leaves a blocker/u)
        ).toHaveLength(2);
        const stackRunInDevButtons = within(stack).getAllByRole("button", {
            name: "Run in dev",
        });
        expect(stackRunInDevButtons).toHaveLength(2);
        await user.click(stackRunInDevButtons[1] as HTMLButtonElement);
        const previewDialog = screen.getByRole("dialog", {
            name: "Run PR in dev",
        });
        expect(
            within(previewDialog).getByText(/Included layers: #352 → #353/u)
        ).toBeInTheDocument();
        await user.click(
            within(previewDialog).getByRole("button", {
                name: "Cancel",
            })
        );
        await user.click(
            within(stack).getByRole("button", {
                name: "Merge stack through #353",
            })
        );
        expect(
            screen.getByRole("heading", {
                name: "Merge stack",
            })
        ).toBeInTheDocument();
        expect(screen.getByText(/one all-or-nothing merge group/i)).toBeInTheDocument();
        expect(
            screen.getByText(/Included exact heads: #352 aaaaaaaa → #353 bbbbbbbb/u)
        ).toBeInTheDocument();
        await user.click(
            screen.getByRole("button", {
                name: "Merge stack",
            })
        );
        await waitFor(() => {
            expect(
                screen.getByText(/Stack #360 merged through PR #353 \(2 PRs\)/u)
            ).toBeInTheDocument();
            expect(
                screen.getByText(
                    /Removed local worktree for feat\/chat-state-machine-matrix/u
                )
            ).toBeInTheDocument();
        });
        view.unmount();
        view.queryClient.clear();
    });
    it("keeps native stacks outside main read-only", async () => {
        const defaultFetch = globalThis.fetch;
        Object.defineProperty(globalThis, "fetch", {
            configurable: true,
            value: jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
                if (requestUrl(input) === "/api/pull-requests") {
                    return Promise.resolve(
                        Response.json({
                            pullRequests: [
                                {
                                    author: {
                                        login: "mira-2026",
                                    },
                                    baseRefName: "develop",
                                    canReviewerApprove: true,
                                    createdAt: "2026-07-30T08:00:00.000Z",
                                    headRefName: "feat/develop-stack",
                                    headRefOid: "c".repeat(40),
                                    isDraft: false,
                                    mergeable: "MERGEABLE",
                                    mergeStateStatus: "CLEAN",
                                    number: 364,
                                    previewEligible: true,
                                    reviewDecision: "REVIEW_REQUIRED",
                                    stack: {
                                        baseRefName: "develop",
                                        number: 361,
                                        position: 1,
                                        size: 1,
                                    },
                                    statusCheckRollup: [
                                        {
                                            conclusion: "SUCCESS",
                                            status: "COMPLETED",
                                        },
                                    ],
                                    title: "Develop-only stack",
                                    updatedAt: "2026-07-30T09:00:00.000Z",
                                    url: "https://github.com/rajohan/Mira-Dashboard/pull/364",
                                },
                            ],
                        })
                    );
                }
                return defaultFetch(input, init);
            }),
            writable: true,
        });
        const view = renderPage(createElement(Delivery));
        const stack = await screen.findByLabelText("GitHub stack #361");
        expect(
            within(stack).getByText(/Only main-rooted stacks can be managed/u)
        ).toBeInTheDocument();
        expect(
            within(stack).queryByRole("button", {
                name: "Approve PR",
            })
        ).toBeNull();
        expect(
            within(stack).queryByRole("button", {
                name: "Run in dev",
            })
        ).toBeNull();
        expect(
            within(stack).queryByRole("button", {
                name: /Merge/u,
            })
        ).toBeNull();
        view.unmount();
        view.queryClient.clear();
    });
    it("keeps PR dev status and controls ahead of review actions", async () => {
        Object.defineProperty(globalThis, "fetch", {
            configurable: true,
            value: jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
                return Promise.try(() => {
                    const url = requestUrl(input);
                    if (url === "/api/pull-requests") {
                        return Response.json({
                            pullRequests: [
                                {
                                    additions: 12,
                                    author: {
                                        login: "mira-2026",
                                    },
                                    baseRefName: "main",
                                    body: "PR dev layout regression",
                                    canReviewerApprove: true,
                                    changedFiles: 2,
                                    createdAt: "2026-06-24T08:00:00.000Z",
                                    deletions: 3,
                                    headRefName: "mira/preview-layout",
                                    headRefOid: "a".repeat(40),
                                    isDraft: false,
                                    mergeable: "MERGEABLE",
                                    mergeStateStatus: "CLEAN",
                                    number: 335,
                                    previewEligible: true,
                                    reviewDecision: "REVIEW_REQUIRED",
                                    statusCheckRollup: [
                                        {
                                            conclusion: "SUCCESS",
                                            status: "COMPLETED",
                                        },
                                    ],
                                    title: "PR dev action layout",
                                    updatedAt: "2026-06-24T08:05:00.000Z",
                                    url: "https://github.com/rajohan/Mira-Dashboard/pull/335",
                                },
                            ],
                        });
                    }
                    if (url === "/api/pull-requests/preview") {
                        return Response.json(
                            {
                                error: {
                                    code: "internal_error",
                                    message:
                                        "bun executable must resolve to an absolute path",
                                    requestId: "preview-start-failure",
                                },
                            },
                            {
                                status: 500,
                            }
                        );
                    }
                    const method = init?.method ?? "GET";
                    return apiResponse(url, method, init);
                });
            }),
            writable: true,
        });
        const view = renderPage(createElement(Delivery));
        const previewStatus = await screen.findByText(
            "PR dev status is unavailable: bun executable must resolve to an absolute path"
        );
        const approveButton = screen.getByRole("button", {
            name: "Approve PR",
        });
        const runInDevButton = screen.getByRole("button", {
            name: "Run in dev",
        });
        expect(
            previewStatus.compareDocumentPosition(runInDevButton) &
                Node.DOCUMENT_POSITION_FOLLOWING
        ).toBeTruthy();
        expect(
            runInDevButton.compareDocumentPosition(approveButton) &
                Node.DOCUMENT_POSITION_FOLLOWING
        ).toBeTruthy();
        expect(previewStatus).toHaveClass("col-span-full", "w-full");
        view.unmount();
        view.queryClient.clear();
    });
    it("shows production-only PR dev controls without a host-path error", async () => {
        const originalFetch = fetch;
        let view: ReturnType<typeof renderPage> | undefined;
        try {
            Object.defineProperty(globalThis, "fetch", {
                configurable: true,
                value: jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
                    return Promise.try(() => {
                        const url = requestUrl(input);
                        if (url === "/api/pull-requests") {
                            return Response.json({
                                pullRequests: [
                                    {
                                        author: {
                                            login: "mira-2026",
                                        },
                                        baseRefName: "main",
                                        createdAt: "2026-06-24T08:00:00.000Z",
                                        headRefName: "mira/dev-safe-preview",
                                        headRefOid: "a".repeat(40),
                                        isDraft: false,
                                        number: 342,
                                        previewEligible: true,
                                        title: "Dev-safe preview controls",
                                        updatedAt: "2026-06-24T08:05:00.000Z",
                                        url: "https://github.com/rajohan/Mira-Dashboard/pull/342",
                                    },
                                ],
                            });
                        }
                        if (url === "/api/pull-requests/preview") {
                            return Response.json({
                                preview: {
                                    controlsAvailable: false,
                                    message:
                                        "PR dev controls are available only from the production Dashboard.",
                                    status: "stopped",
                                },
                            });
                        }
                        const method = init?.method ?? "GET";
                        return apiResponse(url, method, init);
                    });
                }),
                writable: true,
            });
            view = renderPage(createElement(Delivery));
            expect(await screen.findByText("View only")).toBeInTheDocument();
            expect(
                screen.getAllByText(
                    "PR dev controls are available only from the production Dashboard."
                )
            ).toHaveLength(2);
            expect(
                screen.getByRole("button", {
                    name: "Run in dev",
                })
            ).toBeDisabled();
            expect(
                screen.queryByText(/must not overlap Dashboard source/u)
            ).not.toBeInTheDocument();
            expect(
                screen.queryByText(/PR dev status is unavailable/u)
            ).not.toBeInTheDocument();
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
    it("starts and stops an eligible trusted PR development environment", async () => {
        const user = userEvent.setup();
        let preview: Record<string, unknown> = {
            status: "stopped",
        };
        Object.defineProperty(globalThis, "fetch", {
            configurable: true,
            value: jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
                return Promise.try(() => {
                    const url = requestUrl(input);
                    const method = init?.method ?? "GET";
                    if (method === "GET" && url === "/api/pull-requests") {
                        return Response.json({
                            pullRequests: [
                                {
                                    additions: 12,
                                    author: {
                                        login: "mira-2026",
                                    },
                                    baseRefName: "main",
                                    body: "Trusted preview",
                                    changedFiles: 2,
                                    createdAt: "2026-06-24T08:00:00.000Z",
                                    deletions: 3,
                                    headRefName: "mira/trusted-preview",
                                    headRefOid: "a".repeat(40),
                                    isDraft: false,
                                    mergeable: "MERGEABLE",
                                    mergeStateStatus: "CLEAN",
                                    number: 335,
                                    previewEligible: true,
                                    reviewerApproved: true,
                                    reviewDecision: "APPROVED",
                                    statusCheckRollup: [
                                        {
                                            conclusion: "SUCCESS",
                                            status: "COMPLETED",
                                        },
                                    ],
                                    title: "Trusted PR dev",
                                    updatedAt: "2026-06-24T08:05:00.000Z",
                                    url: "https://github.com/rajohan/Mira-Dashboard/pull/335",
                                },
                            ],
                        });
                    }
                    if (method === "GET" && url === "/api/pull-requests/preview") {
                        return Response.json({
                            preview,
                        });
                    }
                    if (
                        method === "POST" &&
                        url === "/api/pull-requests/335/preview/start"
                    ) {
                        expect(parseRequestBody(init)).toEqual({
                            expectedHeadSha: "a".repeat(40),
                        });
                        preview = {
                            commitSha: "a".repeat(40),
                            number: 335,
                            status: "running",
                            title: "Trusted PR dev",
                            updatedAt: "2026-06-24T08:06:00.000Z",
                            url: "https://dashboard.test:5173",
                        };
                        return Response.json({
                            isOk: true,
                            preview,
                        });
                    }
                    if (
                        method === "POST" &&
                        url === "/api/pull-requests/335/preview/stop"
                    ) {
                        expect(parseRequestBody(init)).toEqual({});
                        preview = {
                            ...preview,
                            status: "stopped",
                            updatedAt: "2026-06-24T08:07:00.000Z",
                        };
                        return Response.json({
                            isOk: true,
                            preview,
                        });
                    }
                    return apiResponse(url, method, init);
                });
            }),
            writable: true,
        });
        const view = renderPage(createElement(Delivery));
        await waitFor(() => {
            expect(screen.getByText("Trusted PR dev")).toBeInTheDocument();
        });
        await user.click(
            screen.getByRole("button", {
                name: "Run in dev",
            })
        );
        expect(
            screen.getByRole("heading", {
                name: "Run PR in dev",
            })
        ).toBeInTheDocument();
        expect(screen.getByText(/without source watchers/u)).toBeInTheDocument();
        expect(screen.queryByText(/with hot reload/u)).not.toBeInTheDocument();
        await user.click(
            screen.getByRole("button", {
                name: "Run PR in dev",
            })
        );
        await waitFor(() => {
            expect(
                screen.getByText("PR #335 dev is running at https://dashboard.test:5173")
            ).toBeInTheDocument();
        });
        await user.click(
            screen.getByRole("button", {
                name: "Dismiss action result",
            })
        );
        expect(
            screen.queryByText("PR #335 dev is running at https://dashboard.test:5173")
        ).not.toBeInTheDocument();
        expect(
            screen.getAllByRole("link", {
                name: "Open dev",
            })
        ).toHaveLength(2);
        expect(
            screen.queryByRole("button", {
                name: "Run in dev",
            })
        ).not.toBeInTheDocument();
        expect(
            screen.queryByRole("button", {
                name: "Rebuild dev",
            })
        ).not.toBeInTheDocument();
        await user.click(
            screen.getAllByRole("button", {
                name: "Stop dev",
            })[0]!
        );
        expect(
            screen.getByRole("heading", {
                name: "Stop PR dev",
            })
        ).toBeInTheDocument();
        await user.click(
            screen.getByRole("button", {
                name: "Stop PR dev",
            })
        );
        await waitFor(() => {
            expect(screen.getByText("PR #335 dev stopped")).toBeInTheDocument();
        });
        view.unmount();
        view.queryClient.clear();
    });
    it("labels an active PR dev update as a rebuild", async () => {
        const user = userEvent.setup();
        let startCalls = 0;
        let preview: Record<string, unknown> = {
            commitSha: "b".repeat(40),
            number: 335,
            status: "running",
            title: "Trusted PR dev",
            updatedAt: "2026-06-24T08:06:00.000Z",
            url: "https://dashboard.test:5173",
        };
        Object.defineProperty(globalThis, "fetch", {
            configurable: true,
            value: jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
                return Promise.try(() => {
                    const url = requestUrl(input);
                    const method = init?.method ?? "GET";
                    if (method === "GET" && url === "/api/pull-requests") {
                        return Response.json({
                            pullRequests: [
                                {
                                    author: {
                                        login: "mira-2026",
                                    },
                                    baseRefName: "main",
                                    createdAt: "2026-06-24T08:00:00.000Z",
                                    headRefName: "mira/trusted-preview",
                                    headRefOid: "a".repeat(40),
                                    isDraft: false,
                                    number: 335,
                                    previewEligible: true,
                                    title: "Trusted PR dev",
                                    updatedAt: "2026-06-24T08:05:00.000Z",
                                    url: "https://github.com/rajohan/Mira-Dashboard/pull/335",
                                },
                            ],
                        });
                    }
                    if (method === "GET" && url === "/api/pull-requests/preview") {
                        return Response.json({
                            preview,
                        });
                    }
                    if (
                        method === "POST" &&
                        url === "/api/pull-requests/335/preview/start"
                    ) {
                        expect(parseRequestBody(init)).toEqual({
                            expectedHeadSha: "a".repeat(40),
                        });
                        startCalls += 1;
                        preview = {
                            ...preview,
                            commitSha: "a".repeat(40),
                            updatedAt: "2026-06-24T08:07:00.000Z",
                        };
                        return Response.json({
                            isOk: true,
                            preview: {
                                commitSha: "a".repeat(40),
                                number: 335,
                                status: "starting",
                                title: "Trusted PR dev",
                                updatedAt: "2026-06-24T08:06:30.000Z",
                            },
                        });
                    }
                    return apiResponse(url, method, init);
                });
            }),
            writable: true,
        });
        const view = renderPage(createElement(Delivery));
        expect(
            await screen.findByRole("button", {
                name: "Rebuild dev",
            })
        ).toBeInTheDocument();
        expect(
            screen.queryByRole("button", {
                name: "Run in dev",
            })
        ).not.toBeInTheDocument();
        await user.click(
            screen.getByRole("button", {
                name: "Rebuild dev",
            })
        );
        expect(
            screen.getByRole("heading", {
                name: "Rebuild PR dev",
            })
        ).toBeInTheDocument();
        expect(screen.getByText(/exact PR head aaaaaaaa/u)).toBeInTheDocument();
        expect(screen.getByText(/Included layers: #335/u)).toBeInTheDocument();
        await user.click(
            screen.getByRole("button", {
                name: "Rebuild PR dev",
            })
        );
        await waitFor(() => {
            expect(screen.getByText("PR #335 dev rebuild queued")).toBeInTheDocument();
        });
        expect(startCalls).toBe(1);
        expect(
            screen.queryByRole("button", {
                name: "Rebuild dev",
            })
        ).not.toBeInTheDocument();
        view.unmount();
        view.queryClient.clear();
    });
    it("keeps an active PR development stop control when GitHub listing fails", async () => {
        const user = userEvent.setup();
        let isPreviewRunning = true;
        Object.defineProperty(globalThis, "fetch", {
            configurable: true,
            value: jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
                return Promise.try(() => {
                    const url = requestUrl(input);
                    const method = init?.method ?? "GET";
                    if (method === "GET" && url === "/api/pull-requests") {
                        return Response.json(
                            {
                                error: {
                                    code: "service_unavailable",
                                    message: "GitHub listing unavailable",
                                    requestId: "github-listing-unavailable",
                                },
                            },
                            {
                                status: 503,
                            }
                        );
                    }
                    if (method === "GET" && url === "/api/pull-requests/preview") {
                        return Response.json({
                            preview: {
                                commitSha: "a".repeat(40),
                                number: 335,
                                status: isPreviewRunning ? "running" : "stopped",
                                title: "Active PR dev",
                                updatedAt: "2026-06-24T08:06:00.000Z",
                                url: "https://dashboard.test:5173",
                            },
                        });
                    }
                    if (
                        method === "POST" &&
                        url === "/api/pull-requests/335/preview/stop"
                    ) {
                        isPreviewRunning = false;
                        return Response.json({
                            isOk: true,
                            preview: {
                                commitSha: "a".repeat(40),
                                number: 335,
                                status: "stopped",
                                title: "Active PR dev",
                                updatedAt: "2026-06-24T08:07:00.000Z",
                            },
                        });
                    }
                    return apiResponse(url, method, init);
                });
            }),
            writable: true,
        });
        const view = renderPage(createElement(Delivery));
        await waitFor(() => {
            expect(screen.getByText("GitHub listing unavailable")).toBeInTheDocument();
            expect(screen.getByText(/PR #335: Active PR dev/)).toBeInTheDocument();
        });
        await user.click(
            screen.getByRole("button", {
                name: "Stop dev",
            })
        );
        await user.click(
            screen.getByRole("button", {
                name: "Stop PR dev",
            })
        );
        await waitFor(() => {
            expect(screen.getByText("PR #335 dev stopped")).toBeInTheDocument();
        });
        view.unmount();
        view.queryClient.clear();
    });
    it("shows when the Mira-authored pull request queue is clear", async () => {
        Object.defineProperty(globalThis, "fetch", {
            configurable: true,
            value: jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
                return Promise.try(() => {
                    const url = requestUrl(input);
                    if (url === "/api/pull-requests") {
                        return Response.json({
                            pullRequests: [
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
                    const method = init?.method ?? "GET";
                    return apiResponse(url, method, init);
                });
            }),
            writable: true,
        });
        const view = renderPage(createElement(Delivery));
        await waitFor(() => {
            expect(screen.getByText("No Mira-authored PRs waiting")).toBeInTheDocument();
            expect(screen.getByText("Bump dashboard dependency")).toBeInTheDocument();
        });
        expect(screen.getByText("Dependency / external PRs")).toBeInTheDocument();
        view.unmount();
        view.queryClient.clear();
    });
    it("explains when deploy actions are blocked by the production checkout", async () => {
        const originalFetch = fetch;
        let view: ReturnType<typeof renderPage> | undefined;
        try {
            Object.defineProperty(globalThis, "fetch", {
                configurable: true,
                value: jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
                    return Promise.try(() => {
                        const url = requestUrl(input);
                        if (url === "/api/pull-requests/production-checkout") {
                            return Response.json({
                                checkout: {
                                    root: "/srv/mira-dashboard/production/checkout",
                                    expectedRoot:
                                        "/srv/mira-dashboard/production/checkout",
                                    worktreeRoot:
                                        "/srv/mira-dashboard/development/worktrees",
                                    branch: "main",
                                    expectedBranch: "main",
                                    head: "abc123",
                                    headCommit: "abc123",
                                    isClean: false,
                                    isProductionRoot: true,
                                    isSafeForDeploy: false,
                                    statusShort: " M src/App.tsx",
                                },
                            });
                        }
                        const method = init?.method ?? "GET";
                        return apiResponse(url, method, init);
                    });
                }),
                writable: true,
            });
            view = renderPage(createElement(Delivery));
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
    it("labels post-restart deployment checks as verifying", async () => {
        Object.defineProperty(globalThis, "fetch", {
            configurable: true,
            value: jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
                return Promise.try(() => {
                    const url = requestUrl(input);
                    if (url === "/api/pull-requests/deployments") {
                        return Response.json({
                            deployments: [
                                {
                                    id: "deploy-verifying",
                                    commit: "abc123",
                                    commitTitle: "Verify deployment status",
                                    startedAt: "2026-06-24T08:00:00.000Z",
                                    status: "verifying",
                                    updatedAt: "2026-06-24T08:10:00.000Z",
                                    note: "Restarting services and verifying readiness",
                                },
                            ],
                        });
                    }
                    const method = init?.method ?? "GET";
                    return apiResponse(url, method, init);
                });
            }),
            writable: true,
        });
        const view = renderPage(createElement(Delivery));
        await waitFor(() => {
            expect(
                screen.getByText("Restarting services and verifying readiness")
            ).toBeInTheDocument();
            expect(screen.getByText("verifying")).toBeInTheDocument();
        });
        view.unmount();
        view.queryClient.clear();
    });
    it("summarizes pull request checks from the latest record per check", async () => {
        Object.defineProperty(globalThis, "fetch", {
            configurable: true,
            value: jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
                return Promise.try(() => {
                    const url = requestUrl(input);
                    if (url === "/api/pull-requests") {
                        return Response.json({
                            pullRequests: [
                                {
                                    number: 192,
                                    title: "Refresh stale check handling",
                                    url: "https://github.com/rajohan/Mira-Dashboard/pull/192",
                                    headRefName: "mira/stale-check-handling",
                                    baseRefName: "main",
                                    author: {
                                        login: "mira-2026",
                                    },
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
                });
            }),
            writable: true,
        });
        const view = renderPage(createElement(Delivery));
        await waitFor(() => {
            expect(screen.getByText("Refresh stale check handling")).toBeInTheDocument();
            expect(screen.getByText("Checks passed")).toBeInTheDocument();
        });
        expect(screen.queryByText("Checks failed")).not.toBeInTheDocument();
        view.unmount();
        view.queryClient.clear();
    });
});
