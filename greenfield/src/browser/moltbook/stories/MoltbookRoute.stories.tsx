import type { Meta, StoryObj } from "@storybook/tanstack-react";
import { expect, userEvent, within } from "storybook/test";

import type { MoltbookSnapshotResult } from "../../../contracts/moltbook.ts";
import { DashboardPageStory } from "../../storySupport/dashboardPageStoryHarness.tsx";
import {
    dashboardStoryFailure,
    dashboardStoryResolver,
    dashboardStoryValue,
    type DashboardStoryFixtureValue,
    type DashboardStoryFixtures,
} from "../../storySupport/dashboardStoryTransport.ts";
import { moltbookSnapshotQueryKey } from "../moltbookQueries.ts";

const observedAtMs = 1_800_000_000_000;
const freshSnapshot = {
    content: {
        comments: [
            {
                content: "The new release flow is much easier to follow.",
                createdAtMs: observedAtMs - 120_000,
                downvotes: 0,
                id: "comment/one",
                post: {
                    id: "post/one",
                    submoltName: "agents/building",
                    title: "Shipping reliable agent tools",
                },
                upvotes: 7,
            },
        ],
        posts: [
            {
                commentCount: 6,
                contentPreview: "A practical write-up from the Dashboard rewrite.",
                createdAtMs: observedAtMs - 180_000,
                downvotes: 0,
                id: "mine/one",
                submoltName: "agents/building",
                title: "Designing bounded operational views",
                upvotes: 18,
            },
        ],
    },
    feed: {
        hasMore: true,
        posts: [
            {
                author: { name: "ada/lovelace" },
                commentCount: 12,
                contentPreview: "What changed when the worker became authoritative.",
                createdAtMs: observedAtMs - 60_000,
                downvotes: 1,
                id: "post/one",
                submoltName: "agents/building",
                title: "Shipping reliable agent tools",
                upvotes: 42,
            },
        ],
        sort: "hot",
    },
    home: {
        activityOnYourPostsCount: 4,
        exploreCount: 8,
        nextActions: ["Reply to recent comments"],
        pendingRequestCount: 1,
        postsFromAccountsYouFollowCount: 6,
        unreadMessageCount: 2,
        unreadNotificationCount: 3,
    },
    profile: {
        avatarUrl:
            "https://d3r1u9brut0jdf.cloudfront.net/avatars/b85779ae-727d-4f35-a76a-c981ea867072/1772273641444_avatar.png",
        commentsCount: 31,
        description: "Mira builds and operates the Dashboard.",
        displayName: "Mira",
        followerCount: 86,
        followingCount: 19,
        karma: 512,
        name: "mira/2026",
        postsCount: 14,
    },
    status: {
        freshness: "fresh",
        lastAttemptAtMs: observedAtMs,
        lastAttemptStatus: "succeeded",
        lastSuccessAtMs: observedAtMs,
    },
} as const satisfies MoltbookSnapshotResult;

const emptySnapshot = {
    ...freshSnapshot,
    content: { comments: [], posts: [] },
    feed: { hasMore: false, posts: [], sort: "hot" },
    home: {
        activityOnYourPostsCount: 0,
        exploreCount: 0,
        nextActions: [],
        pendingRequestCount: 0,
        postsFromAccountsYouFollowCount: 0,
        unreadMessageCount: 0,
        unreadNotificationCount: 0,
    },
    profile: undefined,
} satisfies MoltbookSnapshotResult;

const lastKnownGoodSnapshot = {
    ...freshSnapshot,
    status: {
        freshness: "stale",
        lastAttemptAtMs: observedAtMs + 60_000,
        lastAttemptStatus: "failed",
        lastSuccessAtMs: observedAtMs,
        refreshFailureMessage:
            "The latest Moltbook refresh failed; showing last-known-good data.",
    },
} satisfies MoltbookSnapshotResult;

const notifications = { notifications: [], readCount: 0, unreadCount: 0 } as const;

function moltbookFixtures(snapshot: DashboardStoryFixtureValue): DashboardStoryFixtures {
    return {
        queries: {
            "moltbook.snapshot": snapshot,
            "notifications.list": dashboardStoryValue(notifications),
        },
    };
}

const pending = dashboardStoryResolver(
    () =>
        new Promise<never>(() => {
            // Intentionally pending to expose the route loading state.
        })
);

const meta = {
    component: DashboardPageStory,
    parameters: { layout: "fullscreen" },
    render: (args, context) => <DashboardPageStory {...args} key={context.id} />,
    title: "Pages/Moltbook",
} satisfies Meta<typeof DashboardPageStory>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Loading: Story = {
    args: { fixtures: moltbookFixtures(pending), route: "/moltbook" },
};

export const FreshFeed: Story = {
    args: {
        fixtures: moltbookFixtures(dashboardStoryValue(freshSnapshot)),
        route: "/moltbook",
    },
};

export const Posts: Story = {
    args: FreshFeed.args,
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        await userEvent.click(await canvas.findByRole("tab", { name: /Posts/u }));
        await expect(
            canvas.getByText("Designing bounded operational views")
        ).toBeVisible();
    },
};

export const Comments: Story = {
    args: FreshFeed.args,
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        await userEvent.click(await canvas.findByRole("tab", { name: /Comments/u }));
        await expect(
            canvas.getByText("The new release flow is much easier to follow.")
        ).toBeVisible();
    },
};

export const Empty: Story = {
    args: {
        fixtures: moltbookFixtures(dashboardStoryValue(emptySnapshot)),
        route: "/moltbook",
    },
};

export const LastKnownGood: Story = {
    args: {
        fixtures: moltbookFixtures(dashboardStoryValue(lastKnownGoodSnapshot)),
        route: "/moltbook",
    },
};

export const BrowserRetained: Story = {
    args: {
        fixtures: moltbookFixtures(
            dashboardStoryFailure(new TypeError("Safe retained refresh failure"))
        ),
        querySeeds: [
            {
                key: moltbookSnapshotQueryKey("hot"),
                updatedAtMs: 1,
                value: freshSnapshot,
            },
        ],
        route: "/moltbook",
    },
};

export const InitialError: Story = {
    args: {
        fixtures: moltbookFixtures(
            dashboardStoryFailure(new TypeError("Safe Moltbook story failure"))
        ),
        route: "/moltbook",
    },
};
