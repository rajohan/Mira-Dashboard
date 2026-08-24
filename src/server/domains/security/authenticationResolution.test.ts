import { describe, expect, test } from "bun:test";

import { addMinutes, getTime } from "date-fns";

import { parseAuthenticationResolution } from "./authenticationResolution.ts";

const authenticated = {
    kind: "authenticated" as const,
    principal: {
        authorizationVersion: 1,
        authenticatorId: "019fc968-1a9b-7771-9f1b-d5b863b0e7b4",
        capabilities: ["reports:read" as const],
        id: "test-automation",
        kind: "automation" as const,
    },
};

describe("authentication resolution", () => {
    test("freezes one authenticated identity and its required lease", async () => {
        const revalidated = { authentication: { kind: "invalid" } };
        const expiresAtMs = getTime(addMinutes(new Date(), 1));
        const resolution = parseAuthenticationResolution({
            authentication: authenticated,
            lease: {
                expiresAtMs,
                revalidate: () => revalidated,
            },
        });

        expect(resolution.authentication).toEqual(authenticated);
        expect(await resolution.lease?.revalidate(new AbortController().signal)).toBe(
            revalidated
        );
        expect(Object.isFrozen(resolution)).toBe(true);
        expect(Object.isFrozen(resolution.authentication)).toBe(true);
        expect(Object.isFrozen(resolution.lease)).toBe(true);
    });

    test("requires a lease exactly when the request is authenticated", () => {
        const lease = {
            expiresAtMs: getTime(addMinutes(new Date(), 1)),
            revalidate: () => ({ authentication: { kind: "invalid" } }),
        };

        for (const candidate of [
            { authentication: authenticated },
            { authentication: { kind: "anonymous" }, lease },
            { authentication: { kind: "invalid" }, lease },
        ]) {
            expect(() => parseAuthenticationResolution(candidate)).toThrow();
        }
    });
});
