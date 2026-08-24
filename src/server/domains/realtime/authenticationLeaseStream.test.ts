import { describe, expect, test } from "bun:test";

import { TRPCError } from "@trpc/server";
import { addMinutes, getTime } from "date-fns";

import type { AuthenticatedPrincipal } from "../../../contracts/security.ts";
import { captureFailure, rejectOnAbort } from "../../test/support/promise.ts";
import type {
    AuthenticationLease,
    AuthenticationResolution,
} from "../security/authenticationResolution.ts";
import { createRealtimeAuthenticationLease } from "./authenticationLeaseStream.ts";

const credentialId = "019fc968-1a9b-7771-9f1b-d5b863b0e7b4";
const otherCredentialId = "019fc968-1a9b-7772-af1b-d5b863b0e7b4";
const reportsPrincipal: AuthenticatedPrincipal = {
    authorizationVersion: 1,
    authenticatorId: credentialId,
    capabilities: ["reports:read"],
    id: "test-automation",
    kind: "automation",
};
const reportsSessionPrincipal: AuthenticatedPrincipal = {
    authorizationVersion: 1,
    authenticatorId: "a".repeat(32),
    capabilities: ["reports:read"],
    id: "019fc968-1a9b-7770-8f1b-d5b863b0e7b4",
    kind: "session",
};

function futureExpiry(): number {
    return getTime(addMinutes(new Date(), 1));
}

function authenticatedResolution(
    principal: AuthenticatedPrincipal,
    lease: AuthenticationLease
): AuthenticationResolution {
    return { authentication: { kind: "authenticated", principal }, lease };
}

function stableLease(): AuthenticationLease {
    const resolution: AuthenticationResolution = {
        authentication: { kind: "authenticated", principal: reportsPrincipal },
        lease: {
            expiresAtMs: futureExpiry(),
            revalidate: () => Promise.resolve(resolution),
        },
    };
    return resolution.lease as AuthenticationLease;
}

describe("realtime authentication lease", () => {
    test("authorizes topics before the Effect runtime opens a stream", () => {
        expect(() =>
            createRealtimeAuthenticationLease({
                lease: stableLease(),
                principal: { ...reportsPrincipal, capabilities: [] },
                topics: ["monitoring.reports"],
            })
        ).toThrow(TRPCError);
    });

    test("renews with the same authenticator and updated authorization", async () => {
        const controller = new AbortController();
        let observedSignal: AbortSignal | undefined;
        const nextLease = stableLease();
        const initialLease: AuthenticationLease = {
            expiresAtMs: futureExpiry(),
            revalidate(signal) {
                observedSignal = signal;
                return Promise.resolve(
                    authenticatedResolution(
                        { ...reportsPrincipal, authorizationVersion: 2 },
                        nextLease
                    )
                );
            },
        };
        const renewable = createRealtimeAuthenticationLease({
            lease: initialLease,
            principal: reportsPrincipal,
            topics: ["monitoring.reports"],
        });

        const renewed = await renewable.renew(controller.signal);

        expect(observedSignal).toBe(controller.signal);
        expect(renewed.expiresAtMs).toBe(nextLease.expiresAtMs);
    });

    test.each([
        {
            initialPrincipal: { ...reportsPrincipal },
            name: "invalid authentication",
            result: { authentication: { kind: "invalid" } },
        },
        {
            initialPrincipal: { ...reportsPrincipal },
            name: "changed authenticator id",
            result: authenticatedResolution(
                { ...reportsPrincipal, authenticatorId: otherCredentialId },
                stableLease()
            ),
        },
        {
            initialPrincipal: { ...reportsPrincipal },
            name: "changed principal id",
            result: authenticatedResolution(
                { ...reportsPrincipal, id: "other-automation" },
                stableLease()
            ),
        },
        {
            initialPrincipal: { ...reportsPrincipal },
            name: "changed principal kind",
            result: authenticatedResolution(reportsSessionPrincipal, stableLease()),
        },
        {
            initialPrincipal: { ...reportsPrincipal, authorizationVersion: 2 },
            name: "rolled-back authorization version",
            result: authenticatedResolution(
                { ...reportsPrincipal, authorizationVersion: 1 },
                stableLease()
            ),
        },
    ] as const)("fails closed for $name", async ({ initialPrincipal, result }) => {
        const renewable = createRealtimeAuthenticationLease({
            lease: {
                expiresAtMs: futureExpiry(),
                revalidate: () => Promise.resolve(result),
            },
            principal: initialPrincipal,
            topics: ["monitoring.reports"],
        });
        const failure = await captureFailure(() =>
            renewable.renew(new AbortController().signal)
        );

        expect(failure).toBeInstanceOf(TRPCError);
        expect((failure as TRPCError).code).toBe("UNAUTHORIZED");
    });

    test("reauthorizes capabilities on every renewal", async () => {
        const renewable = createRealtimeAuthenticationLease({
            lease: {
                expiresAtMs: futureExpiry(),
                revalidate: () =>
                    Promise.resolve(
                        authenticatedResolution(
                            {
                                ...reportsPrincipal,
                                authorizationVersion: 2,
                                capabilities: [],
                            },
                            stableLease()
                        )
                    ),
            },
            principal: reportsPrincipal,
            topics: ["monitoring.reports"],
        });
        const failure = await captureFailure(() =>
            renewable.renew(new AbortController().signal)
        );

        expect(failure).toBeInstanceOf(TRPCError);
        expect((failure as TRPCError).code).toBe("FORBIDDEN");
    });

    test("passes cancellation to the underlying revalidator", async () => {
        const controller = new AbortController();
        let observedSignal: AbortSignal | undefined;
        const renewable = createRealtimeAuthenticationLease({
            lease: {
                expiresAtMs: futureExpiry(),
                revalidate: (signal) => {
                    observedSignal = signal;
                    return rejectOnAbort(signal, "Authentication revalidation aborted");
                },
            },
            principal: reportsPrincipal,
            topics: ["monitoring.reports"],
        });

        const pending = renewable.renew(controller.signal);
        controller.abort();
        const failure = await captureFailure(() => pending);

        expect(observedSignal).toBe(controller.signal);
        expect(failure).toBe(controller.signal.reason);
    });
});
