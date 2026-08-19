import type { Meta, StoryObj } from "@storybook/tanstack-react";
import { expect, userEvent, waitFor, within } from "storybook/test";

import type {
    DeliveryDeploymentsResult,
    DeliveryPreviewResult,
    DeliveryProductionCheckoutResult,
    DeliveryPullRequest,
    DeliveryPullRequestsResult,
    DeliveryReleasesResult,
    DeliveryRequestOperationResult,
} from "../../../contracts/delivery.ts";
import {
    DashboardPageStory,
    type DashboardPageStoryQuerySeed,
} from "../../storySupport/dashboardPageStoryHarness.tsx";
import {
    dashboardStoryFailure,
    dashboardStoryResolver,
    dashboardStoryValue,
    type DashboardStoryFixtureValue,
    type DashboardStoryFixtures,
} from "../../storySupport/dashboardStoryTransport.ts";
import {
    deliveryCheckoutQueryKey,
    deliveryPreviewQueryKey,
    deliveryPullRequestsQueryKey,
    deliveryReleasesQueryKey,
} from "../deliveryQueries.ts";

const observedAtMs = 1_800_000_000_000;
const headSha = "a".repeat(40);
const previousSha = "b".repeat(40);
const sourceRevision = "c".repeat(64);
const reviewerRevision = "d".repeat(64);
const previewRevision = "e".repeat(64);
const checkoutRevision = "f".repeat(64);
const activationRevision = "1".repeat(64);
const jobRunId = "019fdf70-0000-7000-8000-000000000040";
const headGuardUnavailableReason =
    "GitHub cannot atomically bind this action to the reviewed pull request head or stack heads.";

const nativeStackActions: DeliveryPullRequest["actions"] = [
    {
        action: "approve-review",
        actor: "raymond",
        available: false,
        reason: "already-approved",
        scope: "self",
    },
    {
        action: "merge",
        actor: "mira",
        available: false,
        reason: "head-guard-unavailable",
        scope: "prefix",
    },
    {
        action: "merge-and-deploy",
        actor: "mira",
        available: false,
        reason: "head-guard-unavailable",
        scope: "prefix",
    },
    {
        action: "preview-start",
        actor: "mira",
        available: true,
        scope: "prefix",
    },
    {
        action: "reject",
        actor: "mira",
        available: false,
        reason: "head-guard-unavailable",
        scope: "self",
    },
    {
        action: "update-branch",
        actor: "mira",
        available: false,
        reason: "ambiguous-chain",
        scope: "self",
    },
];

const ordinaryActions: DeliveryPullRequest["actions"] = [
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
        action: "merge-and-deploy",
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
    {
        action: "reject",
        actor: "mira",
        available: false,
        reason: "head-guard-unavailable",
        scope: "self",
    },
    {
        action: "update-branch",
        actor: "mira",
        available: true,
        scope: "self",
    },
];

function pullRequest(input: {
    readonly actions: DeliveryPullRequest["actions"];
    readonly baseRef: string;
    readonly headRef: string;
    readonly headSha: string;
    readonly mergeState: string;
    readonly number: number;
    readonly reviewState: DeliveryPullRequest["reviewState"];
    readonly title: string;
}): DeliveryPullRequest {
    return {
        actions: input.actions,
        additions: 10,
        author: "mira-2026",
        baseRef: input.baseRef,
        body: "Safe **Markdown**.\n\n![remote](https://example.test/image.png)",
        changedFiles: 3,
        checksState: "passed",
        createdAtMs: observedAtMs - 5000,
        deletions: 2,
        headRef: input.headRef,
        headSha: input.headSha,
        isCrossRepository: false,
        isDraft: false,
        mergeState: input.mergeState,
        mergeability: "mergeable",
        number: input.number,
        reviewState: input.reviewState,
        title: input.title,
        updatedAtMs: observedAtMs,
        url: `https://github.com/rajohan/Mira-Dashboard/pull/${input.number}`,
    };
}

const pullRequestsResult = {
    checkedAtMs: observedAtMs + 1000,
    groups: [
        {
            id: "1".repeat(64),
            kind: "native-stack",
            stackNumber: 90,
            members: [
                pullRequest({
                    actions: nativeStackActions,
                    baseRef: "main",
                    headRef: "mira/stack-base",
                    headSha: "2".repeat(40),
                    mergeState: "CLEAN",
                    number: 422,
                    reviewState: "approved",
                    title: "Stack base",
                }),
                pullRequest({
                    actions: nativeStackActions,
                    baseRef: "mira/stack-base",
                    headRef: "mira/stack-top",
                    headSha: "3".repeat(40),
                    mergeState: "CLEAN",
                    number: 423,
                    reviewState: "approved",
                    title: "Stack top",
                }),
            ],
        },
        {
            id: "2".repeat(64),
            kind: "standalone-mira",
            members: [
                pullRequest({
                    actions: ordinaryActions,
                    baseRef: "main",
                    headRef: "mira/delivery-parity",
                    headSha,
                    mergeState: "BEHIND",
                    number: 424,
                    reviewState: "required",
                    title: "Delivery parity",
                }),
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

const stoppedPreviewResult = {
    ...previewResult,
    preview: {
        controlsAvailable: true,
        revision: previewRevision,
        status: "stopped",
        updatedAtMs: observedAtMs,
    },
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

const loadedDeliveryQuerySeeds = Object.freeze([
    { key: deliveryPullRequestsQueryKey, updatedAtMs: 1, value: pullRequestsResult },
    { key: deliveryPreviewQueryKey, updatedAtMs: 1, value: previewResult },
    { key: deliveryCheckoutQueryKey, updatedAtMs: 1, value: checkoutResult },
    { key: deliveryReleasesQueryKey, updatedAtMs: 1, value: releasesResult },
] satisfies readonly DashboardPageStoryQuerySeed[]);

const queuedResult = {
    jobRunId,
    operation: "merge-pull-request",
    queued: true,
} as const satisfies DeliveryRequestOperationResult;

const notifications = {
    notifications: [],
    readCount: 0,
    unreadCount: 0,
} as const;

interface DeliveryFixtureOptions {
    readonly checkout?: DashboardStoryFixtureValue;
    readonly deployments?: DashboardStoryFixtureValue;
    readonly mutation?: DashboardStoryFixtureValue;
    readonly preview?: DashboardStoryFixtureValue;
    readonly pullRequests?: DashboardStoryFixtureValue;
    readonly releases?: DashboardStoryFixtureValue;
}

function deliveryFixtures(options: DeliveryFixtureOptions = {}): DashboardStoryFixtures {
    return {
        mutations: {
            "delivery.approvePullRequest":
                options.mutation ?? dashboardStoryValue(queuedResult),
        },
        queries: {
            "delivery.getPreview": options.preview ?? dashboardStoryValue(previewResult),
            "delivery.getProductionCheckout":
                options.checkout ?? dashboardStoryValue(checkoutResult),
            "delivery.getReleases":
                options.releases ?? dashboardStoryValue(releasesResult),
            "delivery.listDeployments":
                options.deployments ?? dashboardStoryValue(deploymentsResult),
            "delivery.listPullRequests":
                options.pullRequests ?? dashboardStoryValue(pullRequestsResult),
            "notifications.list": dashboardStoryValue(notifications),
        },
    };
}

const pending = dashboardStoryResolver(
    () =>
        new Promise<never>(() => {
            // Intentionally pending to render the independent read loading states.
        })
);

const operationOutcomeUnknown = Object.assign(new TypeError("Private provider detail"), {
    data: {
        code: "INTERNAL_SERVER_ERROR",
        reason: "operation_outcome_unknown",
    },
});

async function openMergeDialog(canvasElement: HTMLElement) {
    const pullRequestRegion = await loadedPullRequestRegion(canvasElement);
    const mergeButtons = pullRequestRegion.getAllByRole("button", {
        name: "Merge only",
    });
    const mergeButton = mergeButtons.at(-1);
    if (mergeButton === undefined) throw new TypeError("Merge story control is missing");
    await userEvent.click(mergeButton);
    return within(canvasElement.ownerDocument.body);
}

async function loadedDeliveryRegion(canvasElement: HTMLElement, name: string) {
    const canvas = within(canvasElement);
    const region = await canvas.findByRole("region", { name }, { timeout: 5000 });
    return within(region);
}

async function loadedPullRequestRegion(canvasElement: HTMLElement) {
    const [pullRequestRegion] = await Promise.all([
        loadedDeliveryRegion(canvasElement, "Pull requests"),
        loadedDeliveryRegion(canvasElement, "Pull request preview"),
        loadedDeliveryRegion(canvasElement, "Production releases"),
    ]);
    await pullRequestRegion.findByRole("link", {
        name: /Delivery parity/iu,
    });
    return pullRequestRegion;
}

const meta = {
    component: DashboardPageStory,
    parameters: { layout: "fullscreen" },
    render: (args, context) => <DashboardPageStory {...args} key={context.id} />,
} satisfies Meta<typeof DashboardPageStory>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Loading: Story = {
    args: {
        fixtures: deliveryFixtures({
            checkout: pending,
            deployments: pending,
            preview: pending,
            pullRequests: pending,
            releases: pending,
        }),
        route: "/delivery",
    },
};

export const PullRequests: Story = {
    args: {
        fixtures: deliveryFixtures(),
        querySeeds: loadedDeliveryQuerySeeds,
        route: "/delivery",
    },
    play: async ({ canvasElement }) => {
        const pullRequestRegion = await loadedPullRequestRegion(canvasElement);
        for (const action of [
            /^Merge(?: stack through #\d+| only)$/u,
            /^Merge(?: through #\d+)? \+ Deploy$/u,
        ]) {
            const buttons = pullRequestRegion.getAllByRole("button", { name: action });
            await expect(buttons).toHaveLength(3);
            await expect(buttons[0]).toBeEnabled();
            for (const button of buttons.slice(1)) {
                await expect(button).toBeDisabled();
                await expect(button).toHaveAccessibleDescription(
                    headGuardUnavailableReason
                );
            }
        }

        const rejectButtons = pullRequestRegion.getAllByRole("button", {
            name: "Reject",
        });
        await expect(rejectButtons).toHaveLength(1);
        for (const button of rejectButtons) {
            await expect(button).toBeDisabled();
            await expect(button).toHaveAccessibleDescription(headGuardUnavailableReason);
        }

        for (const action of ["Approve PR", "Update branch"]) {
            const buttons = pullRequestRegion.getAllByRole("button", {
                name: action,
            });
            const ordinaryButton = buttons.at(-1);
            if (ordinaryButton === undefined) {
                throw new TypeError(`Ordinary pull request action is missing: ${action}`);
            }
            await expect(ordinaryButton).toBeEnabled();
        }
        await expect(
            pullRequestRegion.getAllByRole("button", { name: "Run preview" })
        ).toHaveLength(2);
        await expect(
            pullRequestRegion.queryByRole("button", { name: "Rebuild preview" })
        ).toBeNull();
    },
};

export const Empty: Story = {
    args: {
        fixtures: deliveryFixtures({
            deployments: dashboardStoryValue({
                ...deploymentsResult,
                deployments: [],
            } satisfies DeliveryDeploymentsResult),
            preview: dashboardStoryValue(stoppedPreviewResult),
            pullRequests: dashboardStoryValue({
                ...pullRequestsResult,
                groups: [],
            } satisfies DeliveryPullRequestsResult),
        }),
        route: "/delivery",
    },
};

export const LastKnownGood: Story = {
    args: {
        fixtures: deliveryFixtures({
            checkout: dashboardStoryValue({
                ...checkoutResult,
                staleSinceMs: observedAtMs + 500,
                state: "last-known-good",
            } satisfies DeliveryProductionCheckoutResult),
            preview: dashboardStoryValue({
                ...previewResult,
                staleSinceMs: observedAtMs + 500,
                state: "last-known-good",
            } satisfies DeliveryPreviewResult),
            pullRequests: dashboardStoryValue({
                ...pullRequestsResult,
                staleSinceMs: observedAtMs + 500,
                state: "last-known-good",
            } satisfies DeliveryPullRequestsResult),
            releases: dashboardStoryValue({
                ...releasesResult,
                staleSinceMs: observedAtMs + 500,
                state: "last-known-good",
            } satisfies DeliveryReleasesResult),
        }),
        route: "/delivery",
    },
};

export const BrowserRetained: Story = {
    args: {
        fixtures: deliveryFixtures({
            pullRequests: dashboardStoryResolver(() =>
                Promise.reject(new TypeError("Safe retained refresh failure"))
            ),
        }),
        querySeeds: loadedDeliveryQuerySeeds,
        route: "/delivery",
    },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        await canvas.findByRole("link", { name: /Delivery parity/iu }, { timeout: 5000 });
        await expect(
            await canvas.findByText(
                "The latest Delivery refresh did not complete. Retained data is shown for pull requests. Consequential controls require fresh data."
            )
        ).toBeVisible();
    },
};

export const PartialUnavailable: Story = {
    args: {
        fixtures: deliveryFixtures({
            releases: dashboardStoryValue({
                checkedAtMs: observedAtMs,
                state: "unavailable",
            } satisfies DeliveryReleasesResult),
        }),
        route: "/delivery",
    },
};

export const PreviewRunning: Story = {
    args: { fixtures: deliveryFixtures(), route: "/delivery" },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        const slot = await canvas.findByRole("region", {
            name: "Pull request preview",
        });
        await expect(await within(slot).findByText("Running")).toBeVisible();
        await expect(
            await within(slot).findByRole("link", { name: /Open dev/iu })
        ).toBeVisible();
    },
};

export const PreviewContention: Story = {
    args: {
        fixtures: deliveryFixtures({
            preview: dashboardStoryValue({
                ...previewResult,
                preview: {
                    ...previewResult.preview,
                    headSha: "9".repeat(40),
                    number: 999,
                    title: "Another pull request",
                },
            } satisfies DeliveryPreviewResult),
            pullRequests: dashboardStoryValue({
                ...pullRequestsResult,
                groups: pullRequestsResult.groups.map((group) => ({
                    ...group,
                    members: group.members.map((member) => ({
                        ...member,
                        actions: member.actions.map((action) =>
                            action.action === "preview-start"
                                ? {
                                      ...action,
                                      available: false,
                                      reason: "preview-owned-by-other",
                                  }
                                : action
                        ),
                    })),
                })),
            } satisfies DeliveryPullRequestsResult),
        }),
        route: "/delivery",
    },
};

export const ActionActive: Story = {
    args: {
        fixtures: deliveryFixtures({
            preview: dashboardStoryValue({
                ...previewResult,
                actionActive: true,
            } satisfies DeliveryPreviewResult),
            releases: dashboardStoryValue({
                ...releasesResult,
                actionActive: true,
            } satisfies DeliveryReleasesResult),
        }),
        route: "/delivery",
    },
};

export const Confirmation: Story = {
    args: {
        fixtures: deliveryFixtures(),
        querySeeds: loadedDeliveryQuerySeeds,
        route: "/delivery",
    },
    play: async ({ canvasElement }) => {
        const page = await openMergeDialog(canvasElement);
        await expect(
            await page.findByRole("dialog", { name: "Merge pull request?" })
        ).toBeVisible();
        await waitFor(async () => {
            await expect(
                page.getByText(/Mira \(mira-2026\).*squash-merge/iu)
            ).toBeVisible();
        });
    },
};

export const Queued: Story = {
    args: {
        fixtures: deliveryFixtures(),
        querySeeds: loadedDeliveryQuerySeeds,
        route: "/delivery",
    },
    play: async ({ canvasElement }) => {
        const page = await openMergeDialog(canvasElement);
        await userEvent.click(await page.findByRole("button", { name: "Queue merge" }));
        const canvas = within(canvasElement);
        await expect(
            await canvas.findByRole("heading", { name: "Delivery operation queued" })
        ).toBeVisible();
        const queuedCard = canvas
            .getByRole("heading", { name: "Delivery operation queued" })
            .closest("section");
        if (queuedCard === null) throw new TypeError("Queued result card is missing");
        await expect(
            within(queuedCard).getByRole("link", { name: "View job" })
        ).toHaveAttribute("href", `/jobs?runId=${jobRunId}`);
    },
};

export const UnknownOutcome: Story = {
    args: {
        fixtures: deliveryFixtures({
            mutation: dashboardStoryFailure(operationOutcomeUnknown),
        }),
        querySeeds: loadedDeliveryQuerySeeds,
        route: "/delivery",
    },
    play: async ({ canvasElement }) => {
        const page = await openMergeDialog(canvasElement);
        await userEvent.click(await page.findByRole("button", { name: "Queue merge" }));
        await waitFor(async () => {
            await expect(
                page.getByText(/queue outcome could not be confirmed/iu)
            ).toBeVisible();
        });
    },
};

export const Error: Story = {
    args: {
        fixtures: deliveryFixtures({
            mutation: dashboardStoryFailure(
                new TypeError("Safe Delivery operation failure")
            ),
        }),
        querySeeds: loadedDeliveryQuerySeeds,
        route: "/delivery",
    },
    play: async ({ canvasElement }) => {
        const page = await openMergeDialog(canvasElement);
        await userEvent.click(await page.findByRole("button", { name: "Queue merge" }));
        await waitFor(
            async () => {
                await expect(
                    page.getByText(
                        "The Delivery request could not be completed safely. Try again from fresh state."
                    )
                ).toBeVisible();
            },
            { timeout: 5000 }
        );
    },
};

export const RollbackBlocked: Story = {
    args: {
        fixtures: deliveryFixtures({
            releases: dashboardStoryValue({
                ...releasesResult,
                releases: {
                    ...releasesResult.releases,
                    rollback: {
                        actor: "mira",
                        available: false,
                        reason: "incompatible",
                    },
                },
            } satisfies DeliveryReleasesResult),
        }),
        route: "/delivery",
    },
};
