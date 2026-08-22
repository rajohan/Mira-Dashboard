import * as v from "valibot";

const loginTokenSearchSchema = v.pipe(v.string(), v.maxLength(1024));
const loginRouteSearchSchema = v.strictObject({
    resetToken: v.optional(loginTokenSearchSchema),
    verifyEmailToken: v.optional(loginTokenSearchSchema),
});

export type LoginRouteSearch = v.InferOutput<typeof loginRouteSearchSchema>;

/**
 * Keeps only authentication tokens accepted by the public login route.
 * @param search Untrusted search values parsed by TanStack Router.
 * @returns A normalized login search object.
 */
export function parseLoginRouteSearch(search: unknown): LoginRouteSearch {
    const resetToken =
        typeof search === "object" &&
        search !== null &&
        "resetToken" in search &&
        typeof search.resetToken === "string"
            ? search.resetToken
            : undefined;
    const verifyEmailToken =
        typeof search === "object" &&
        search !== null &&
        "verifyEmailToken" in search &&
        typeof search.verifyEmailToken === "string"
            ? search.verifyEmailToken
            : undefined;
    const parsed = v.safeParse(loginRouteSearchSchema, {
        ...(resetToken === undefined ? {} : { resetToken }),
        ...(verifyEmailToken === undefined ? {} : { verifyEmailToken }),
    });
    return parsed.success ? parsed.output : {};
}
