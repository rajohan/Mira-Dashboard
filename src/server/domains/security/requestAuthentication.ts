import { CookieMap } from "bun";
import {
    addMilliseconds,
    compareAsc,
    getTime,
    hoursToMilliseconds,
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
import { areSha256DigestsEqual, sha256Hex } from "../../shared/crypto.ts";
import { parseOpaqueToken, type ParsedOpaqueToken } from "../../shared/opaqueToken.ts";
import type { AuthenticationResolution } from "./authenticationResolution.ts";
import type {
    AuthenticationRepository,
    AutomationAuthenticationRecord,
    SessionAuthenticationRecord,
} from "./repository.ts";

/** Browser session cookie read only by the server. */
export const dashboardSessionCookieName = "mira_dashboard_session";

const defaultAuthenticationLeaseDurationMs = secondsToMilliseconds(30);
const minimumAuthenticationLeaseDurationMs = secondsToMilliseconds(1);
const maximumAuthenticationLeaseDurationMs = minutesToMilliseconds(5);
const defaultSessionIdleDurationMs = minutesToMilliseconds(30);
const minimumSessionIdleDurationMs = minutesToMilliseconds(5);
const maximumSessionIdleDurationMs = hoursToMilliseconds(24);
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
    v.minValue(minimumSessionIdleDurationMs, "Session idle duration is invalid"),
    v.maxValue(maximumSessionIdleDurationMs, "Session idle duration is invalid")
);
const nowSchema = v.pipe(
    v.date("Authentication clock is invalid"),
    nonnegativeDateAction()
);
const bearerHeaderSchema = v.pipe(
    v.string("Automation authorization header is invalid"),
    v.maxLength(128, "Automation authorization header is invalid"),
    v.regex(
        /^bearer [0-9a-f]{32}\.[0-9a-f]{64}$/iu,
        "Automation authorization header is invalid"
    ),
    v.transform((header) => header.slice("Bearer ".length))
);

type CookieValue =
    | { readonly kind: "absent" }
    | { readonly kind: "invalid" }
    | { readonly kind: "present"; readonly value: string };

export interface RequestAuthenticator {
    authenticate(request: Request): AuthenticationResolution;
}

export interface RequestAuthenticatorOptions {
    readonly authenticationLeaseDurationMs?: number;
    readonly now?: () => Date;
    readonly repository: AuthenticationRepository;
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

function readSingleCookie(request: Request, name: string): CookieValue {
    const header = request.headers.get("cookie");
    if (header === null) return { kind: "absent" };

    const occurrences = header.split(";").filter((part) => {
        const normalized = part.trim();
        const separator = normalized.indexOf("=");
        return separator !== -1 && normalized.slice(0, separator) === name;
    }).length;
    if (occurrences > 1) return { kind: "invalid" };
    if (occurrences === 0) return { kind: "absent" };

    try {
        const value = new CookieMap(header).get(name);
        return value === null ? { kind: "invalid" } : { kind: "present", value };
    } catch {
        return { kind: "invalid" };
    }
}

/**
 * Creates strict bearer-first request authentication with bounded revalidation leases.
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
        options.sessionIdleDurationMs ?? defaultSessionIdleDurationMs
    );
    const now = () => v.parse(nowSchema, options.now?.() ?? new Date());

    const sessionResolution = (
        record: SessionAuthenticationRecord | undefined,
        expectedValidatorHash: string
    ): AuthenticationResolution => {
        const validatorMatches = areSha256DigestsEqual(
            record?.validatorHash ?? dummyValidatorHash,
            expectedValidatorHash
        );
        if (
            record === undefined ||
            !validatorMatches ||
            record.userDisabledAt !== null ||
            record.authenticationVersion !== record.userAuthenticationVersion
        ) {
            return unauthenticatedResolution("invalid");
        }

        const checkedAt = now();
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

    const authenticateAutomation = (authorization: string): AuthenticationResolution => {
        const bearer = v.safeParse(bearerHeaderSchema, authorization, {
            abortEarly: true,
        });
        if (!bearer.success) return unauthenticatedResolution("invalid");
        const token = parseOpaqueToken(bearer.output, "automation");
        if (token === undefined) return unauthenticatedResolution("invalid");
        return automationResolution(
            options.repository.findAutomationByPrefix(token.prefix),
            token.validatorHash
        );
    };

    const authenticateSession = (token: ParsedOpaqueToken): AuthenticationResolution =>
        sessionResolution(
            options.repository.findSessionById(token.prefix),
            token.validatorHash
        );

    return Object.freeze({
        authenticate(request: Request) {
            const authorization = request.headers.get("authorization");
            if (authorization !== null) {
                return authenticateAutomation(authorization);
            }

            const cookie = readSingleCookie(request, dashboardSessionCookieName);
            if (cookie.kind === "absent") {
                return unauthenticatedResolution("anonymous");
            }
            if (cookie.kind === "invalid") {
                return unauthenticatedResolution("invalid");
            }
            const token = parseOpaqueToken(cookie.value, "session");
            return token === undefined
                ? unauthenticatedResolution("invalid")
                : authenticateSession(token);
        },
    });
}
