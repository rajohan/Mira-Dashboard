import { describe, expect, jest, test } from "bun:test";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import type {
    DeliveryDeploymentsResult,
    DeliveryPreviewResult,
    DeliveryProductionCheckoutResult,
    DeliveryPullRequestsResult,
    DeliveryReleasesResult,
    DeliveryRequestOperationResult,
} from "../../contracts/delivery.ts";
import { DashboardRealtimeProvider } from "../api/realtimeContext.tsx";
import { noOpDashboardRealtimeClient } from "../test/realtime.ts";
import type { DeliveryClient } from "./deliveryClient.ts";
import { DeliveryRoute } from "./DeliveryRoute.tsx";

const { render, screen, waitFor, within } = await import("@testing-library/react");
const userEventModule = await import("@testing-library/user-event");
const userEvent = userEventModule.default;

const observedAtMs = 1_800_000_000_000;
const headSha = "a".repeat(40);
const previousSha = "b".repeat(40);
const sourceRevision = "c".repeat(64);
const reviewerRevision = "d".repeat(64);
const previewRevision = "e".repeat(64);
const checkoutRevision = "f".repeat(64);
const activationRevision = "1".repeat(64);
const jobRunId = "019fdf70-0000-7000-8000-000000000040";

const pullRequestsResult = {
    checkedAtMs: observedAtMs + 1000,
    groups: [
        {
            id: "2".repeat(64),
            kind: "standalone-mira",
            members: [
                {
                    actions: [
                        {
                            action: "approve-review",
                            actor: "raymond",
                            available: true,
                            scope: "self",
                        },
                        {
                            action: "merge",
                            actor: "mira",
                            available: true,
                            scope: "prefix",
                        },
                        {
                            action: "preview-start",
                            actor: "mira",
                            available: true,
                            scope: "prefix",
                        },
                    ],
                    additions: 10,
                    author: "mira-2026",
                    baseRef: "main",
                    body: "Safe **Markdown**.\n\n![remote](https://example.test/image.png)",
                    changedFiles: 3,
                    checksState: "passed",
                    createdAtMs: observedAtMs - 5000,
                    deletions: 2,
                    headRef: "mira/delivery-parity",
                    headSha,
                    isCrossRepository: false,
                    isDraft: false,
                    mergeState: "CLEAN",
                    mergeability: "mergeable",
                    number: 424,
                    reviewState: "approved",
                    title: "Delivery parity",
                    updatedAtMs: observedAtMs,
                    url: "https://github.com/rajohan/Mira-Dashboard/pull/424",
                },
            ],
        },
    ],
    observedAtMs,
    reviewerCapability: {
        actor: "raymond",
        available: true,
        revision: reviewerRevision,
    },
    sourceRevision,
    state: "fresh",
} as const satisfies DeliveryPullRequestsResult;

const previewResult = {
    actionActive: false,
    checkedAtMs: observedAtMs + 1000,
    observedAtMs,
    preview: {
        controlsAvailable: true,
        headSha,
        number: 424,
        revision: previewRevision,
        startedAtMs: observedAtMs - 1000,
        status: "running",
        title: "Delivery parity",
        updatedAtMs: observedAtMs,
        url: "https://preview.example.test/",
    },
    sourceRevision,
    state: "fresh",
} as const satisfies DeliveryPreviewResult;

const checkoutResult = {
    checkedAtMs: observedAtMs + 1000,
    checkout: {
        branch: "main",
        condition: "ready",
        expectedBranch: "main",
        headSha,
        remoteHeadSha: headSha,
        revision: checkoutRevision,
        safeForDeploy: true,
        upstream: "origin/main",
    },
    observedAtMs,
    sourceRevision,
    state: "fresh",
} as const satisfies DeliveryProductionCheckoutResult;

const releasesResult = {
    actionActive: false,
    checkedAtMs: observedAtMs + 1000,
    observedAtMs,
    releases: {
        activationRevision,
        current: {
            builtAtMs: observedAtMs - 1000,
            commitTitle: "Current release",
            commitUrl: "https://github.com/rajohan/Mira-Dashboard/commit/" + headSha,
            releaseId: headSha,
            runtimeRevision: headSha,
            schemaTarget: 1,
        },
        previous: {
            builtAtMs: observedAtMs - 5000,
            commitTitle: "Previous release",
            commitUrl: "https://github.com/rajohan/Mira-Dashboard/commit/" + previousSha,
            releaseId: previousSha,
            runtimeRevision: previousSha,
            schemaTarget: 1,
        },
        rollback: {
            actor: "mira",
            available: true,
            target: {
                databaseSnapshotTransitionId: "019fdf70-0000-7000-8000-000000000001",
                releaseId: previousSha,
                runtimeRevision: previousSha,
            },
        },
    },
    sourceRevision,
    state: "fresh",
} as const satisfies DeliveryReleasesResult;

const deploymentsResult = {
    checkedAtMs: observedAtMs + 1000,
    deployments: [
        {
            commitSha: headSha,
            commitTitle: "Current release",
            commitUrl: "https://github.com/rajohan/Mira-Dashboard/commit/" + headSha,
            jobRunId,
            operation: "deploy",
            outcome: "completed",
            queuedAtMs: observedAtMs - 2000,
            state: "succeeded",
            updatedAtMs: observedAtMs,
        },
    ],
    state: "fresh",
} as const satisfies DeliveryDeploymentsResult;

const queuedResult = {
    jobRunId,
    operation: "stop-preview",
    queued: true,
} as const satisfies DeliveryRequestOperationResult;

interface DeliveryClientOverrides {
    readonly mutation?: DeliveryClient["mutation"];
    readonly preview?: DeliveryPreviewResult;
    readonly pullRequests?: DeliveryPullRequestsResult | Error;
    readonly releases?: DeliveryReleasesResult;
}

function createClient(overrides: DeliveryClientOverrides = {}) {
    const query = jest.fn((name: string) => {
        switch (name) {
            case "delivery.listPullRequests": {
                return overrides.pullRequests instanceof Error
                    ? Promise.reject(overrides.pullRequests)
                    : Promise.resolve(overrides.pullRequests ?? pullRequestsResult);
            }
            case "delivery.getPreview": {
                return Promise.resolve(overrides.preview ?? previewResult);
            }
            case "delivery.getProductionCheckout": {
                return Promise.resolve(checkoutResult);
            }
            case "delivery.getReleases": {
                return Promise.resolve(overrides.releases ?? releasesResult);
            }
            case "delivery.listDeployments": {
                return Promise.resolve(deploymentsResult);
            }
            default: {
                return Promise.reject(new Error("Unexpected Delivery query"));
            }
        }
    }) as unknown as DeliveryClient["query"];
    const mutation = overrides.mutation ?? jest.fn(() => Promise.resolve(queuedResult));
    return { client: { mutation, query } satisfies DeliveryClient, mutation, query };
}

function renderDelivery(client: DeliveryClient) {
    const queryClient = new QueryClient({
        defaultOptions: {
            mutations: { retry: false },
            queries: { refetchOnWindowFocus: false, retry: false },
        },
    });
    const view = render(
        <DashboardRealtimeProvider client={noOpDashboardRealtimeClient}>
            <QueryClientProvider client={queryClient}>
                <DeliveryRoute client={client} />
            </QueryClientProvider>
        </DashboardRealtimeProvider>
    );
    return {
        unmount() {
            view.unmount();
            queryClient.clear();
        },
    };
}

describe("DeliveryRoute", () => {
    test("disables direct preview and production controls while another Delivery action is active", async () => {
        const harness = createClient({
            preview: { ...previewResult, actionActive: true },
            releases: { ...releasesResult, actionActive: true },
        });
        const view = renderDelivery(harness.client);
        try {
            expect(
                await screen.findByRole("button", { name: "Stop preview" })
            ).toBeDisabled();
            expect(
                screen.getByRole("button", { name: "Deploy latest main" })
            ).toBeDisabled();
            expect(
                screen.getByRole("button", { name: "Run / rebuild preview" })
            ).toBeDisabled();
            expect(
                screen.getAllByText("Another Delivery action is active.").length
            ).toBeGreaterThanOrEqual(2);
        } finally {
            view.unmount();
        }
    });

    test("keeps global preview stop available when pull request listing fails", async () => {
        const harness = createClient({ pullRequests: new Error("provider secret") });
        const view = renderDelivery(harness.client);
        try {
            expect(
                await screen.findByRole("heading", { name: "Pull requests unavailable" })
            ).toBeVisible();
            const user = userEvent.setup();
            await user.click(screen.getByRole("button", { name: "Stop preview" }));
            expect(
                screen.getByRole("dialog", { name: "Stop pull request preview?" })
            ).toBeVisible();
            await user.click(screen.getByRole("button", { name: "Queue preview stop" }));
            expect(
                await screen.findByRole("heading", {
                    name: "Delivery operation queued",
                })
            ).toBeVisible();
            expect(harness.mutation).toHaveBeenCalledWith(
                "delivery.stopPreview",
                expect.objectContaining({
                    idempotencyKey: expect.stringMatching(/^[0-9a-f]{32}$/u),
                    number: 424,
                    operation: "stop-preview",
                    previewRevision,
                }),
                expect.objectContaining({ signal: expect.any(AbortSignal) })
            );
            expect(
                screen
                    .getAllByRole("link", { name: "View job" })
                    .some(
                        (link) => link.getAttribute("href") === "/jobs?runId=" + jobRunId
                    )
            ).toBeTrue();
        } finally {
            view.unmount();
        }
    });

    test("renders all five regions and exact Mira/Raymond confirmation boundaries", async () => {
        const harness = createClient();
        const view = renderDelivery(harness.client);
        try {
            expect(
                await screen.findByRole("heading", { level: 1, name: "Delivery" })
            ).toBeVisible();
            for (const name of [
                "Pull request preview",
                "Pull requests",
                "Production checkout",
                "Production releases",
                "Recent Delivery jobs",
            ]) {
                expect(screen.getByRole("heading", { level: 2, name })).toBeVisible();
            }
            expect(screen.getAllByText("Current release").length).toBeGreaterThan(0);
            expect(screen.getByText("Previous release")).toBeVisible();
            expect(screen.getByText("Checks passed")).toBeVisible();
            expect(screen.getByText("Image: remote")).toBeVisible();

            const user = userEvent.setup();
            await user.click(screen.getByRole("button", { name: "Approve review" }));
            expect(
                screen.getByText(/Raymond \(rajohan\).*does not merge or deploy/iu)
            ).toBeVisible();
            await user.click(screen.getByRole("button", { name: "Cancel" }));

            await user.click(screen.getByRole("button", { name: "Merge" }));
            expect(screen.getByText(/Mira \(mira-2026\).*squash-merge/iu)).toBeVisible();
        } finally {
            view.unmount();
        }
    });

    test("marks server LKG and browser-retained reads while disabling mutations", async () => {
        let failRefresh = false;
        const query = jest.fn((name: string) => {
            if (name === "delivery.listPullRequests") {
                return failRefresh
                    ? Promise.reject(new Error("upstream path /secret"))
                    : Promise.resolve(pullRequestsResult);
            }
            if (name === "delivery.getPreview") {
                return Promise.resolve({
                    ...previewResult,
                    staleSinceMs: observedAtMs + 500,
                    state: "last-known-good",
                });
            }
            if (name === "delivery.getProductionCheckout") {
                return Promise.resolve(checkoutResult);
            }
            if (name === "delivery.getReleases") return Promise.resolve(releasesResult);
            return Promise.resolve(deploymentsResult);
        }) as unknown as DeliveryClient["query"];
        const harness = createClient();
        const view = renderDelivery({ ...harness.client, query });
        try {
            expect(await screen.findByText("Server last-known-good")).toBeVisible();
            const pullRequestHeading = screen.getByRole("heading", {
                level: 2,
                name: "Pull requests",
            });
            const region = pullRequestHeading.closest("section");
            expect(region).not.toBeNull();
            failRefresh = true;
            await userEvent
                .setup()
                .click(within(region!).getByRole("button", { name: "Refresh" }));
            await waitFor(() => {
                expect(within(region!).getByText("Browser-retained")).toBeVisible();
            });
            expect(within(region!).getByRole("button", { name: "Merge" })).toBeDisabled();
            expect(region?.textContent).not.toContain("/secret");
        } finally {
            view.unmount();
        }
    });

    test("renders authoritative head-guard limitations as disabled controls", async () => {
        const baseGroup = pullRequestsResult.groups[0];
        const basePullRequest = baseGroup.members[0];
        const harness = createClient({
            pullRequests: {
                ...pullRequestsResult,
                groups: [
                    {
                        ...baseGroup,
                        members: [
                            {
                                ...basePullRequest,
                                actions: [
                                    {
                                        action: "reject",
                                        actor: "mira",
                                        available: false,
                                        reason: "head-guard-unavailable",
                                        scope: "self",
                                    },
                                ],
                            },
                        ],
                    },
                ],
            },
        });
        const view = renderDelivery(harness.client);
        try {
            expect(await screen.findByRole("button", { name: "Reject" })).toBeDisabled();
            expect(
                screen.getByText(
                    "GitHub cannot atomically bind this action to the reviewed pull request head or stack heads."
                )
            ).toBeVisible();
            expect(harness.mutation).not.toHaveBeenCalled();
        } finally {
            view.unmount();
        }
    });
});
