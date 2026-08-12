import { compareAsc, differenceInMilliseconds, getTime } from "date-fns";

import {
    browserSessionUserAgentMaximumLength,
    type AuthSessionSummary,
    type AuthUser,
} from "../../../contracts/auth.ts";
import type { AuthenticationMethod } from "../../../contracts/security.ts";
import type { GeneratedOpaqueToken } from "../../shared/opaqueToken.ts";
import type { SecurityAuditActor } from "./audit.ts";
import type {
    BrowserSessionRecord,
    BrowserSessionWriter,
    SecurityUserRecord,
} from "./securityPersistenceTypes.ts";

export interface AuthenticatedBrowserIdentity {
    readonly sessionId: string;
    readonly userId: string;
}

export interface AuthenticationRequestMetadata {
    readonly clientSourceId: string;
    readonly requestId: string;
    readonly signal?: AbortSignal;
    readonly userAgent?: string;
}

export interface BrowserSessionIssueInput {
    readonly authenticatedAt: Date;
    readonly authenticationMethod: AuthenticationMethod;
    readonly createdAt: Date;
    readonly expiresAt: Date;
    readonly mfaVerifiedAt: Date | null;
    readonly passwordVerifiedAt: Date;
    readonly token: GeneratedOpaqueToken;
    readonly user: SecurityUserRecord;
    readonly userAgent?: string;
}

export function authUser(user: SecurityUserRecord): AuthUser {
    return Object.freeze({ id: user.id, username: user.username });
}

export function authSession(
    session: BrowserSessionRecord,
    currentSessionId: string
): AuthSessionSummary {
    return Object.freeze({
        authenticatedAtMs: getTime(session.authenticatedAt),
        authMethod: session.authMethod,
        createdAtMs: getTime(session.createdAt),
        expiresAtMs: getTime(session.expiresAt),
        id: session.id,
        isCurrent: session.id === currentSessionId,
        lastSeenAtMs: getTime(session.lastSeenAt),
        ...(session.userAgent !== null && { userAgent: session.userAgent }),
    });
}

export function sessionActor(
    identity: AuthenticatedBrowserIdentity
): SecurityAuditActor & {
    readonly authenticatorId: string;
    readonly kind: "user";
} {
    return {
        authenticatorId: identity.sessionId,
        id: identity.userId,
        kind: "user",
    };
}

function normalizeBrowserUserAgent(userAgent: string | undefined): string | null {
    const normalized = userAgent
        ?.replaceAll(/\p{Cc}/gu, " ")
        .trim()
        .replaceAll(/\s+/gu, " ");
    if (!normalized) return null;
    const codePoints: string[] = [];
    for (const codePoint of normalized) {
        if (codePoints.length >= browserSessionUserAgentMaximumLength) break;
        codePoints.push(codePoint);
    }
    return codePoints.join("");
}

export function browserSessionIsActive(
    session: BrowserSessionRecord,
    now: Date,
    sessionIdleDurationMs: number
): boolean {
    return (
        compareAsc(session.createdAt, now) <= 0 &&
        compareAsc(session.lastSeenAt, now) <= 0 &&
        compareAsc(session.expiresAt, now) > 0 &&
        differenceInMilliseconds(now, session.lastSeenAt) < sessionIdleDurationMs
    );
}

export function insertBrowserSession(
    writer: BrowserSessionWriter,
    input: BrowserSessionIssueInput
): BrowserSessionRecord {
    return writer.insertSession({
        authenticatedAt: input.authenticatedAt,
        authenticationVersion: input.user.authenticationVersion,
        authMethod: input.authenticationMethod,
        createdAt: input.createdAt,
        expiresAt: input.expiresAt,
        id: input.token.prefix,
        lastSeenAt: input.createdAt,
        mfaVerifiedAt: input.mfaVerifiedAt,
        passwordVerifiedAt: input.passwordVerifiedAt,
        userAgent: normalizeBrowserUserAgent(input.userAgent),
        userId: input.user.id,
        validatorHash: input.token.validatorHash,
    });
}
