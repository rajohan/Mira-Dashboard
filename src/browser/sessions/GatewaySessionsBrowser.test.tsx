import { describe, expect, jest, test } from "bun:test";

import { QueryClientProvider } from "@tanstack/react-query";

import type {
    GatewaySession,
    GatewaySessionActionResult,
    ListGatewaySessionsResult,
} from "../../contracts/gatewaySessions.ts";
import {
    deriveGatewaySessionStats,
    gatewayPrimarySessionKey,
} from "../../contracts/gatewaySessions.ts";
import { createDashboardQueryClient } from "../api/queryClient.ts";
import type { DashboardTrpcClient } from "../api/trpcClient.ts";
import { DashboardTrpcProvider } from "../api/trpcContext.tsx";
import { dashboardUnavailableReadRetryMaximum } from "../api/trpcError.ts";
import { authStatusQueryKey } from "../auth/authQueries.ts";
import { gatewaySessionQueryKey } from "./gatewaySessionQueries.ts";
import { GatewaySessionsBrowser } from "./GatewaySessionsBrowser.tsx";

const { act, render, screen, waitFor, within } = await import("@testing-library/react");
const userEventModule = await import("@testing-library/user-event");
const userEvent = userEventModule.default;

const timestampMs = 1_800_000_000_000;
const primarySession: GatewaySession = {
    displayName: "Primary main",
    hasActiveRun: true,
    key: gatewayPrimarySessionKey,
    kind: "main",
    model: "gpt-5.6-sol",
    modelProvider: "openai",
    sessionId: "primary-session-generation",
    totalTokens: 12_000,
    totalTokensFresh: true,
    updatedAtMs: timestampMs,
};
const snapshot: ListGatewaySessionsResult = {
    filter: "ALL",
    projectionTruncated: false,
    sessions: [primarySession],
    source: {
        checkedAtMs: timestampMs,
        connection: "connected",
        freshness: "fresh",
        observedAtMs: timestampMs,
    },
    stats: deriveGatewaySessionStats([primarySession], timestampMs),
};

function renderBrowser(client: DashboardTrpcClient) {
    const queryClient = createDashboardQueryClient();
    const rendered = render(
        <QueryClientProvider client={queryClient}>
            <DashboardTrpcProvider client={client}>
                <GatewaySessionsBrowser />
            </DashboardTrpcProvider>
        </QueryClientProvider>
    );
    return { ...rendered, queryClient };
}

function deferred<T>() {
    let resolveDeferred!: (value: T) => void;
    const promise = new Promise<T>((resolve) => {
        resolveDeferred = resolve;
    });
    return { promise, resolve: resolveDeferred };
}

interface SessionActionUser {
    readonly click: (element: Element) => Promise<void>;
}

async function requestPrimaryReset(user: SessionActionUser): Promise<HTMLButtonElement> {
    const mobileSessions = await screen.findByRole("list", {
        name: "Current OpenClaw sessions",
    });
    const trigger = within(mobileSessions).getByRole("button", {
        name: `Actions for Primary main; key ${gatewayPrimarySessionKey}`,
    });
    if (!(trigger instanceof HTMLButtonElement)) {
        throw new TypeError("Session action trigger is not a button");
    }
    await user.click(trigger);
    await user.click(
        await screen.findByRole("menuitem", {
            name: /Reset session/u,
        })
    );
    return trigger;
}

async function exhaustUnavailableReadRetries(
    queryClient: ReturnType<typeof createDashboardQueryClient>
): Promise<void> {
    for (let cycle = 0; cycle < dashboardUnavailableReadRetryMaximum + 2; cycle += 1) {
        await act(async () => {
            await Promise.resolve();
            jest.runOnlyPendingTimers();
            await Promise.resolve();
            await Promise.resolve();
        });
        const state = queryClient.getQueryState(gatewaySessionQueryKey);
        if (state?.fetchStatus === "idle" && state.error !== null) {
            await act(async () => {
                jest.advanceTimersByTime(0);
                await Promise.resolve();
            });
            return;
        }
    }
    throw new Error("Unavailable read retries did not settle");
}

describe("Gateway sessions browser", () => {
    test("shows a safe initial unavailable state without raw transport details", async () => {
        jest.useFakeTimers();
        let available = false;
        const query = jest.fn(() =>
            available
                ? Promise.resolve(snapshot)
                : Promise.reject(
                      Object.assign(new Error("private gateway diagnostic"), {
                          data: { code: "SERVICE_UNAVAILABLE" },
                      })
                  )
        );
        const client = {
            query,
        } as unknown as DashboardTrpcClient;
        const rendered = renderBrowser(client);
        const user = userEvent.setup();

        try {
            await exhaustUnavailableReadRetries(rendered.queryClient);
            jest.useRealTimers();
            expect(
                await screen.findByRole("heading", {
                    name: "OpenClaw sessions unavailable",
                })
            ).toBeTruthy();
            expect(screen.getByRole("alert")).toHaveTextContent(
                "The Dashboard is temporarily unavailable"
            );
            expect(screen.queryByText(/private gateway diagnostic/u)).toBeNull();
            expect(
                screen.queryByRole("table", { name: "Current OpenClaw sessions" })
            ).toBeNull();
            expect(screen.queryByRole("button", { name: "Refresh" })).toBeNull();

            available = true;
            await user.click(screen.getByRole("button", { name: "Try again" }));
            expect(
                await screen.findByRole("table", {
                    name: "Current OpenClaw sessions",
                })
            ).toBeTruthy();
            expect(screen.queryByRole("button", { name: "Refresh" })).toBeNull();
        } finally {
            rendered.queryClient.clear();
            jest.useRealTimers();
        }
    });

    test("keeps cached rows and marks a failed background refresh separately", async () => {
        jest.useFakeTimers();
        const client = {
            query: () =>
                Promise.reject(
                    Object.assign(new Error("private background detail"), {
                        data: { code: "SERVICE_UNAVAILABLE" },
                    })
                ),
        } as unknown as DashboardTrpcClient;
        const queryClient = createDashboardQueryClient();
        queryClient.setQueryData(gatewaySessionQueryKey, snapshot, { updatedAt: 1 });
        render(
            <QueryClientProvider client={queryClient}>
                <DashboardTrpcProvider client={client}>
                    <GatewaySessionsBrowser />
                </DashboardTrpcProvider>
            </QueryClientProvider>
        );

        try {
            expect(
                screen.getByRole("table", { name: "Current OpenClaw sessions" })
            ).toBeTruthy();
            await exhaustUnavailableReadRetries(queryClient);
            jest.useRealTimers();
            await waitFor(() =>
                expect(
                    screen.getByText(
                        "A background refresh failed. Showing the most recent session data."
                    )
                ).toBeVisible()
            );
            expect(
                within(
                    screen.getByRole("table", {
                        name: "Current OpenClaw sessions",
                    })
                ).getByText("Primary main")
            ).toBeTruthy();
            expect(screen.queryByText(/private background detail/u)).toBeNull();
        } finally {
            queryClient.clear();
            jest.useRealTimers();
        }
    });

    test("sends the exact confirmed control and installs its returned snapshot", async () => {
        const calls: Array<{ input: unknown; name: string }> = [];
        const mutation = jest.fn((name: string, input: unknown) => {
            calls.push({ input, name });
            const result: GatewaySessionActionResult = {
                action: "reset",
                key: gatewayPrimarySessionKey,
                outcome: "changed",
                refresh: { snapshot, status: "available" },
            };
            return Promise.resolve(result);
        });
        const client = {
            mutation,
            query: () => Promise.resolve(snapshot),
        } as unknown as DashboardTrpcClient;
        const rendered = renderBrowser(client);
        const user = userEvent.setup();

        try {
            const trigger = await requestPrimaryReset(user);
            const dialog = screen.getByRole("dialog", { name: "Reset session?" });
            expect(dialog).toHaveTextContent(
                `Exact session key: ${gatewayPrimarySessionKey}`
            );
            await user.click(
                within(dialog).getByRole("button", { name: "Reset session" })
            );

            await waitFor(() => expect(mutation).toHaveBeenCalledTimes(1));
            expect(calls).toEqual([
                {
                    input: { key: gatewayPrimarySessionKey },
                    name: "gatewaySessions.reset",
                },
            ]);
            expect(await screen.findByText("Session reset.")).toBeTruthy();
            expect(screen.queryByRole("dialog", { name: "Reset session?" })).toBeNull();
            await waitFor(() => expect(document.activeElement === trigger).toBeTrue());
            expect(mutation).toHaveBeenCalledTimes(1);
            expect(rendered.queryClient.getQueryData(gatewaySessionQueryKey)).toEqual(
                snapshot
            );
        } finally {
            rendered.queryClient.clear();
        }
    });

    test("distinguishes an unknown control outcome and requires refresh before retry", async () => {
        const reconciledSession: GatewaySession = {
            ...primarySession,
            displayName: "Primary main after reconciliation",
            updatedAtMs: timestampMs + 1,
        };
        const reconciledSnapshot: ListGatewaySessionsResult = {
            ...snapshot,
            sessions: [reconciledSession],
            source: {
                ...snapshot.source,
                checkedAtMs: timestampMs + 1,
                observedAtMs: timestampMs + 1,
            },
            stats: deriveGatewaySessionStats([reconciledSession], timestampMs + 1),
        };
        let queryCallCount = 0;
        const query = jest.fn(() => {
            queryCallCount += 1;
            if (queryCallCount === 1) return Promise.resolve(snapshot);
            if (queryCallCount === 2) {
                return Promise.reject(new Error("private reconciliation failure"));
            }
            return Promise.resolve(reconciledSnapshot);
        });
        const mutation = jest.fn(() =>
            Promise.reject(
                Object.assign(new Error("private lost acknowledgement"), {
                    data: {
                        code: "SERVICE_UNAVAILABLE",
                        reason: "operation_outcome_unknown",
                    },
                })
            )
        );
        const client = {
            mutation,
            query,
        } as unknown as DashboardTrpcClient;
        const rendered = renderBrowser(client);
        const user = userEvent.setup();

        try {
            const sessionsTable = await screen.findByRole("table", {
                name: "Current OpenClaw sessions",
            });
            await requestPrimaryReset(user);
            await user.click(
                within(screen.getByRole("dialog", { name: "Reset session?" })).getByRole(
                    "button",
                    { name: "Reset session" }
                )
            );

            expect(
                await screen.findByText(
                    "We could not confirm whether that action finished. Refresh the session list before trying again."
                )
            ).toBeTruthy();
            await waitFor(() => expect(query).toHaveBeenCalledTimes(2));
            expect(within(sessionsTable).getByText("Primary main")).toBeTruthy();
            expect(screen.queryByText(/private reconciliation failure/u)).toBeNull();
            const unresolvedDialog = screen.getByRole("dialog", {
                name: "Reset session?",
            });
            expect(
                within(unresolvedDialog).getByText(
                    "We could not confirm whether the action finished, and the session list could not be refreshed. Try refreshing again before another action."
                )
            ).toBeTruthy();
            expect(
                within(unresolvedDialog).getByRole("button", {
                    name: "Reset session",
                })
            ).toBeDisabled();
            expect(mutation).toHaveBeenCalledTimes(1);

            expect(
                within(unresolvedDialog).getByRole("button", {
                    name: "Try refresh again",
                })
            ).toBeTruthy();
            await user.click(
                within(unresolvedDialog).getByRole("button", { name: "Cancel" })
            );
            await waitFor(() =>
                expect(
                    screen.queryByRole("dialog", { name: "Reset session?" })
                ).toBeNull()
            );
            await user.click(
                within(screen.getByRole("region", { name: "Session metrics" })).getByRole(
                    "button",
                    { name: "Try refresh again" }
                )
            );

            expect(
                await within(sessionsTable).findByText(
                    "Primary main after reconciliation"
                )
            ).toBeTruthy();
            await waitFor(() =>
                expect(
                    screen.queryByRole("dialog", { name: "Reset session?" })
                ).toBeNull()
            );
            expect(
                screen.getByText(
                    "Session list refreshed. Review the session before choosing another action."
                )
            ).toBeTruthy();
            expect(
                screen.queryByText(
                    "We could not confirm whether that action finished. Refresh the session list before trying again."
                )
            ).toBeNull();
            expect(mutation).toHaveBeenCalledTimes(1);
            expect(screen.queryByText(/private lost acknowledgement/u)).toBeNull();
        } finally {
            rendered.queryClient.clear();
        }
    });

    test("blocks duplicate dispatch while an unknown outcome is reconciling", async () => {
        const reconciliation = deferred<ListGatewaySessionsResult>();
        const reconciledSnapshot: ListGatewaySessionsResult = {
            ...snapshot,
            source: {
                ...snapshot.source,
                checkedAtMs: timestampMs + 1,
                observedAtMs: timestampMs + 1,
            },
        };
        let queryCallCount = 0;
        const query = jest.fn(() => {
            queryCallCount += 1;
            return queryCallCount === 1
                ? Promise.resolve(snapshot)
                : reconciliation.promise;
        });
        const mutation = jest.fn(() =>
            Promise.reject(
                Object.assign(new Error("private lost acknowledgement"), {
                    data: {
                        code: "SERVICE_UNAVAILABLE",
                        reason: "operation_outcome_unknown",
                    },
                })
            )
        );
        const rendered = renderBrowser({ mutation, query });
        const user = userEvent.setup();

        try {
            await requestPrimaryReset(user);
            const dialog = screen.getByRole("dialog", { name: "Reset session?" });
            const confirm = within(dialog).getByRole("button", {
                name: "Reset session",
            });
            confirm.click();

            await waitFor(() => expect(query).toHaveBeenCalledTimes(2));
            expect(confirm).toBeDisabled();
            confirm.click();
            expect(mutation).toHaveBeenCalledTimes(1);

            await act(async () => {
                reconciliation.resolve(reconciledSnapshot);
                await reconciliation.promise;
            });
            await waitFor(() =>
                expect(
                    screen.queryByRole("dialog", { name: "Reset session?" })
                ).toBeNull()
            );
            expect(mutation).toHaveBeenCalledTimes(1);
            expect(screen.queryByText(/private lost acknowledgement/u)).toBeNull();
        } finally {
            rendered.queryClient.clear();
        }
    });

    test("keeps controls blocked when unknown-outcome reconciliation returns stale LKG", async () => {
        const staleSnapshot: ListGatewaySessionsResult = {
            ...snapshot,
            source: {
                checkedAtMs: timestampMs + 1,
                connection: "disconnected",
                freshness: "stale",
                observedAtMs: timestampMs,
            },
        };
        const authoritativeSnapshot: ListGatewaySessionsResult = {
            ...snapshot,
            source: {
                ...snapshot.source,
                checkedAtMs: timestampMs + 1,
                observedAtMs: timestampMs + 1,
            },
        };
        const query = jest
            .fn()
            .mockResolvedValueOnce(snapshot)
            .mockResolvedValueOnce(staleSnapshot)
            .mockResolvedValueOnce(authoritativeSnapshot);
        const mutation = jest.fn(() =>
            Promise.reject(
                Object.assign(new Error("private lost acknowledgement"), {
                    data: {
                        code: "SERVICE_UNAVAILABLE",
                        reason: "operation_outcome_unknown",
                    },
                })
            )
        );
        const rendered = renderBrowser({ mutation, query });
        const user = userEvent.setup();

        try {
            await requestPrimaryReset(user);
            await user.click(
                within(screen.getByRole("dialog", { name: "Reset session?" })).getByRole(
                    "button",
                    { name: "Reset session" }
                )
            );

            await waitFor(() => expect(query).toHaveBeenCalledTimes(2));
            const blockedDialog = screen.getByRole("dialog", {
                name: "Reset session?",
            });
            expect(
                within(blockedDialog).getByRole("button", {
                    name: "Reset session",
                })
            ).toBeDisabled();
            expect(
                within(blockedDialog).getByText(
                    "We could not confirm whether the action finished, and the session list could not be refreshed. Try refreshing again before another action."
                )
            ).toBeTruthy();
            expect(mutation).toHaveBeenCalledTimes(1);

            await user.click(
                within(blockedDialog).getByRole("button", {
                    name: "Try refresh again",
                })
            );

            await waitFor(() => expect(query).toHaveBeenCalledTimes(3));
            await waitFor(() =>
                expect(
                    screen.queryByRole("dialog", { name: "Reset session?" })
                ).toBeNull()
            );
            expect(mutation).toHaveBeenCalledTimes(1);
        } finally {
            rendered.queryClient.clear();
        }
    });

    test("requires a fresh observation newer than the mutation boundary", async () => {
        const sameObservationSnapshot: ListGatewaySessionsResult = {
            ...snapshot,
            sessions: [{ ...primarySession, displayName: "Unchanged observation" }],
        };
        const postMutationSnapshot: ListGatewaySessionsResult = {
            ...snapshot,
            sessions: [{ ...primarySession, displayName: "Observed after mutation" }],
            source: {
                ...snapshot.source,
                checkedAtMs: timestampMs + 1,
                observedAtMs: timestampMs + 1,
            },
        };
        const query = jest
            .fn()
            .mockResolvedValueOnce(snapshot)
            .mockResolvedValueOnce(sameObservationSnapshot)
            .mockResolvedValueOnce(postMutationSnapshot);
        const mutation = jest.fn(() =>
            Promise.reject(
                Object.assign(new Error("private lost acknowledgement"), {
                    data: {
                        code: "SERVICE_UNAVAILABLE",
                        reason: "operation_outcome_unknown",
                    },
                })
            )
        );
        const rendered = renderBrowser({ mutation, query });
        const user = userEvent.setup();

        try {
            const sessionsTable = await screen.findByRole("table", {
                name: "Current OpenClaw sessions",
            });
            await requestPrimaryReset(user);
            await user.click(
                within(screen.getByRole("dialog", { name: "Reset session?" })).getByRole(
                    "button",
                    { name: "Reset session" }
                )
            );

            await waitFor(() => expect(query).toHaveBeenCalledTimes(2));
            const blockedDialog = screen.getByRole("dialog", {
                name: "Reset session?",
            });
            expect(
                within(blockedDialog).getByRole("button", {
                    name: "Reset session",
                })
            ).toBeDisabled();
            expect(within(sessionsTable).getByText("Unchanged observation")).toBeTruthy();

            await user.click(
                within(blockedDialog).getByRole("button", {
                    name: "Try refresh again",
                })
            );

            expect(
                await within(sessionsTable).findByText("Observed after mutation")
            ).toBeTruthy();
            await waitFor(() =>
                expect(
                    screen.queryByRole("dialog", { name: "Reset session?" })
                ).toBeNull()
            );
            expect(mutation).toHaveBeenCalledTimes(1);
        } finally {
            rendered.queryClient.clear();
        }
    });

    test("does not reconcile into an auth owner changed after the shared refresh settles", async () => {
        const postMutationSnapshot: ListGatewaySessionsResult = {
            ...snapshot,
            source: {
                ...snapshot.source,
                checkedAtMs: timestampMs + 1,
                observedAtMs: timestampMs + 1,
            },
        };
        const mutation = jest.fn(() =>
            Promise.reject(
                Object.assign(new Error("private lost acknowledgement"), {
                    data: {
                        code: "SERVICE_UNAVAILABLE",
                        reason: "operation_outcome_unknown",
                    },
                })
            )
        );
        const client = {
            mutation,
            query: () => Promise.resolve(snapshot),
        } as unknown as DashboardTrpcClient;
        const rendered = renderBrowser(client);
        const reconciliation = Promise.withResolvers<void>();
        const refetch = jest
            .spyOn(rendered.queryClient, "refetchQueries")
            .mockImplementation(() => reconciliation.promise);
        const user = userEvent.setup();
        rendered.queryClient.setQueryData(authStatusQueryKey, {
            state: "bootstrap-required",
        });

        try {
            await requestPrimaryReset(user);
            await user.click(
                within(screen.getByRole("dialog", { name: "Reset session?" })).getByRole(
                    "button",
                    { name: "Reset session" }
                )
            );

            await waitFor(() => expect(refetch).toHaveBeenCalledTimes(1));
            rendered.queryClient.setQueryData(
                gatewaySessionQueryKey,
                postMutationSnapshot
            );
            const changeOwnerAfterInternalCheck = reconciliation.promise.then(() => {
                rendered.queryClient.setQueryData(authStatusQueryKey, {
                    state: "anonymous",
                });
                return null;
            });
            reconciliation.resolve();
            await changeOwnerAfterInternalCheck;

            const blockedDialog = await screen.findByRole("dialog", {
                name: "Reset session?",
            });
            expect(
                await within(blockedDialog).findByText(
                    /session list could not be refreshed/u
                )
            ).toBeVisible();
            expect(
                within(blockedDialog).getByRole("button", {
                    name: "Reset session",
                })
            ).toBeDisabled();
            expect(mutation).toHaveBeenCalledTimes(1);
        } finally {
            reconciliation.resolve();
            refetch.mockRestore();
            rendered.queryClient.clear();
        }
    });

    test("rejects a tampered unknown-outcome reason instead of trusting server copy", async () => {
        const client = {
            mutation: () =>
                Promise.reject(
                    Object.assign(
                        new Error(
                            "Outcome could not be confirmed; refresh before retry."
                        ),
                        {
                            data: {
                                code: "SERVICE_UNAVAILABLE",
                                reason: "operation_outcome_unknown_tampered",
                            },
                        }
                    )
                ),
            query: () => Promise.resolve(snapshot),
        } as unknown as DashboardTrpcClient;
        const rendered = renderBrowser(client);
        const user = userEvent.setup();

        try {
            await requestPrimaryReset(user);
            await user.click(
                within(screen.getByRole("dialog", { name: "Reset session?" })).getByRole(
                    "button",
                    { name: "Reset session" }
                )
            );

            expect(
                await screen.findByText("The request could not be completed. Try again.")
            ).toBeTruthy();
            expect(
                screen.queryByText(
                    "Outcome could not be confirmed; refresh before retry."
                )
            ).toBeNull();
        } finally {
            rendered.queryClient.clear();
        }
    });

    test("labels truncated names and omitted upstream metadata explicitly", async () => {
        const incompleteSession: GatewaySession = {
            ...primarySession,
            displayName: `${"A".repeat(255)}…`,
            displayNameTruncated: true,
            model: undefined,
            modelProvider: undefined,
            omittedMetadataFields: ["channel", "model", "modelProvider"],
        };
        const incompleteSnapshot: ListGatewaySessionsResult = {
            ...snapshot,
            sessions: [incompleteSession],
            stats: deriveGatewaySessionStats([incompleteSession], timestampMs),
        };
        const client = {
            query: () => Promise.resolve(incompleteSnapshot),
        } as unknown as DashboardTrpcClient;
        const rendered = renderBrowser(client);

        try {
            const mobileSessions = await screen.findByRole("list", {
                name: "Current OpenClaw sessions",
            });
            const mobileSession = within(mobileSessions).getByRole("listitem", {
                name: `${incompleteSession.displayName} session`,
            });
            expect(within(mobileSession).getByText("Truncated")).toBeTruthy();
            expect(within(mobileSession).getByText(incompleteSession.key)).toBeTruthy();
            expect(
                screen.getByText(
                    "Some details were not shown: channel, model, modelProvider"
                )
            ).toBeTruthy();
            expect(
                within(
                    screen.getByRole("table", {
                        name: "Current OpenClaw sessions",
                    })
                ).getAllByText("Unknown").length
            ).toBeGreaterThan(0);
        } finally {
            rendered.queryClient.clear();
        }
    });
});
