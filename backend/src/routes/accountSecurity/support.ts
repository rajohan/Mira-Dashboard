import type { RegistrationResponseJSON } from "@simplewebauthn/server";
import type { Server } from "bun";

import type { DashboardMfaMethod } from "../../../../contracts/accountSecurity/methods.ts";
import type { MfaStepUpResponse } from "../../../../contracts/accountSecurity/responses.ts";
import type { AccountSecuritySummary } from "../../../../contracts/accountSecurity/summary.ts";
import type { ContractParser } from "../../../../contracts/runtime.ts";
import { rotateSession } from "../../auth/sessionMutations.ts";
import {
    hasRecentMfaVerification,
    hasRecentPasswordVerification,
    recentAuthenticationTtlMs,
} from "../../auth/sessionPolicy.ts";
import { listUserSessions, revokeUserSessions } from "../../auth/sessionRepository.ts";
import { type AuthSession } from "../../auth/sessionTypes.ts";
import {
    authSession,
    clearSessionCookie,
    json,
    sessionCookie,
    sessionIdFromCookie,
    withCookies,
} from "../../http/core.ts";
import { currentRequestAuditContext } from "../../http/requestAuditContext.ts";
import { readApiJsonOrError, routeFailureResponse } from "../../http/routeSupport.ts";
import { writeAuditEvent } from "../../services/auditEvents.ts";
import { secretEncryptionKeyBytes } from "../../services/mfaCrypto.ts";
import { getMultiFactorSummary } from "../../services/multiFactorAuth/factorInventory.ts";
import { webAuthnConfig } from "../../services/webAuthn/service.ts";

export interface SecurityRequestContext {
    session: AuthSession;
    sessionToken: string;
}
export async function readSecurityBody<T>(
    request: Request,
    parser: ContractParser<T>
): Promise<Response | T> {
    return readApiJsonOrError(request, parser, {
        code: "invalid_account_security_request",
        context: "account-security.body",
        maxBytes: 256 * 1024,
        message: "Invalid request body",
    });
}

export function requestContext(request: Request): SecurityRequestContext | Response {
    const sessionToken = sessionIdFromCookie(request);
    const session = sessionToken ? authSession(request) : undefined;
    return sessionToken && session
        ? { session, sessionToken }
        : routeFailureResponse({
              context: "account-security",
              message: "Unauthorized",
              status: 401,
          });
}

export function normalizedCode(value: unknown): string | undefined {
    if (typeof value !== "string") return undefined;
    const normalized = value.trim();
    return normalized.length > 0 && normalized.length <= 128 ? normalized : undefined;
}

export function normalizedPassword(value: unknown): string | undefined {
    return typeof value === "string" && value.length > 0 && value.length <= 256
        ? value
        : undefined;
}

export function registrationResponse(
    value: unknown
): RegistrationResponseJSON | undefined {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return undefined;
    }
    const candidate = value as Partial<RegistrationResponseJSON>;
    return typeof candidate.id === "string" &&
        typeof candidate.rawId === "string" &&
        candidate.type === "public-key" &&
        candidate.response &&
        typeof candidate.response === "object"
        ? (candidate as RegistrationResponseJSON)
        : undefined;
}

export function recentVerificationRequired(): Response {
    return routeFailureResponse({
        code: "recent_verification_required",
        context: "account-security",
        message: "Recent verification is required",
        status: 403,
    });
}

export function canManageFactors(session: AuthSession): boolean {
    return session.mfaEnabled
        ? hasRecentMfaVerification(session)
        : hasRecentPasswordVerification(session);
}

export function securityEvent(
    action: string,
    targetId: string,
    metadata: Record<string, unknown> = {}
): void {
    const context = currentRequestAuditContext();
    if (!context) return;
    writeAuditEvent({
        actor: context.actor,
        action,
        metadata,
        outcome: "succeeded",
        requestId: context.requestId,
        targetId,
        targetType: "account-security",
    });
}

export function credentialAuditTargetId(credentialId: string): string {
    return credentialId.length <= 256
        ? credentialId
        : `sha256:${new Bun.CryptoHasher("sha256").update(credentialId).digest("hex")}`;
}

function recentUntil(timestamp: string | undefined): string | undefined {
    if (!timestamp) return undefined;
    const parsed = Date.parse(timestamp);
    return Number.isFinite(parsed)
        ? new Date(parsed + recentAuthenticationTtlMs()).toISOString()
        : undefined;
}

function recentRemainingMs(timestamp: string | undefined): number | undefined {
    if (!timestamp) return undefined;
    const parsed = Date.parse(timestamp);
    if (!Number.isFinite(parsed)) return undefined;
    const ttlMs = recentAuthenticationTtlMs();
    return Math.max(0, Math.min(ttlMs, parsed + ttlMs - Date.now()));
}

export function securitySummary(context: SecurityRequestContext): AccountSecuritySummary {
    const factors = getMultiFactorSummary(context.session.id);
    const totp = (() => {
        try {
            secretEncryptionKeyBytes();
            return { available: true as const };
        } catch {
            return {
                available: false as const,
                reason: "encryption_key_not_configured" as const,
            };
        }
    })();
    const webAuthn = (() => {
        try {
            const config = webAuthnConfig();
            return {
                available: true as const,
                rpId: config.rpId,
            };
        } catch {
            return {
                available: false as const,
                reason: "not_configured" as const,
            };
        }
    })();
    return {
        factors,
        recommendation: {
            minimumSecurityKeys: 2,
            needsBackupSecurityKey:
                factors.webAuthnCredentials.length > 0 &&
                factors.webAuthnCredentials.length < 2,
        },
        recentVerification: {
            mfa: hasRecentMfaVerification(context.session),
            mfaRemainingMs: recentRemainingMs(context.session.mfaVerifiedAt),
            mfaUntil: recentUntil(context.session.mfaVerifiedAt),
            password: hasRecentPasswordVerification(context.session),
            passwordUntil:
                context.session.elevatedMethod === "password"
                    ? recentUntil(context.session.elevatedAt)
                    : undefined,
        },
        sessions: listUserSessions(context.session.id, context.session.sessionId),
        totp,
        webAuthn,
    };
}

export function rotateAfterVerification(
    request: Request,
    server: Server<unknown>,
    context: SecurityRequestContext,
    method: DashboardMfaMethod
): Response {
    const timestamp = new Date().toISOString();
    const rotated = rotateSession(context.sessionToken, {
        elevatedAt: timestamp,
        elevatedMethod: method,
        mfaVerifiedAt: timestamp,
        userAgent: request.headers.get("user-agent") ?? context.session.userAgent,
    });
    if (!rotated) {
        return routeFailureResponse({
            context: "account-security",
            message: "Session rotation failed",
            status: 409,
        });
    }
    securityEvent("account.step-up", String(context.session.id), { method });
    return withCookies(
        json({
            isOk: true,
            method,
            verifiedAt: timestamp,
        } satisfies MfaStepUpResponse),
        [sessionCookie(request, server, rotated)]
    );
}

export function upgradeAfterFirstFactor(
    request: Request,
    server: Server<unknown>,
    context: SecurityRequestContext,
    method: "totp" | "webauthn",
    responseBody: Record<string, unknown>
): Response {
    const timestamp = new Date().toISOString();
    revokeUserSessions(context.session.id, context.session.sessionId);
    const rotated = rotateSession(context.sessionToken, {
        elevatedAt: timestamp,
        elevatedMethod: method,
        mfaVerifiedAt: timestamp,
        userAgent: request.headers.get("user-agent") ?? context.session.userAgent,
    });
    if (!rotated) {
        revokeUserSessions(context.session.id);
        return withCookies(
            routeFailureResponse({
                context: "account-security",
                message: "MFA was enabled, but the session upgrade failed; sign in again",
                status: 409,
            }),
            [clearSessionCookie(request, server)]
        );
    }
    return withCookies(json(responseBody), [sessionCookie(request, server, rotated)]);
}
