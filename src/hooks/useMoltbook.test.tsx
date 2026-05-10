import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { createQueryWrapper } from "../test/queryClient";
import {
    useMoltbookData,
    useMoltbookFeed,
    useMoltbookHome,
    useMoltbookMyContent,
    useMoltbookProfile,
} from "./useMoltbook";

describe("moltbook hooks", () => {
    it("composes moltbook data from cache entries", async () => {
        const homeData = {
            pendingRequestCount: 2,
            unreadMessageCount: 0,
            activityOnYourPostsCount: 0,
            activityOnYourPosts: [],
            latestAnnouncement: null,
            postsFromAccountsYouFollowCount: null,
            exploreCount: null,
            nextActions: [],
            fetchedAt: "2026-01-01",
        };
        const feedData = {
            posts: [
                {
                    post_id: "p1",
                    title: "Hello",
                    content: "world",
                    upvotes: 5,
                    downvotes: 0,
                    comment_count: 1,
                    created_at: "2026-01-01",
                    submolt_name: "general",
                    author_name: "mira",
                },
            ],
        };
        const profileData = { agent: { name: "mira_2026", display_name: "Mira" } };
        const myContentData = {
            posts: [{ id: "p1", title: "My Post" }],
            comments: [{ id: "c1", content: "hi" }],
        };

        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({
                    key: "moltbook.home",
                    data: homeData,
                    cachedAt: "2026-01-01",
                }),
            })
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({
                    key: "moltbook.feed.hot",
                    data: feedData,
                    cachedAt: "2026-01-01",
                }),
            })
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({
                    key: "moltbook.profile",
                    data: profileData,
                    cachedAt: "2026-01-01",
                }),
            })
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({
                    key: "moltbook.my-content",
                    data: myContentData,
                    cachedAt: "2026-01-01",
                }),
            });
        vi.stubGlobal("fetch", fetchMock);

        const { result } = renderHook(() => useMoltbookData(), {
            wrapper: createQueryWrapper(),
        });

        await waitFor(() => expect(result.current.home?.pendingRequestCount).toBe(2));
        expect(result.current.posts[0]?.id).toBe("p1");
        expect(result.current.profile?.name).toBe("mira_2026");
        expect(result.current.myContent.posts.length).toBe(1);
        expect(result.current.isLoading).toBe(false);
    });

    it("individual cache hooks call useCacheEntry with correct keys", async () => {
        const fetchMock = vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({ key: "x", data: {}, cachedAt: "2026-01-01" }),
        });
        vi.stubGlobal("fetch", fetchMock);
        const wrapper = createQueryWrapper();

        renderHook(() => useMoltbookHome(), { wrapper });
        renderHook(() => useMoltbookFeed("new"), { wrapper });
        renderHook(() => useMoltbookProfile(), { wrapper });
        renderHook(() => useMoltbookMyContent(), { wrapper });

        await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
        const urls = fetchMock.mock.calls.map((c: unknown[]) => c[0] as string);
        expect(urls.some((u: string) => u.includes("moltbook.home"))).toBe(true);
        expect(urls.some((u: string) => u.includes("moltbook.feed.new"))).toBe(true);
    });
});
