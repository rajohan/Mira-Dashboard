import { TRPCError } from "@trpc/server";

import type { AuthenticatedPrincipal } from "../../../contracts/security.ts";
import type { RenewableStreamLease } from "../../platform/realtime/renewableStreamLease.ts";
import {
    type AuthenticationLease,
    parseAuthenticationResolution,
} from "../security/authenticationResolution.ts";
import { authorizeRealtimeTopics } from "./transport.ts";

interface ActiveAuthenticationLease {
    readonly lease: AuthenticationLease;
    readonly principal: AuthenticatedPrincipal;
}

/** Inputs for a topic-bound authentication lease used by the Effect stream. */
export interface RealtimeAuthenticationLeaseOptions {
    readonly lease: AuthenticationLease;
    readonly principal: AuthenticatedPrincipal;
    readonly topics: readonly string[];
}

function authenticationExpiredError(): TRPCError {
    return new TRPCError({
        code: "UNAUTHORIZED",
        message: "Realtime authentication is no longer valid",
    });
}

function hasSameAuthenticator(
    previous: AuthenticatedPrincipal,
    next: AuthenticatedPrincipal
): boolean {
    return (
        previous.authenticatorId === next.authenticatorId &&
        previous.id === next.id &&
        previous.kind === next.kind
    );
}

function renewableAuthenticationLease(
    active: ActiveAuthenticationLease,
    topics: readonly string[]
): RenewableStreamLease {
    return Object.freeze({
        expiresAtMs: active.lease.expiresAtMs,
        async renew(signal: AbortSignal) {
            const resolution = parseAuthenticationResolution(
                await active.lease.revalidate(signal)
            );
            if (signal.aborted) throw signal.reason;
            if (resolution.authentication.kind !== "authenticated") {
                throw authenticationExpiredError();
            }

            const principal = resolution.authentication.principal;
            if (
                !hasSameAuthenticator(active.principal, principal) ||
                principal.authorizationVersion < active.principal.authorizationVersion ||
                resolution.lease === undefined
            ) {
                throw authenticationExpiredError();
            }
            authorizeRealtimeTopics(principal, topics);
            return renewableAuthenticationLease(
                { lease: resolution.lease, principal },
                topics
            );
        },
    });
}

/**
 * Binds one validated principal and topic set to a renewable platform lease.
 * Effect owns timing, pull races, interruption, and finalization in the existing
 * process ManagedRuntime; this adapter owns identity and capability decisions.
 * @param options Initial request principal, lease, and requested topics.
 * @returns A generic lease safe to compose with the Effect event stream.
 */
export function createRealtimeAuthenticationLease(
    options: RealtimeAuthenticationLeaseOptions
): RenewableStreamLease {
    authorizeRealtimeTopics(options.principal, options.topics);
    return renewableAuthenticationLease(
        { lease: options.lease, principal: options.principal },
        options.topics
    );
}
