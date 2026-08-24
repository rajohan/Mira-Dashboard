import * as v from "valibot";

import { hasNoUnicodeControlOrFormat } from "../../shared/validation.ts";

const chatSessionSearchSchema = v.pipe(
    v.string(),
    v.minLength(1),
    v.maxLength(512),
    v.regex(/^\S(?:[\s\S]*\S)?$/u),
    v.check(hasNoUnicodeControlOrFormat)
);

const chatRouteSearchSchema = v.strictObject({
    session: v.optional(chatSessionSearchSchema),
});

/** Validated URL selection owned by `/chat`. */
export type ChatRouteSearch = v.InferOutput<typeof chatRouteSearchSchema>;

/**
 * Drops malformed or unknown search values without making an external chat URL fatal.
 * @param search Untrusted search object parsed by TanStack Router.
 * @returns One optional bounded session key.
 */
export function parseChatRouteSearch(search: unknown): ChatRouteSearch {
    const session =
        typeof search === "object" &&
        search !== null &&
        !Array.isArray(search) &&
        "session" in search &&
        typeof search.session === "string"
            ? search.session
            : undefined;
    const parsed = v.safeParse(
        chatRouteSearchSchema,
        session === undefined ? {} : { session }
    );
    return parsed.success ? parsed.output : {};
}

/**
 * Chooses a valid URL selection or the provider-marked stable default.
 * @param requestedKey Validated key requested by the current URL.
 * @param sessions Current bounded session inventory.
 * @param canFallbackFromMissingRequest Whether absence in this inventory is authoritative.
 * @returns Exact selected key, or an empty string when no sessions exist.
 */
export function resolveChatSessionKey(
    requestedKey: string | undefined,
    sessions: readonly Readonly<{ isDefault: boolean; key: string }>[],
    canFallbackFromMissingRequest: boolean
): string {
    if (
        requestedKey !== undefined &&
        sessions.some((session) => session.key === requestedKey)
    ) {
        return requestedKey;
    }
    if (requestedKey !== undefined && !canFallbackFromMissingRequest) return "";
    return sessions.find((session) => session.isDefault)?.key ?? sessions[0]?.key ?? "";
}
