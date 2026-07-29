import {
    type MoltbookContent,
    moltbookPostFromPayload,
    parseMoltbookContent,
    parseMoltbookFeed,
    parseMoltbookHome,
    parseMoltbookProfileCache,
} from "../../../contracts/moltbook";
import { messageFromError } from "../lib/errorMessage";
import { useCacheEntry } from "./useCache";

/** Defines moltbook keys. */
export const moltbookKeys = {
    home: (): ["moltbook", "home"] => ["moltbook", "home"],
    feed: (sort: "hot" | "new"): ["moltbook", "feed", string] => [
        "moltbook",
        "feed",
        sort,
    ],
    profile: (): ["moltbook", "profile"] => ["moltbook", "profile"],
    myContent: (): ["moltbook", "myContent"] => ["moltbook", "myContent"],
};

/**
 * Provides moltbook home.
 * @returns The moltbook home.
 */
export function useMoltbookHome() {
    return useCacheEntry("moltbook.home", parseMoltbookHome, 60_000);
}

/**
 * Provides moltbook feed.
 * @param sort Sort value.
 * @returns The moltbook feed.
 */
export function useMoltbookFeed(sort: "hot" | "new" = "hot") {
    return useCacheEntry(`moltbook.feed.${sort}`, parseMoltbookFeed, 60_000);
}

/**
 * Provides moltbook profile.
 * @returns The moltbook profile.
 */
export function useMoltbookProfile() {
    return useCacheEntry("moltbook.profile", parseMoltbookProfileCache, 60_000);
}

/**
 * Provides moltbook my content.
 * @returns The moltbook my content.
 */
export function useMoltbookMyContent() {
    return useCacheEntry("moltbook.my-content", parseMoltbookContent, 60_000);
}

/**
 * Provides moltbook data.
 * @param sort Sort value.
 * @returns The moltbook data.
 */
export function useMoltbookData(sort: "hot" | "new" = "hot") {
    const home = useMoltbookHome();
    const feed = useMoltbookFeed(sort);
    const profile = useMoltbookProfile();
    const myContent = useMoltbookMyContent();

    const isLoading =
        home.isLoading || feed.isLoading || profile.isLoading || myContent.isLoading;
    const error = home.error || feed.error || profile.error || myContent.error;

    return {
        home: home.data?.data,
        homeCache: home.data,
        posts: (feed.data?.data.posts || []).map((post) => moltbookPostFromPayload(post)),
        profile: profile.data?.data.agent || undefined,
        myContent: {
            posts: myContent.data?.data.posts || [],
            comments: myContent.data?.data.comments || [],
        } satisfies MoltbookContent,
        isLoading,
        error: error ? messageFromError(error, "Failed to load Moltbook") : undefined,
        refetch: () =>
            Promise.all([
                home.refetch(),
                feed.refetch(),
                profile.refetch(),
                myContent.refetch(),
            ]),
    };
}
