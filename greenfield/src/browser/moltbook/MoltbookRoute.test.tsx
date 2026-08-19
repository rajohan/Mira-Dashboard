import { expect, test } from "bun:test";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import type { MoltbookSnapshotResult } from "../../contracts/moltbook.ts";
import type { DashboardTrpcClient } from "../api/trpcClient.ts";
import { DashboardTrpcProvider } from "../api/trpcContext.tsx";
import { Route as moltbookLazyRoute } from "../routes/moltbook.lazy.tsx";
import { moltbookSnapshotQueryKey } from "./moltbookQueries.ts";
import { MoltbookRoute } from "./MoltbookRoute.tsx";

const { act, render, screen } = await import("@testing-library/react");
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
    const snapshot = {
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
        home: {
            activityOnYourPostsCount: 0,
            exploreCount: 0,
            nextActions: [],
            pendingRequestCount: 0,
            postsFromAccountsYouFollowCount: 0,
            unreadMessageCount: 2,
            unreadNotificationCount: 3,
        },
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
    } as const satisfies MoltbookSnapshotResult;
    queryClient.setQueryData(moltbookSnapshotQueryKey("hot"), snapshot, {
        updatedAt,
    });
    const failedFeed = Promise.withResolvers<unknown>();
    let newFeedRequests = 0;
    const recoveredSnapshot = {
        ...snapshot,
        feed: {
            ...snapshot.feed,
            posts: [
                {
                    ...snapshot.feed.posts[0],
                    title: "Recovered new feed post",
                },
            ],
            sort: "new" as const,
        },
        status: {
            ...status,
            freshness: "fresh" as const,
            lastAttemptStatus: "succeeded" as const,
            lastSuccessAtMs: 3000,
        },
    } satisfies MoltbookSnapshotResult;
    const client = {
        mutation: () => Promise.reject(new Error("Unexpected mutation")),
        query: (name: string, input: unknown) => {
            if (
                name !== "moltbook.snapshot" ||
                typeof input !== "object" ||
                input === null ||
                !("sort" in input) ||
                input.sort !== "new"
            ) {
                return Promise.reject(new Error(`Unexpected query: ${name}`));
            }

            newFeedRequests += 1;
            return newFeedRequests === 1
                ? failedFeed.promise
                : Promise.resolve(recoveredSnapshot);
        },
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
        ).toHaveClass("sr-only");
        expect(screen.queryByText("Last-known-good snapshot")).toBeNull();
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
        expect(screen.getByLabelText("5 upvotes")).toBeVisible();
        await user.click(screen.getByRole("tab", { name: /Comments/u }));
        expect(screen.getByText("My comment")).toBeVisible();
        expect(screen.getByLabelText("2 upvotes")).toBeVisible();

        await user.click(screen.getByRole("tab", { name: /Feed/u }));
        const newTab = screen.getByRole("tab", { name: "New" });
        await user.click(newTab);
        expect(screen.getByText("A feed post")).toBeVisible();
        expect(screen.getByRole("tab", { name: /Comments/u })).toBeVisible();
        expect(newTab).toHaveFocus();

        act(() => {
            failedFeed.reject(new Error("Moltbook New feed fixture failed"));
        });
        expect(
            await screen.findByText(
                "The new feed could not be loaded; showing hot feed data."
            )
        ).toBeVisible();
        expect(screen.getByText("A feed post")).toBeVisible();
        expect(screen.getByRole("button", { name: "Retry" })).toBeVisible();

        await user.click(screen.getByRole("button", { name: "Retry" }));
        expect(await screen.findByText("Recovered new feed post")).toBeVisible();
        expect(newFeedRequests).toBe(2);
    } finally {
        view.unmount();
        queryClient.clear();
    }
});

test("Moltbook route is registered through its authenticated lazy boundary", () => {
    expect(moltbookLazyRoute.options.id).toBe("/moltbook");
    expect(moltbookLazyRoute.options.component).toBeFunction();
});
