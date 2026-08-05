import { describe, expect, test } from "bun:test";

import { TRPCError } from "@trpc/server";
import { addMinutes, getTime } from "date-fns";

import type { AuthenticatedPrincipal } from "../../../contracts/security.ts";
import { captureFailure } from "../../test/support/promise.ts";
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

    test("fails closed for invalid, changed, or rolled-back identities", async () => {
        const nextLease = stableLease();
        const cases: readonly unknown[] = [
            { authentication: { kind: "invalid" } },
            authenticatedResolution(
                { ...reportsPrincipal, authenticatorId: otherCredentialId },
                nextLease
            ),
            authenticatedResolution(
                { ...reportsPrincipal, authorizationVersion: 1 },
                nextLease
            ),
        ];

        for (const [index, result] of cases.entries()) {
            const principal =
                index === 2
                    ? { ...reportsPrincipal, authorizationVersion: 2 }
                    : reportsPrincipal;
            const renewable = createRealtimeAuthenticationLease({
                lease: {
                    expiresAtMs: futureExpiry(),
                    revalidate: () => Promise.resolve(result),
                },
                principal,
                topics: ["monitoring.reports"],
            });
            const failure = await captureFailure(() =>
                renewable.renew(new AbortController().signal)
            );

            expect(failure).toBeInstanceOf(TRPCError);
            expect((failure as TRPCError).code).toBe("UNAUTHORIZED");
        }
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
                    return new Promise((_resolve, reject) => {
                        const rejectWithAbortReason = (): void => {
                            const reason: unknown = signal.reason;
                            reject(
                                reason instanceof Error
                                    ? reason
                                    : new Error("Authentication revalidation aborted", {
                                          cause: reason,
                                      })
                            );
                        };
                        signal.addEventListener("abort", rejectWithAbortReason, {
                            once: true,
                        });
                    });
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
