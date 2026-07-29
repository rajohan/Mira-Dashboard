import {
    type MoltbookContent,
    type MoltbookFeed,
    type MoltbookHome,
    type MoltbookProfileCache,
    parseMoltbookContent,
    parseMoltbookFeed,
    parseMoltbookHome,
    parseMoltbookProfileCache,
} from "../../../contracts/moltbook.ts";
import type { ContractParser } from "../../../contracts/runtime.ts";
import { getCacheEntry, parseJsonField } from "./cacheStore.ts";

/**
 * Fetches cached moltbook entry.
 * @param key Lookup key.
 * @param parser Runtime value parser.
 * @returns Fetch cached moltbook entry result.
 */
function fetchCachedMoltbookEntry<T>(key: string, parser: ContractParser<T>): T {
    const row = getCacheEntry(key);
    if (!row || row.status !== "fresh") {
        throw new Error(`Moltbook cache entry not found or not fresh: ${key}`);
    }

    const parsedData = parseJsonField<unknown>(row.data);
    if (parsedData === undefined) {
        throw new Error(`Moltbook cache payload is invalid: ${key}`);
    }
    return parser(parsedData);
}

/**
 * Fetches cached moltbook home.
 * @returns Fetch cached moltbook home result.
 */
export function fetchCachedMoltbookHome(): MoltbookHome {
    return fetchCachedMoltbookEntry("moltbook.home", parseMoltbookHome);
}

/**
 * Fetches cached moltbook profile.
 * @returns Fetch cached moltbook profile result.
 */
export function fetchCachedMoltbookProfile(): MoltbookProfileCache {
    return fetchCachedMoltbookEntry("moltbook.profile", parseMoltbookProfileCache);
}

/**
 * Fetches cached moltbook my content.
 * @returns Fetch cached moltbook my content result.
 */
export function fetchCachedMoltbookMyContent(): MoltbookContent {
    return fetchCachedMoltbookEntry("moltbook.my-content", parseMoltbookContent);
}

/**
 * Fetches cached moltbook feed.
 * @param sort Sort value.
 * @returns Fetch cached moltbook feed result.
 */
export function fetchCachedMoltbookFeed(sort: "hot" | "new"): MoltbookFeed {
    return fetchCachedMoltbookEntry(`moltbook.feed.${sort}`, parseMoltbookFeed);
}
