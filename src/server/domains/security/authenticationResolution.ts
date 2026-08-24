import * as v from "valibot";

import {
    requestAuthenticationSchema,
    type RequestAuthentication,
} from "../../../contracts/security.ts";
import { timestampMillisecondsSchema } from "../../../shared/dateTime.ts";

const authenticationLeaseSchema = v.strictObject({
    expiresAtMs: timestampMillisecondsSchema("Authentication lease expiry is invalid"),
    revalidate: v.function("Authentication lease revalidator is invalid"),
});

const authenticationResolutionSchema = v.pipe(
    v.strictObject({
        authentication: requestAuthenticationSchema,
        lease: v.optional(authenticationLeaseSchema),
    }),
    v.check(
        (resolution) =>
            (resolution.authentication.kind === "authenticated") ===
            (resolution.lease !== undefined),
        "Authenticated resolutions require exactly one lease"
    )
);

/** Revalidation boundary retained by long-lived authenticated requests. */
export interface AuthenticationLease {
    readonly expiresAtMs: number;
    revalidate(signal: AbortSignal): Promise<unknown>;
}

/** Validated identity plus the lease required only for authenticated requests. */
export interface AuthenticationResolution {
    readonly authentication: RequestAuthentication;
    readonly lease?: AuthenticationLease;
}

/**
 * Validates and freezes output from the injected request authenticator.
 * Function results are parsed again after every lease revalidation.
 * @param input Untrusted authentication-service output.
 * @returns Request identity and optional long-lived-request lease.
 */
export function parseAuthenticationResolution(input: unknown): AuthenticationResolution {
    const parsed = v.parse(authenticationResolutionSchema, input);
    const lease = parsed.lease;
    return Object.freeze({
        authentication: parsed.authentication,
        ...(lease && {
            lease: Object.freeze({
                expiresAtMs: lease.expiresAtMs,
                revalidate: (signal: AbortSignal) =>
                    Promise.resolve(lease.revalidate(signal)),
            }),
        }),
    });
}
