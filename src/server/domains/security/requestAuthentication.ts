import {
    addMilliseconds,
    compareAsc,
    getTime,
    isValid,
    min,
    minutesToMilliseconds,
    secondsToMilliseconds,
    toDate,
} from "date-fns";
import { maxTime } from "date-fns/constants";
import * as v from "valibot";

import {
    applicationCapabilities,
    type RequestAuthentication,
} from "../../../contracts/security.ts";
import { nonnegativeDateAction } from "../../../shared/dateTime.ts";
import {
    parseSchemaWithRangeError,
    positiveSafeIntegerSchema,
} from "../../../shared/validation.ts";
import type { RawAuthenticationCredential } from "../../rawHttp/authenticationCredentials.ts";
import { areSha256DigestsEqual, sha256Hex } from "../../shared/crypto.ts";
import {
    browserSessionIdleDurationDefaultMs,
    browserSessionIdleDurationMaximumMs,
    browserSessionIdleDurationMinimumMs,
} from "./authenticationPolicy.ts";
import type { AuthenticationResolution } from "./authenticationResolution.ts";
import type {
    AutomationAuthenticationRecord,
    RequestAuthenticationRepository,
    SessionAuthenticationRecord,
} from "./requestAuthenticationRepository.ts";

const defaultAuthenticationLeaseDurationMs = secondsToMilliseconds(30);
const minimumAuthenticationLeaseDurationMs = secondsToMilliseconds(1);
const maximumAuthenticationLeaseDurationMs = minutesToMilliseconds(5);
const dummyValidatorHash = sha256Hex("mira-dashboard:authentication-dummy:v1");

const authenticationLeaseDurationSchema = v.pipe(
    positiveSafeIntegerSchema("Authentication lease duration is invalid"),
    v.minValue(
        minimumAuthenticationLeaseDurationMs,
        "Authentication lease duration is invalid"
    ),
    v.maxValue(
        maximumAuthenticationLeaseDurationMs,
        "Authentication lease duration is invalid"
    )
);
const sessionIdleDurationSchema = v.pipe(
    positiveSafeIntegerSchema("Session idle duration is invalid"),
    v.minValue(browserSessionIdleDurationMinimumMs, "Session idle duration is invalid"),
    v.maxValue(browserSessionIdleDurationMaximumMs, "Session idle duration is invalid")
);
const nowSchema = v.pipe(
    v.date("Authentication clock is invalid"),
    nonnegativeDateAction()
);
export interface RequestAuthenticator {
    authenticate(credential: RawAuthenticationCredential): AuthenticationResolution;
}

export interface RequestAuthenticatorOptions {
    readonly authenticationLeaseDurationMs?: number;
    readonly now?: () => Date;
    readonly repository: RequestAuthenticationRepository;
    readonly sessionIdleDurationMs?: number;
}

function unauthenticatedResolution(
    kind: "anonymous" | "invalid"
): AuthenticationResolution {
    return Object.freeze({ authentication: Object.freeze({ kind }) });
}

function authenticatedResolution(
    authentication: Extract<RequestAuthentication, { readonly kind: "authenticated" }>,
    expiresAtMs: number,
    revalidate: () => AuthenticationResolution
): AuthenticationResolution {
    return Object.freeze({
        authentication,
        lease: Object.freeze({
            expiresAtMs,
            revalidate: (signal: AbortSignal) =>
                signal.aborted
                    ? Promise.reject(
                          signal.reason instanceof Error
                              ? signal.reason
                              : new Error("Authentication revalidation aborted", {
                                    cause: signal.reason,
                                })
                      )
                    : Promise.resolve(revalidate()),
        }),
    });
}

function durationExpiry(now: Date, durationMs: number): Date {
    const expiry = addMilliseconds(now, durationMs);
    return isValid(expiry) ? expiry : toDate(maxTime);
}

/**
 * Creates strict single-credential request authentication with bounded revalidation leases.
 * Authentication and revalidation are read-only: SSE and polling never touch idle activity.
 * @param options Repository, validated durations, and replaceable clock.
 * @returns Request authenticator suitable for the tRPC context composition boundary.
 */
export function createRequestAuthenticator(
    options: RequestAuthenticatorOptions
): RequestAuthenticator {
    const authenticationLeaseDurationMs = parseSchemaWithRangeError(
        authenticationLeaseDurationSchema,
        options.authenticationLeaseDurationMs ?? defaultAuthenticationLeaseDurationMs
    );
    const sessionIdleDurationMs = parseSchemaWithRangeError(
        sessionIdleDurationSchema,
        options.sessionIdleDurationMs ?? browserSessionIdleDurationDefaultMs
    );
    const now = () => v.parse(nowSchema, options.now?.() ?? new Date());

    const sessionResolution = (
        record: SessionAuthenticationRecord | undefined,
        expectedValidatorHash: string
    ): AuthenticationResolution => {
        const checkedAt = now();
        const validatorMatches = areSha256DigestsEqual(
            record?.validatorHash ?? dummyValidatorHash,
            expectedValidatorHash
        );
        if (
            record === undefined ||
            !validatorMatches ||
            record.userDisabledAt !== null ||
            record.authenticationVersion !== record.userAuthenticationVersion ||
            compareAsc(record.createdAt, checkedAt) > 0 ||
            compareAsc(record.lastSeenAt, checkedAt) > 0 ||
            (record.mfaVerifiedAt !== null &&
                compareAsc(record.mfaVerifiedAt, checkedAt) > 0) ||
            (record.userMfaEnabledAt !== null &&
                (record.mfaVerifiedAt === null ||
                    compareAsc(record.mfaVerifiedAt, record.userMfaEnabledAt) < 0))
        ) {
            return unauthenticatedResolution("invalid");
        }

        const idleExpiresAt = durationExpiry(record.lastSeenAt, sessionIdleDurationMs);
        const validUntil = min([record.expiresAt, idleExpiresAt]);
        if (compareAsc(validUntil, checkedAt) <= 0) {
            return unauthenticatedResolution("invalid");
        }
        const leaseExpiresAt = min([
            validUntil,
            durationExpiry(checkedAt, authenticationLeaseDurationMs),
        ]);
        const authentication = Object.freeze({
            kind: "authenticated" as const,
            principal: Object.freeze({
                authorizationVersion: record.userAuthenticationVersion,
                capabilities: Object.freeze([...applicationCapabilities]),
                authenticatorId: record.id,
                id: record.userId,
                kind: "session" as const,
            }),
        });
        return authenticatedResolution(authentication, getTime(leaseExpiresAt), () =>
            sessionResolution(
                options.repository.findSessionById(record.id),
                expectedValidatorHash
            )
        );
    };

    const automationResolution = (
        record: AutomationAuthenticationRecord | undefined,
        expectedValidatorHash: string
    ): AuthenticationResolution => {
        const validatorMatches = areSha256DigestsEqual(
            record?.validatorHash ?? dummyValidatorHash,
            expectedValidatorHash
        );
        const checkedAt = now();
        if (
            record === undefined ||
            !validatorMatches ||
            record.principalDisabledAt !== null ||
            record.credentialRevokedAt !== null ||
            compareAsc(record.credentialCreatedAt, checkedAt) > 0 ||
            compareAsc(record.principalCreatedAt, checkedAt) > 0 ||
            compareAsc(record.principalUpdatedAt, checkedAt) > 0 ||
            (record.credentialExpiresAt !== null &&
                compareAsc(record.credentialExpiresAt, checkedAt) <= 0)
        ) {
            return unauthenticatedResolution("invalid");
        }

        const leaseCandidates = [
            durationExpiry(checkedAt, authenticationLeaseDurationMs),
        ];
        if (record.credentialExpiresAt !== null) {
            leaseCandidates.push(record.credentialExpiresAt);
        }
        const authentication = Object.freeze({
            kind: "authenticated" as const,
            principal: Object.freeze({
                authorizationVersion: record.principalAuthorizationVersion,
                capabilities: record.capabilities,
                authenticatorId: record.credentialId,
                id: record.principalId,
                kind: "automation" as const,
            }),
        });
        return authenticatedResolution(
            authentication,
            getTime(min(leaseCandidates)),
            () =>
                automationResolution(
                    options.repository.findAutomationByCredentialId(record.credentialId),
                    expectedValidatorHash
                )
        );
    };

    return Object.freeze({
        authenticate(credential: RawAuthenticationCredential) {
            switch (credential.kind) {
                case "anonymous":
                case "invalid": {
                    return unauthenticatedResolution(credential.kind);
                }
                case "automation": {
                    return automationResolution(
                        options.repository.findAutomationByPrefix(
                            credential.token.prefix
                        ),
                        credential.token.validatorHash
                    );
                }
                case "session": {
                    return sessionResolution(
                        options.repository.findSessionById(credential.token.prefix),
                        credential.token.validatorHash
                    );
                }
            }
        },
    });
}
