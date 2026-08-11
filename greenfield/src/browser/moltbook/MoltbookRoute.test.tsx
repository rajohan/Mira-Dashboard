import { expect, test } from "bun:test";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import type { DashboardTrpcClient } from "../api/trpcClient.ts";
import { DashboardTrpcProvider } from "../api/trpcContext.tsx";
import { moltbookQueryKey } from "./moltbookQueries.ts";
import { MoltbookRoute } from "./MoltbookRoute.tsx";

const { render, screen } = await import("@testing-library/react");
const userEventModule = await import("@testing-library/user-event");
const userEvent = userEventModule.default;

const status = Object.freeze({
    freshness: "stale" as const,
    lastAttemptAtMs: 2000,
    lastAttemptStatus: "failed" as const,
    lastSuccessAtMs: 1000,
    refreshFailureMessage: "Moltbook dashboard projection could not be collected.",
});

test("Moltbook route renders LKG state, encoded links, and independent content tabs", async () => {
    const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false } },
    });
    const updatedAt = Date.now();
    queryClient.setQueryData(
        [...moltbookQueryKey, "home"],
        {
            home: {
                activityOnYourPostsCount: 0,
                exploreCount: 0,
                nextActions: [],
                pendingRequestCount: 0,
                postsFromAccountsYouFollowCount: 0,
                unreadMessageCount: 2,
                unreadNotificationCount: 3,
            },
            status,
        },
        { updatedAt }
    );
    queryClient.setQueryData(
        [...moltbookQueryKey, "feed", "hot"],
        {
            feed: {
                hasMore: false,
                posts: [
                    {
                        author: { name: "ada/lovelace" },
                        commentCount: 4,
                        contentPreview: "A bounded preview",
                        createdAtMs: updatedAt - 60_000,
                        downvotes: 1,
                        id: "post/one",
                        submoltName: "agent/news",
                        title: "A feed post",
                        upvotes: 8,
                    },
                ],
                sort: "hot",
            },
            status,
        },
        { updatedAt }
    );
    queryClient.setQueryData(
        [...moltbookQueryKey, "profile"],
        {
            profile: {
                commentsCount: 1,
                description: "Dashboard agent",
                displayName: "Mira",
                followerCount: 10,
                followingCount: 2,
                karma: 42,
                name: "mira/2026",
                postsCount: 1,
            },
            status,
        },
        { updatedAt }
    );
    queryClient.setQueryData(
        [...moltbookQueryKey, "own-content"],
        {
            content: {
                comments: [
                    {
                        content: "My comment",
                        createdAtMs: updatedAt - 120_000,
                        downvotes: 0,
                        id: "comment/one",
                        post: {
                            id: "post/one",
                            submoltName: "agent/news",
                            title: "A feed post",
                        },
                        upvotes: 2,
                    },
                ],
                posts: [
                    {
                        commentCount: 4,
                        contentPreview: "My post preview",
                        createdAtMs: updatedAt - 180_000,
                        downvotes: 0,
                        id: "mine/one",
                        submoltName: "agent/news",
                        title: "My authored post",
                        upvotes: 5,
                    },
                ],
            },
            status,
        },
        { updatedAt }
    );
    const client = {
        mutation: () => Promise.reject(new Error("Unexpected mutation")),
        query: () => Promise.reject(new Error("Unexpected query")),
    } as unknown as DashboardTrpcClient;
    const view = render(
        <QueryClientProvider client={queryClient}>
            <DashboardTrpcProvider client={client}>
                <MoltbookRoute />
            </DashboardTrpcProvider>
        </QueryClientProvider>
    );

    try {
        expect(
            await screen.findByRole("heading", { level: 1, name: "Moltbook" })
        ).toBeVisible();
        expect(screen.getByText("Last-known-good snapshot")).toBeVisible();
        expect(screen.getByText("2 unread messages")).toBeVisible();
        expect(screen.getByText("3 unread notifications")).toBeVisible();
        expect(screen.getByRole("link", { name: /Open Mira/u })).toHaveAttribute(
            "href",
            "https://www.moltbook.com/u/mira%2F2026"
        );
        expect(screen.getByRole("link", { name: /A feed post/u })).toHaveAttribute(
            "href",
            "https://www.moltbook.com/post/post%2Fone"
        );

        const user = userEvent.setup();
        await user.click(screen.getByRole("tab", { name: /Posts/u }));
        expect(screen.getByText("My authored post")).toBeVisible();
        await user.click(screen.getByRole("tab", { name: /Comments/u }));
        expect(screen.getByText("My comment")).toBeVisible();
    } finally {
        view.unmount();
        queryClient.clear();
    }
});
