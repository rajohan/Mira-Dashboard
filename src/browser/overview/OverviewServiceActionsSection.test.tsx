import { afterEach, describe, expect, test } from "bun:test";

import { QueryClientProvider } from "@tanstack/react-query";
import {
    createMemoryHistory,
    createRootRoute,
    createRoute,
    createRouter,
    RouterProvider,
} from "@tanstack/react-router";
import { act } from "react";

import type { AuthStatus } from "../../contracts/auth.ts";
import type { RealtimeStreamOutput } from "../../contracts/events.ts";
import type { JobRunSummary } from "../../contracts/jobModel.ts";
import { jobRealtimeTopics } from "../../contracts/jobRealtime.ts";
import type {
    GetServiceActionsStatusResult,
    RequestServiceActionResult,
} from "../../contracts/serviceActions.ts";
import { createDashboardQueryClient } from "../api/queryClient.ts";
import { DashboardRealtimeProvider } from "../api/realtimeContext.tsx";
import {
    createDashboardTrpcClient,
    type DashboardTrpcTransport,
} from "../api/trpcClient.ts";
import { DashboardTrpcProvider } from "../api/trpcContext.tsx";
import { authStatusQueryKey } from "../auth/authQueries.ts";
import { jobRealtimeRefreshDelayMs } from "../jobs/useJobRealtimeInvalidation.ts";
import { ControlledDashboardRealtimeClient } from "../test/realtime.ts";
import { OverviewServiceActionsSection } from "./OverviewServiceActionsSection.tsx";

const { render, screen, waitFor } = await import("@testing-library/react");
const userEventModule = await import("@testing-library/user-event");
const userEvent = userEventModule.default;

const timestampMs = 1_800_000_000_000;
const authenticatedStatus = Object.freeze({
    session: {
        authenticatedAtMs: timestampMs,
        authMethod: "password",
        createdAtMs: timestampMs,
        expiresAtMs: timestampMs + 86_400_000,
        id: "a".repeat(32),
        isCurrent: true,
        lastSeenAtMs: timestampMs,
        userAgent: "Service actions browser test",
    },
    state: "authenticated",
    user: {
        id: "019fd974-54a2-74dd-a64b-d4186f8d8828",
        email: "operator@example.com",
        username: "operator",
    },
} satisfies AuthStatus);

const queuedRun = Object.freeze({
    actionKey: "openclaw.sessions.cleanup",
    attemptCount: 0,
    attemptLimit: 1,
    availableAtMs: timestampMs,
    cancellationPolicy: "never",
    displayName: "OpenClaw session cleanup",
    eventCount: 1,
    id: "019fe000-0000-7000-8000-000000000001",
    priority: 0,
    queuedAtMs: timestampMs,
    resourceClass: "exclusive",
    resourceKeys: ["host.mutation"],
    retrySafe: false,
    state: "queued",
    stateVersion: 1,
    timeoutMs: 600_000,
    triggerType: "manual",
    updatedAtMs: timestampMs,
} satisfies JobRunSummary);

const runningRun = Object.freeze({
    ...queuedRun,
    actionKey: "host.system.restart",
    attemptCount: 1,
    displayName: "System restart",
    eventCount: 2,
    firstStartedAtMs: timestampMs + 100,
    id: "019fe000-0000-7000-8000-000000000002",
    lastAttemptStartedAtMs: timestampMs + 100,
    state: "running",
    stateVersion: 2,
    updatedAtMs: timestampMs + 100,
} satisfies JobRunSummary);

const succeededRun = Object.freeze({
    ...queuedRun,
    actionKey: "host.system.update",
    attemptCount: 1,
    displayName: "System update",
    eventCount: 3,
    finishedAtMs: timestampMs + 1000,
    firstStartedAtMs: timestampMs + 100,
    id: "019fe000-0000-7000-8000-000000000003",
    lastAttemptStartedAtMs: timestampMs + 100,
    state: "succeeded",
    stateVersion: 3,
    updatedAtMs: timestampMs + 1000,
} satisfies JobRunSummary);

const actionStatus = Object.freeze({
    actions: [
        {
            availability: "available",
            id: "dashboard-restart",
        },
        {
            availability: "available",
            id: "dashboard-stack-restart",
        },
        {
            availability: "available",
            id: "openclaw-cleanup",
        },
        {
            availability: "available",
            id: "openclaw-restart",
        },
        {
            availability: "unavailable",
            id: "openclaw-update",
        },
        {
            availability: "available",
            id: "system-cleanup",
        },
        {
            activeRun: runningRun,
            availability: "available",
            id: "system-restart",
        },
        {
            availability: "available",
            id: "system-update",
            latestRun: succeededRun,
        },
        {
            availability: "available",
            id: "worker-restart",
        },
    ],
    observedAtMs: timestampMs + 2000,
} satisfies GetServiceActionsStatusResult);

const allAvailableStatus = Object.freeze({
    actions: actionStatus.actions.map((action) => ({
        availability: "available" as const,
        id: action.id,
    })),
    observedAtMs: timestampMs + 3000,
} satisfies GetServiceActionsStatusResult);

const unavailableActiveCleanupStatus = Object.freeze({
    actions: allAvailableStatus.actions.map((action) =>
        action.id === "openclaw-cleanup"
            ? {
                  ...action,
                  activeRun: queuedRun,
                  availability: "unavailable" as const,
              }
            : action
    ),
    observedAtMs: timestampMs + 4000,
} satisfies GetServiceActionsStatusResult);

const queuedResult = Object.freeze({
    actionId: "openclaw-cleanup",
    jobRunId: queuedRun.id,
    queued: true,
} satisfies RequestServiceActionResult);

interface TransportCall {
    readonly input: unknown;
    readonly path: string;
    readonly signal: AbortSignal | undefined;
}

type QueryOutput =
    | Error
    | GetServiceActionsStatusResult
    | Promise<GetServiceActionsStatusResult>;
type MutationOutput = Error | RequestServiceActionResult;

function outputAt(outputs: readonly unknown[], index: number): Promise<unknown> {
    const output = outputs[Math.min(index, outputs.length - 1)];
    if (output === undefined) return Promise.reject(new TypeError("Missing output"));
    return output instanceof Error ? Promise.reject(output) : Promise.resolve(output);
}

class ServiceActionsTransport implements DashboardTrpcTransport {
    readonly mutationCalls: TransportCall[] = [];
    readonly queryCalls: TransportCall[] = [];
    readonly #mutationOutputs: readonly MutationOutput[];
    readonly #queryOutputs: readonly QueryOutput[];

    constructor(
        queryOutputs: readonly QueryOutput[],
        mutationOutputs: readonly MutationOutput[] = []
    ) {
        this.#queryOutputs = queryOutputs;
        this.#mutationOutputs = mutationOutputs;
    }

    mutation(
        path: string,
        input?: unknown,
        options?: { readonly signal?: AbortSignal }
    ): Promise<unknown> {
        const index = this.mutationCalls.length;
        this.mutationCalls.push({ input, path, signal: options?.signal });
        if (path !== "serviceActions.request") {
            return Promise.reject(new TypeError(`Unexpected mutation: ${path}`));
        }
        return outputAt(this.#mutationOutputs, index);
    }

    query(
        path: string,
        input?: unknown,
        options?: { readonly signal?: AbortSignal }
    ): Promise<unknown> {
        const index = this.queryCalls.length;
        this.queryCalls.push({ input, path, signal: options?.signal });
        if (path !== "serviceActions.getStatus") {
            return Promise.reject(new TypeError(`Unexpected query: ${path}`));
        }
        return outputAt(this.#queryOutputs, index);
    }
}

interface SectionHarness {
    readonly queryClient: ReturnType<typeof createDashboardQueryClient>;
    readonly realtimeClient: ControlledDashboardRealtimeClient;
    readonly transport: ServiceActionsTransport;
    readonly view: ReturnType<typeof render>;
}

const harnesses: SectionHarness[] = [];

afterEach(() => {
    for (const { queryClient, view } of harnesses.splice(0)) {
        view.unmount();
        queryClient.clear();
    }
    globalThis.sessionStorage.clear();
});

function renderSection(
    queryOutputs: readonly QueryOutput[],
    mutationOutputs: readonly MutationOutput[] = []
): SectionHarness {
    const queryClient = createDashboardQueryClient();
    queryClient.setDefaultOptions({
        ...queryClient.getDefaultOptions(),
        queries: {
            ...queryClient.getDefaultOptions().queries,
            retry: false,
        },
    });
    queryClient.setQueryData(authStatusQueryKey, authenticatedStatus);
    const transport = new ServiceActionsTransport(queryOutputs, mutationOutputs);
    const trpcClient = createDashboardTrpcClient(transport);
    const realtimeClient = new ControlledDashboardRealtimeClient();
    const rootRoute = createRootRoute();
    const overviewRoute = createRoute({
        component: OverviewServiceActionsSection,
        getParentRoute: () => rootRoute,
        path: "/",
    });
    const jobsRoute = createRoute({
        component: () => null,
        getParentRoute: () => rootRoute,
        path: "/jobs",
    });
    const router = createRouter({
        history: createMemoryHistory({ initialEntries: ["/"] }),
        routeTree: rootRoute.addChildren([overviewRoute, jobsRoute]),
    });
    const view = render(
        <QueryClientProvider client={queryClient}>
            <DashboardRealtimeProvider client={realtimeClient}>
                <DashboardTrpcProvider client={trpcClient}>
                    <RouterProvider router={router} />
                </DashboardTrpcProvider>
            </DashboardRealtimeProvider>
        </QueryClientProvider>
    );
    const harness = { queryClient, realtimeClient, transport, view };
    harnesses.push(harness);
    return harness;
}

async function emitJobRunChange(
    realtimeClient: ControlledDashboardRealtimeClient
): Promise<void> {
    const output: RealtimeStreamOutput = {
        data: {
            event: {
                entityId: runningRun.id,
                entityType: "job-run",
                occurredAtMs: timestampMs + 200,
                operation: "updated",
                payload: { id: runningRun.id },
                topic: jobRealtimeTopics.runs,
            },
            kind: "change",
        },
        id: "42",
    };
    await act(async () => {
        realtimeClient.emit(output);
        await new Promise((resolve) =>
            setTimeout(resolve, jobRealtimeRefreshDelayMs + 20)
        );
    });
}

function operationOutcomeUnknownError(): Error {
    return Object.assign(new Error("private lost acknowledgement"), {
        data: {
            code: "SERVICE_UNAVAILABLE",
            reason: "operation_outcome_unknown",
        },
    });
}

describe("OverviewServiceActionsSection", () => {
    test("renders loading, exact fixed inventory, unavailable, active, and latest states", async () => {
        const pending = Promise.withResolvers<GetServiceActionsStatusResult>();
        const harness = renderSection([pending.promise]);

        expect(await screen.findByLabelText("Loading service actions…")).toBeTruthy();
        pending.resolve(actionStatus);
        expect(
            await screen.findByRole("heading", { level: 2, name: "Service actions" })
        ).toBeTruthy();
        expect(harness.transport.queryCalls[0]?.input).toEqual({});
        const dashboardRestart = screen.getByRole("heading", {
            name: "Dashboard restart",
        });
        const combinedRestart = screen.getByRole("heading", {
            name: "Dashboard + worker restart",
        });
        const systemCleanup = screen.getByRole("heading", { name: "System cleanup" });
        const openClawCleanup = screen.getByRole("heading", {
            name: "OpenClaw cleanup",
        });
        expect(
            dashboardRestart.compareDocumentPosition(combinedRestart) &
                Node.DOCUMENT_POSITION_FOLLOWING
        ).toBeTruthy();
        expect(
            combinedRestart.compareDocumentPosition(systemCleanup) &
                Node.DOCUMENT_POSITION_FOLLOWING
        ).toBeTruthy();
        expect(
            systemCleanup.compareDocumentPosition(openClawCleanup) &
                Node.DOCUMENT_POSITION_FOLLOWING
        ).toBeTruthy();
        expect(screen.getByRole("heading", { name: "OpenClaw cleanup" })).toBeTruthy();
        expect(screen.getByRole("heading", { name: "OpenClaw restart" })).toBeTruthy();
        expect(screen.getByRole("heading", { name: "OpenClaw update" })).toBeTruthy();
        expect(screen.getByRole("heading", { name: "System cleanup" })).toBeTruthy();
        expect(screen.getByRole("heading", { name: "System restart" })).toBeTruthy();
        expect(screen.getByRole("heading", { name: "System update" })).toBeTruthy();
        expect(screen.queryByText(/terminal|command to run/iu)).toBeNull();
        expect(
            screen.getByRole("button", { name: "Queue OpenClaw update" })
        ).toBeDisabled();
        expect(
            screen.getByRole("button", { name: "Queue system restart" })
        ).toBeDisabled();
        expect(
            screen.getByText("No fresh worker currently advertises this fixed operation.")
        ).toBeTruthy();
        expect(screen.getByText("Active job")).toBeTruthy();
        expect(screen.getByText("succeeded")).toBeTruthy();
        expect(screen.getByText(succeededRun.id, { exact: false })).toBeTruthy();
        expect(
            screen.getByRole("link", {
                name: `Open Dashboard job ${runningRun.id}`,
            })
        ).toHaveAttribute("href", `/jobs?runId=${runningRun.id}`);
        expect(
            screen.getByRole("link", {
                name: `Open Dashboard job ${succeededRun.id}`,
            })
        ).toHaveAttribute("href", `/jobs?runId=${succeededRun.id}`);
    });

    test("clears an active action after a same-tab job-run event", async () => {
        const harness = renderSection([actionStatus, allAvailableStatus]);

        expect(await screen.findByText("Active job")).toBeTruthy();
        expect(
            screen.getByRole("button", { name: "Queue system restart" })
        ).toBeDisabled();
        expect(harness.realtimeClient.input?.topics).toEqual([jobRealtimeTopics.runs]);

        const callCountBeforeRealtimeChange = harness.transport.queryCalls.length;
        await emitJobRunChange(harness.realtimeClient);

        await waitFor(() =>
            expect(
                screen.getByRole("button", { name: "Queue system restart" })
            ).toBeEnabled()
        );
        expect(harness.transport.queryCalls.length).toBeGreaterThan(
            callCountBeforeRealtimeChange
        );
    });

    test("recovers initial errors and retains validated status after a refresh failure", async () => {
        const failure = new TypeError("private service-actions provider detail");
        const harness = renderSection([failure, actionStatus, failure]);

        expect(
            await screen.findByRole("heading", {
                level: 2,
                name: "Service actions unavailable",
            })
        ).toBeTruthy();
        expect(screen.queryByText(failure.message)).toBeNull();
        await userEvent.setup().click(screen.getByRole("button", { name: "Try again" }));
        expect(
            await screen.findByRole("heading", { level: 2, name: "Service actions" })
        ).toBeTruthy();

        await harness.queryClient.refetchQueries({
            exact: true,
            queryKey: ["service-actions", "status"],
            type: "active",
        });
        expect(
            await screen.findByText(
                /The request could not be completed\. Try again\. Status observed:/u
            )
        ).toBeTruthy();
        expect(screen.getByText(/Status observed:/u)).toBeTruthy();
        expect(screen.getByRole("heading", { name: "OpenClaw cleanup" })).toBeTruthy();
        expect(screen.queryByText(failure.message)).toBeNull();
    });

    test("presents action-specific interruption, duration, and cleanup warnings", async () => {
        renderSection([allAvailableStatus]);
        const user = userEvent.setup();
        await screen.findByRole("heading", { name: "Service actions" });

        await user.click(screen.getByRole("button", { name: "Queue system restart" }));
        expect(
            screen.getByText(/interrupts Dashboard, OpenClaw, and other host services/iu)
        ).toBeTruthy();
        expect(
            screen.getByText(
                /accepted for durable processing, not that the host restarted/iu
            )
        ).toBeTruthy();
        await user.click(screen.getByRole("button", { name: "Cancel" }));

        await user.click(screen.getByRole("button", { name: "Queue system update" }));
        expect(screen.getByText(/System updates can take a long time/iu)).toBeTruthy();
        await user.click(screen.getByRole("button", { name: "Cancel" }));

        await user.click(screen.getByRole("button", { name: "Queue system cleanup" }));
        const cleanupDialog = screen.getByRole("dialog", {
            name: "Queue a system cleanup?",
        });
        expect(cleanupDialog).toHaveTextContent(
            /unused Docker content older than seven days/iu
        );
        expect(cleanupDialog).toHaveTextContent(/Docker volumes are never deleted/iu);
        await user.click(screen.getByRole("button", { name: "Cancel" }));

        await user.click(screen.getByRole("button", { name: "Queue OpenClaw update" }));
        expect(screen.getByText(/OpenClaw updates can take time/iu)).toBeTruthy();
        await user.click(screen.getByRole("button", { name: "Cancel" }));

        await user.click(screen.getByRole("button", { name: "Queue OpenClaw restart" }));
        expect(screen.getByText(/interrupts active Gateway sessions/iu)).toBeTruthy();
        expect(screen.getByText(/durable result/iu)).toBeTruthy();
        expect(
            screen.getByText(/does not confirm that the restart completed/iu)
        ).toBeTruthy();
        await user.click(screen.getByRole("button", { name: "Cancel" }));

        await user.click(screen.getByRole("button", { name: "Queue OpenClaw cleanup" }));
        expect(
            screen.getByText(/OpenClaw's own bounded session and artifact maintenance/iu)
        ).toBeTruthy();
    });

    test("retains one recovery key after unknown outcome and reuses it after remount", async () => {
        const first = renderSection(
            [allAvailableStatus],
            [operationOutcomeUnknownError()]
        );
        const user = userEvent.setup();
        await screen.findByRole("heading", { name: "Service actions" });
        await user.click(screen.getByRole("button", { name: "Queue OpenClaw cleanup" }));
        expect(
            screen.getByText(/OpenClaw's own bounded session and artifact maintenance/iu)
        ).toBeTruthy();
        await user.click(screen.getByRole("button", { name: "Queue cleanup" }));
        const unknownOutcomeMessages = await screen.findAllByText(
            /could not confirm whether the service action request was queued/iu
        );
        expect(unknownOutcomeMessages.length).toBeGreaterThan(0);
        expect(first.transport.mutationCalls).toHaveLength(1);
        const firstInput = first.transport.mutationCalls[0]?.input as {
            readonly idempotencyKey: string;
        };
        expect(firstInput.idempotencyKey).toMatch(/^[0-9a-f]{32}$/u);
        expect(globalThis.sessionStorage.length).toBe(1);

        first.view.unmount();
        first.queryClient.clear();
        const firstIndex = harnesses.indexOf(first);
        if (firstIndex !== -1) harnesses.splice(firstIndex, 1);
        const second = renderSection(
            [unavailableActiveCleanupStatus, unavailableActiveCleanupStatus],
            [queuedResult]
        );
        const recoveryButton = await screen.findByRole("button", {
            name: "Retry OpenClaw cleanup request",
        });
        expect(recoveryButton).toBeEnabled();
        await user.click(
            screen.getByRole("button", { name: "Retry OpenClaw cleanup request" })
        );
        expect(
            screen.getByText(/retry uses the retained request identity/iu)
        ).toBeTruthy();
        await user.click(screen.getByRole("button", { name: "Retry request" }));

        expect(
            await screen.findByText(
                `${"OpenClaw cleanup"} request queued. Dashboard job run: ${queuedRun.id}.`
            )
        ).toBeTruthy();
        const secondInput = second.transport.mutationCalls[0]?.input as {
            readonly idempotencyKey: string;
        };
        expect(secondInput.idempotencyKey).toBe(firstInput.idempotencyKey);
        expect(globalThis.sessionStorage.length).toBe(0);
        await waitFor(() =>
            expect(second.transport.queryCalls.length).toBeGreaterThan(1)
        );
    });

    test.each([
        ["step_up_required", "Verify your identity again before continuing."],
        [
            "mfa_enrollment_required",
            "Multi-factor authentication must be enrolled before this action.",
        ],
    ] as const)("renders fixed recent-MFA feedback for %s", async (reason, message) => {
        const rawFailure = Object.assign(new Error("private authorization detail"), {
            data: { code: "UNAUTHORIZED", reason },
        });
        const harness = renderSection([allAvailableStatus], [rawFailure]);
        const user = userEvent.setup();
        await screen.findByRole("heading", { name: "Service actions" });
        await user.click(screen.getByRole("button", { name: "Queue system update" }));
        await user.click(screen.getByRole("button", { name: "Queue update" }));
        const authorizationMessages = await screen.findAllByText(message);
        expect(authorizationMessages.length).toBeGreaterThan(0);
        expect(screen.queryByText(rawFailure.message)).toBeNull();
        expect(harness.transport.mutationCalls).toHaveLength(1);
        expect(globalThis.sessionStorage.length).toBe(1);
    });

    test("fails closed before transport when a retained key is invalid", async () => {
        globalThis.sessionStorage.setItem(
            `mira-dashboard.service-actions.request.v1:authenticated:${authenticatedStatus.user.id}:${authenticatedStatus.session.id}:openclaw-cleanup`,
            "invalid!"
        );
        const harness = renderSection([allAvailableStatus], [queuedResult]);
        const user = userEvent.setup();
        await screen.findByRole("heading", { name: "Service actions" });
        await user.click(
            screen.getByRole("button", {
                name: "Retry OpenClaw cleanup request",
            })
        );
        await user.click(screen.getByRole("button", { name: "Retry request" }));
        const recoveryMessages = await screen.findAllByText(
            /could not persist a safe recovery key.*was not submitted/iu
        );
        expect(recoveryMessages.length).toBeGreaterThan(0);
        expect(harness.transport.mutationCalls).toHaveLength(0);
    });
});
