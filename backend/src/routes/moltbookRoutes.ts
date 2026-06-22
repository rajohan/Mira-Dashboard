import { json } from "../http.ts";
import { errorMessage } from "../lib/errors.ts";
import {
    fetchCachedMoltbookFeed,
    fetchCachedMoltbookHome,
    fetchCachedMoltbookMyContent,
    fetchCachedMoltbookProfile,
} from "../lib/moltbookCache.ts";

export const moltbookRoutes = {
    "/api/moltbook/home": {
        GET: async () => {
            try {
                const home = await fetchCachedMoltbookHome();
                return json(home.data);
            } catch (error) {
                return json(
                    { error: errorMessage(error, "Moltbook cache unavailable") },
                    { status: 503 }
                );
            }
        },
    },
    "/api/moltbook/feed": {
        GET: async (request: Request) => {
            try {
                const sort =
                    new URL(request.url).searchParams.get("sort") === "new"
                        ? "new"
                        : "hot";
                const feed = await fetchCachedMoltbookFeed(sort);
                return json(feed.data);
            } catch (error) {
                return json(
                    { error: errorMessage(error, "Moltbook feed cache unavailable") },
                    { status: 503 }
                );
            }
        },
    },
    "/api/moltbook/profile": {
        GET: async () => {
            try {
                const profile = await fetchCachedMoltbookProfile();
                return json(profile.data);
            } catch (error) {
                return json(
                    { error: errorMessage(error, "Moltbook profile cache unavailable") },
                    { status: 503 }
                );
            }
        },
    },
    "/api/moltbook/my-posts": {
        GET: async () => {
            try {
                const content = await fetchCachedMoltbookMyContent();
                return json(content.data);
            } catch (error) {
                return json(
                    { error: errorMessage(error, "Moltbook content cache unavailable") },
                    { status: 503 }
                );
            }
        },
    },
} as const;
