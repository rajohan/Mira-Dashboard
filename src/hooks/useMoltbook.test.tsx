import { renderHook, waitFor } from "@testing-library/react";
import { act } from "react";
import { describe, expect, it, vi } from "vitest";

import { createQueryWrapper } from "../test/queryClient";
import {
    moltbookKeys,
    useMoltbookData,
    useMoltbookFeed,
    useMoltbookHome,
    useMoltbookMyContent,
    useMoltbookProfile,
} from "./useMoltbook";

describe("moltbook hooks", () => {
    it("exports stable query keys", () => {
        expect(moltbookKeys.home()).toEqual(["moltbook", "home"]);
        expect(moltbookKeys.feed("hot")).toEqual(["moltbook", "feed", "hot"]);
        expect(moltbookKeys.profile()).toEqual(["moltbook", "profile"]);
        expect(moltbookKeys.myContent()).toEqual(["moltbook", "myContent"]);
    });
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

    it("transforms posts with various field shapes", async () => {
        const feedData = {
            posts: [
                {
                    id: "p2",
                    title: "Alt fields",
                    content_preview: "preview text",
                    author: {
                        name: "bot",
                        display_name: "Bot",
                        avatar_url: "http://img",
                    },
                    upvotes: 0,
                    downvotes: 1,
                    comment_count: 0,
                    created_at: "2026-01-01",
                    submolt_name: "test",
                    you_follow_author: true,
                },
            ],
        };

        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({
                    key: "moltbook.home",
                    data: {},
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
                    data: {},
                    cachedAt: "2026-01-01",
                }),
            })
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({
                    key: "moltbook.my-content",
                    data: { posts: [], comments: [] },
                    cachedAt: "2026-01-01",
                }),
            });
        vi.stubGlobal("fetch", fetchMock);

        const { result } = renderHook(() => useMoltbookData(), {
            wrapper: createQueryWrapper(),
        });

        await waitFor(() => expect(result.current.posts.length).toBe(1));
        const post = result.current.posts[0];
        expect(post?.id).toBe("p2");
        expect(post?.author.name).toBe("bot");
        expect(post?.author.display_name).toBe("Bot");
        expect(post?.author.avatar_url).toBe("http://img");
        expect(post?.you_follow_author).toBe(true);
        expect(post?.content).toBe("preview text");
    });

    it("handles error state from cache entries", async () => {
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce({
                ok: false,
                status: 500,
                json: async () => ({ error: "fail" }),
            })
            .mockResolvedValue({
                ok: true,
                status: 200,
                json: async () => ({ key: "x", data: {}, cachedAt: "2026-01-01" }),
            });
        vi.stubGlobal("fetch", fetchMock);

        const { result } = renderHook(() => useMoltbookData(), {
            wrapper: createQueryWrapper(),
        });

        await waitFor(() => expect(result.current.error).toBeTruthy(), { timeout: 5000 });
    });

    it("refetches all moltbook cache entries", async () => {
        const fetchMock = vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({ key: "x", data: {}, cachedAt: "2026-01-01" }),
        });
        vi.stubGlobal("fetch", fetchMock);

        const { result } = renderHook(() => useMoltbookData(), {
            wrapper: createQueryWrapper(),
        });

        await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
        act(() => {
            result.current.refetch();
        });
        await waitFor(() =>
            expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(8)
        );
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
