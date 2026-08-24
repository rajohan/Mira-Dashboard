import { describe, expect, test } from "bun:test";
import { inspect } from "node:util";

import { Redacted } from "effect";

import { createMoltbookDashboardCollector, MoltbookProviderFailure } from "./provider.ts";

function jsonResponse(value: unknown): Response {
    return Response.json(value, {
        headers: { "content-type": "application/json; charset=utf-8" },
    });
}

const providerPayloads = Object.freeze({
    home: {
        activity_on_your_posts: [{ id: "activity-1" }],
        explore: [{ id: "explore-1" }, { id: "explore-2" }],
        latest_moltbook_announcement: {
            author_name: "moltbook",
            created_at: "2026-08-11T08:00:00.000Z",
            post_id: "announcement-1",
            preview: "Platform news",
            title: "News",
        },
        posts_from_accounts_you_follow: [{ id: "followed-1" }],
        what_to_do_next: ["Read the feed"],
        your_account: { unread_notification_count: 3 },
        your_direct_messages: {
            pending_request_count: 1,
            unread_message_count: 2,
        },
    },
    hot: {
        feed_filter: "all",
        has_more: false,
        posts: [
            {
                author: { display_name: "Ada", name: "ada" },
                comment_count: 4,
                content_preview: "A bounded preview",
                created_at: "2026-08-11T09:00:00.000Z",
                downvotes: 1,
                id: "post-hot",
                submolt_name: "agents",
                title: "Hot post",
                upvotes: 8,
                you_follow_author: true,
            },
        ],
        tip: "Be kind",
    },
    new: { has_more: true, posts: [] },
    profile: {
        agent: {
            comments_count: 6,
            description: "Dashboard agent",
            display_name: "Mira",
            follower_count: 10,
            following_count: 2,
            karma: "-42",
            name: "mira/2026",
            posts_count: 5,
        },
        recentComments: [
            {
                content: "A comment",
                created_at: "2026-08-11T07:00:00.000Z",
                downvotes: 0,
                id: "comment-1",
                post: {
                    id: "post-1",
                    submolt: { name: "agents" },
                    title: "Post one",
                },
                upvotes: 2,
            },
        ],
        recentPosts: [
            {
                comment_count: 1,
                content_preview: "My post",
                created_at: "2026-08-11T06:00:00.000Z",
                downvotes: 0,
                id: "post-1",
                submolt: { name: "agents" },
                title: "Post one",
                upvotes: 3,
            },
        ],
    },
});

describe("Moltbook dashboard provider", () => {
    test("uses only four fixed www requests and returns one strict aggregate", async () => {
        const requests: Array<{ init: RequestInit; url: string }> = [];
        const byPath = new Map<string, unknown>([
            ["/api/v1/home", providerPayloads.home],
            ["/api/v1/feed?sort=hot&limit=25", providerPayloads.hot],
            ["/api/v1/feed?sort=new&limit=25", providerPayloads.new],
            ["/api/v1/agents/profile?name=mira%2F2026", providerPayloads.profile],
        ]);
        const collector = createMoltbookDashboardCollector({
            agentName: "mira/2026",
            apiKey: Redacted.make("moltbook-secret-sentinel"),
            fetch: (input, init) => {
                const url = new URL(input);
                requests.push({ init, url: url.href });
                const payload = byPath.get(`${url.pathname}${url.search}`);
                return Promise.resolve(
                    payload === undefined
                        ? new Response(null, { status: 404 })
                        : jsonResponse(payload)
                );
            },
            nowMs: () => 1_723_365_000_000,
        });

        const snapshot = await collector.collect(new AbortController().signal);

        expect(requests.map(({ url }) => url).toSorted()).toEqual(
            [
                "https://www.moltbook.com/api/v1/agents/profile?name=mira%2F2026",
                "https://www.moltbook.com/api/v1/feed?sort=hot&limit=25",
                "https://www.moltbook.com/api/v1/feed?sort=new&limit=25",
                "https://www.moltbook.com/api/v1/home",
            ].toSorted()
        );
        for (const request of requests) {
            expect(request.init).toMatchObject({ method: "GET", redirect: "error" });
            expect(new Headers(request.init?.headers).get("authorization")).toBe(
                "Bearer moltbook-secret-sentinel"
            );
        }
        expect(snapshot).toMatchObject({
            feeds: {
                hot: {
                    posts: [
                        {
                            author: { displayName: "Ada", name: "ada" },
                            id: "post-hot",
                            submoltName: "agents",
                        },
                    ],
                    sort: "hot",
                },
                new: { posts: [], sort: "new" },
            },
            fetchedAtMs: 1_723_365_000_000,
            home: {
                activityOnYourPostsCount: 1,
                unreadMessageCount: 2,
                unreadNotificationCount: 3,
            },
            myContent: {
                comments: [{ id: "comment-1" }],
                posts: [{ id: "post-1" }],
            },
            profile: { karma: -42, name: "mira/2026" },
        });
        expect(JSON.stringify(snapshot)).not.toContain("activity-1");
    });

    test("keeps a missing provider profile optional without losing authored content", async () => {
        const byPath = new Map<string, unknown>([
            ["/api/v1/home", providerPayloads.home],
            ["/api/v1/feed?sort=hot&limit=25", providerPayloads.hot],
            ["/api/v1/feed?sort=new&limit=25", providerPayloads.new],
            [
                "/api/v1/agents/profile?name=mira_2026",
                { recentComments: [], recentPosts: [] },
            ],
        ]);
        const collector = createMoltbookDashboardCollector({
            agentName: "mira_2026",
            apiKey: Redacted.make("moltbook-secret-sentinel"),
            fetch: (input) =>
                Promise.resolve(jsonResponse(byPath.get(input.pathname + input.search))),
            nowMs: () => 1_723_365_000_000,
        });

        const snapshot = await collector.collect(new AbortController().signal);

        expect(snapshot.profile).toBeUndefined();
        expect(snapshot.myContent).toEqual({ comments: [], posts: [] });
    });

    test("defaults a missing optional account notification block without losing home data", async () => {
        const byPath = new Map<string, unknown>([
            ["/api/v1/home", { ...providerPayloads.home, your_account: undefined }],
            ["/api/v1/feed?sort=hot&limit=25", providerPayloads.hot],
            ["/api/v1/feed?sort=new&limit=25", providerPayloads.new],
            ["/api/v1/agents/profile?name=mira_2026", providerPayloads.profile],
        ]);
        const collector = createMoltbookDashboardCollector({
            agentName: "mira_2026",
            apiKey: Redacted.make("moltbook-secret-sentinel"),
            fetch: (input) =>
                Promise.resolve(jsonResponse(byPath.get(input.pathname + input.search))),
            nowMs: () => 1_723_365_000_000,
        });

        const snapshot = await collector.collect(new AbortController().signal);

        expect(snapshot.home).toMatchObject({
            exploreCount: 2,
            unreadMessageCount: 2,
            unreadNotificationCount: 0,
        });
    });

    test("defaults a present account block without its notification count", async () => {
        const byPath = new Map<string, unknown>([
            ["/api/v1/home", { ...providerPayloads.home, your_account: {} }],
            ["/api/v1/feed?sort=hot&limit=25", providerPayloads.hot],
            ["/api/v1/feed?sort=new&limit=25", providerPayloads.new],
            ["/api/v1/agents/profile?name=mira_2026", providerPayloads.profile],
        ]);
        const collector = createMoltbookDashboardCollector({
            agentName: "mira_2026",
            apiKey: Redacted.make("moltbook-secret-sentinel"),
            fetch: (input) =>
                Promise.resolve(jsonResponse(byPath.get(input.pathname + input.search))),
        });

        const snapshot = await collector.collect(new AbortController().signal);

        expect(snapshot.home.unreadNotificationCount).toBe(0);
    });

    test("defaults omitted legacy-optional home, feed, and authored-content fields", async () => {
        const byPath = new Map<string, unknown>([
            ["/api/v1/home", { your_account: {} }],
            ["/api/v1/feed?sort=hot&limit=25", { has_more: false }],
            ["/api/v1/feed?sort=new&limit=25", { posts: [] }],
            [
                "/api/v1/agents/profile?name=mira_2026",
                { agent: providerPayloads.profile.agent },
            ],
        ]);
        const collector = createMoltbookDashboardCollector({
            agentName: "mira_2026",
            apiKey: Redacted.make("moltbook-secret-sentinel"),
            fetch: (input) =>
                Promise.resolve(jsonResponse(byPath.get(input.pathname + input.search))),
            nowMs: () => 1_723_365_000_000,
        });

        const snapshot = await collector.collect(new AbortController().signal);

        expect(snapshot.home).toEqual({
            activityOnYourPostsCount: 0,
            exploreCount: 0,
            nextActions: [],
            pendingRequestCount: 0,
            postsFromAccountsYouFollowCount: 0,
            unreadMessageCount: 0,
            unreadNotificationCount: 0,
        });
        expect(snapshot.feeds.hot).toMatchObject({
            hasMore: false,
            posts: [],
        });
        expect(snapshot.feeds.new).toMatchObject({
            hasMore: false,
            posts: [],
        });
        expect(snapshot.myContent).toEqual({ comments: [], posts: [] });
        expect(snapshot.profile).toMatchObject({ name: "mira/2026" });
    });

    test("accepts current home collection pointers alongside legacy arrays", async () => {
        const byPath = new Map<string, unknown>([
            [
                "/api/v1/home",
                {
                    ...providerPayloads.home,
                    explore: {
                        description: "Discover current Moltbook posts",
                        endpoint: "/api/v1/posts",
                    },
                    posts_from_accounts_you_follow: {
                        posts: [{ id: "followed-1" }, { id: "followed-2" }],
                    },
                    your_direct_messages: undefined,
                },
            ],
            ["/api/v1/feed?sort=hot&limit=25", providerPayloads.hot],
            ["/api/v1/feed?sort=new&limit=25", providerPayloads.new],
            ["/api/v1/agents/profile?name=mira_2026", providerPayloads.profile],
        ]);
        const collector = createMoltbookDashboardCollector({
            agentName: "mira_2026",
            apiKey: Redacted.make("moltbook-secret-sentinel"),
            fetch: (input) =>
                Promise.resolve(jsonResponse(byPath.get(input.pathname + input.search))),
            nowMs: () => 1_723_365_000_000,
        });

        const snapshot = await collector.collect(new AbortController().signal);

        expect(snapshot.home).toMatchObject({
            exploreCount: 0,
            pendingRequestCount: 0,
            postsFromAccountsYouFollowCount: 2,
            unreadMessageCount: 0,
        });
    });

    test("rejects malformed present optional fields instead of defaulting them", async () => {
        const malformedCases = [
            {
                path: "/api/v1/home",
                value: { explore: {} },
            },
            {
                path: "/api/v1/home",
                value: { posts_from_accounts_you_follow: { posts: {} } },
            },
            {
                path: "/api/v1/feed?sort=hot&limit=25",
                value: { posts: {} },
            },
            {
                path: "/api/v1/feed?sort=new&limit=25",
                value: { has_more: "false" },
            },
            {
                path: "/api/v1/agents/profile?name=mira_2026",
                value: { agent: providerPayloads.profile.agent, recentComments: {} },
            },
            {
                path: "/api/v1/agents/profile?name=mira_2026",
                value: { agent: providerPayloads.profile.agent, recentPosts: {} },
            },
        ] as const;

        for (const malformed of malformedCases) {
            const byPath = new Map<string, unknown>([
                ["/api/v1/home", providerPayloads.home],
                ["/api/v1/feed?sort=hot&limit=25", providerPayloads.hot],
                ["/api/v1/feed?sort=new&limit=25", providerPayloads.new],
                ["/api/v1/agents/profile?name=mira_2026", providerPayloads.profile],
                [malformed.path, malformed.value],
            ]);
            const collector = createMoltbookDashboardCollector({
                agentName: "mira_2026",
                apiKey: Redacted.make("moltbook-secret-sentinel"),
                fetch: (input) =>
                    Promise.resolve(
                        jsonResponse(byPath.get(input.pathname + input.search))
                    ),
            });

            const failure = await collector
                .collect(new AbortController().signal)
                .catch((error: unknown) => error);

            expect(failure).toBeInstanceOf(MoltbookProviderFailure);
            expect((failure as MoltbookProviderFailure).reason).toBe("invalid-response");
        }
    });

    test("rejects empty endpoint envelopes instead of replacing last-known-good data", async () => {
        const paths = [
            "/api/v1/home",
            "/api/v1/feed?sort=hot&limit=25",
            "/api/v1/feed?sort=new&limit=25",
            "/api/v1/agents/profile?name=mira_2026",
        ] as const;

        for (const emptyPath of paths) {
            const byPath = new Map<string, unknown>([
                ["/api/v1/home", providerPayloads.home],
                ["/api/v1/feed?sort=hot&limit=25", providerPayloads.hot],
                ["/api/v1/feed?sort=new&limit=25", providerPayloads.new],
                ["/api/v1/agents/profile?name=mira_2026", providerPayloads.profile],
                [emptyPath, {}],
            ]);
            const collector = createMoltbookDashboardCollector({
                agentName: "mira_2026",
                apiKey: Redacted.make("moltbook-secret-sentinel"),
                fetch: (input) =>
                    Promise.resolve(
                        jsonResponse(byPath.get(input.pathname + input.search))
                    ),
            });

            const failure = await collector
                .collect(new AbortController().signal)
                .catch((error: unknown) => error);

            expect(failure).toBeInstanceOf(MoltbookProviderFailure);
            expect((failure as MoltbookProviderFailure).reason).toBe("invalid-response");
        }
    });

    test("aborts outstanding sibling reads after an all-or-nothing failure", async () => {
        let abortedSiblings = 0;
        const collector = createMoltbookDashboardCollector({
            agentName: "mira_2026",
            apiKey: Redacted.make("moltbook-secret-sentinel"),
            fetch: (url, init) => {
                if (url.pathname.endsWith("/home")) {
                    return Promise.resolve(new Response(null, { status: 503 }));
                }
                const signal = init.signal;
                if (!(signal instanceof AbortSignal)) {
                    throw new Error("Expected a composed request signal");
                }
                return new Promise((_resolve, reject) => {
                    signal.addEventListener(
                        "abort",
                        () => {
                            abortedSiblings += 1;
                            reject(new DOMException("Aborted", "AbortError"));
                        },
                        { once: true }
                    );
                });
            },
        });

        const failure = await collector
            .collect(new AbortController().signal)
            .catch((error: unknown) => error);

        expect(failure).toBeInstanceOf(MoltbookProviderFailure);
        expect(abortedSiblings).toBe(3);
    });

    test("cancels response readers before releasing their locks after caller abort", async () => {
        const requestController = new AbortController();
        let cancelledBodies = 0;
        let abortTriggered = false;
        const collector = createMoltbookDashboardCollector({
            agentName: "mira_2026",
            apiKey: Redacted.make("moltbook-secret-sentinel"),
            fetch: () =>
                Promise.resolve(
                    new Response(
                        new ReadableStream<Uint8Array>({
                            cancel() {
                                cancelledBodies += 1;
                            },
                            pull(controller) {
                                if (!abortTriggered) {
                                    abortTriggered = true;
                                    requestController.abort(
                                        new Error("Caller cancelled Moltbook collection")
                                    );
                                }
                                controller.enqueue(new TextEncoder().encode("{}"));
                            },
                        }),
                        { headers: { "content-type": "application/json" } }
                    )
                ),
        });

        const failure = await collector
            .collect(requestController.signal)
            .catch((error: unknown) => error);

        expect(failure).toBeInstanceOf(Error);
        expect(cancelledBodies).toBeGreaterThan(0);
    });

    test("classifies normalized payload schema violations as invalid responses", async () => {
        const byPath = new Map<string, unknown>([
            ["/api/v1/home", providerPayloads.home],
            [
                "/api/v1/feed?sort=hot&limit=25",
                {
                    ...providerPayloads.hot,
                    posts: [
                        {
                            ...providerPayloads.hot.posts[0],
                            title: "x".repeat(501),
                        },
                    ],
                },
            ],
            ["/api/v1/feed?sort=new&limit=25", providerPayloads.new],
            ["/api/v1/agents/profile?name=mira_2026", providerPayloads.profile],
        ]);
        const collector = createMoltbookDashboardCollector({
            agentName: "mira_2026",
            apiKey: Redacted.make("moltbook-secret-sentinel"),
            fetch: (input) =>
                Promise.resolve(jsonResponse(byPath.get(input.pathname + input.search))),
        });

        const failure = await collector
            .collect(new AbortController().signal)
            .catch((error: unknown) => error);

        expect(failure).toBeInstanceOf(MoltbookProviderFailure);
        expect((failure as MoltbookProviderFailure).reason).toBe("invalid-response");
    });

    test("rejects a valid projection that exceeds the cache row budget", async () => {
        const largePosts = Array.from({ length: 25 }, (_, index) => ({
            ...providerPayloads.hot.posts[0],
            content_preview: "x".repeat(8000),
            id: `large-${index}`,
        }));
        const byPath = new Map<string, unknown>([
            ["/api/v1/home", providerPayloads.home],
            ["/api/v1/feed?sort=hot&limit=25", { has_more: false, posts: largePosts }],
            ["/api/v1/feed?sort=new&limit=25", { has_more: false, posts: largePosts }],
            ["/api/v1/agents/profile?name=mira_2026", providerPayloads.profile],
        ]);
        const collector = createMoltbookDashboardCollector({
            agentName: "mira_2026",
            apiKey: Redacted.make("moltbook-secret-sentinel"),
            fetch: (input) =>
                Promise.resolve(jsonResponse(byPath.get(input.pathname + input.search))),
        });

        const failure = await collector
            .collect(new AbortController().signal)
            .catch((error: unknown) => error);

        expect(failure).toBeInstanceOf(MoltbookProviderFailure);
        expect((failure as MoltbookProviderFailure).reason).toBe("unavailable");
    });

    test("rejects redirects, non-JSON, and over-budget bodies without secret leakage", async () => {
        const secret = "provider-secret-sentinel";
        for (const response of [
            new Response(null, {
                headers: { location: "https://moltbook.com/api/v1/home" },
                status: 302,
            }),
            new Response("not json", {
                headers: { "content-type": "text/plain" },
            }),
            Response.json({ value: "x".repeat(256 * 1024) }),
        ]) {
            const collector = createMoltbookDashboardCollector({
                agentName: "mira_2026",
                apiKey: Redacted.make(secret),
                fetch: (_url, _init) => Promise.resolve(response.clone()),
            });
            const failure = await collector
                .collect(new AbortController().signal)
                .catch((error: unknown) => error);
            expect(failure).toBeInstanceOf(MoltbookProviderFailure);
            expect(String(failure)).not.toContain(secret);
            expect(inspect(failure)).not.toContain(secret);
            expect(JSON.stringify(failure)).not.toContain(secret);
        }
    });
});
