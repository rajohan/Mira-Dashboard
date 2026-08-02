import { json } from "../http/core.ts";
import { routeFailureResponse } from "../http/routeSupport.ts";
import {
    fetchCachedMoltbookFeed,
    fetchCachedMoltbookHome,
    fetchCachedMoltbookMyContent,
    fetchCachedMoltbookProfile,
} from "../lib/moltbookCache.ts";

export const moltbookRoutes = {
    "/api/moltbook/home": {
        GET: () => {
            try {
                const home = fetchCachedMoltbookHome();
                return json(home);
            } catch {
                return routeFailureResponse({
                    code: "moltbook_cache_unavailable",
                    context: "moltbook",
                    message: "Moltbook cache unavailable",
                    status: 503,
                });
            }
        },
    },
    "/api/moltbook/feed": {
        GET: (request: Request) => {
            try {
                const sort =
                    new URL(request.url).searchParams.get("sort") === "new"
                        ? "new"
                        : "hot";
                const feed = fetchCachedMoltbookFeed(sort);
                return json(feed);
            } catch {
                return routeFailureResponse({
                    code: "moltbook_feed_unavailable",
                    context: "moltbook",
                    message: "Moltbook feed cache unavailable",
                    status: 503,
                });
            }
        },
    },
    "/api/moltbook/profile": {
        GET: () => {
            try {
                const profile = fetchCachedMoltbookProfile();
                return json(profile);
            } catch {
                return routeFailureResponse({
                    code: "moltbook_profile_unavailable",
                    context: "moltbook",
                    message: "Moltbook profile cache unavailable",
                    status: 503,
                });
            }
        },
    },
    "/api/moltbook/my-posts": {
        GET: () => {
            try {
                const content = fetchCachedMoltbookMyContent();
                return json(content);
            } catch {
                return routeFailureResponse({
                    code: "moltbook_content_unavailable",
                    context: "moltbook",
                    message: "Moltbook content cache unavailable",
                    status: 503,
                });
            }
        },
    },
} as const;
