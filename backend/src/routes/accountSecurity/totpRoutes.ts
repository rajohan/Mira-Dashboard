import type { Server } from "bun";

import type { TotpConfirmationResponse } from "../../../../contracts/accountSecurity.ts";
import {
    parseTotpConfirmationRequest,
    parseTotpEnrollmentRequest,
} from "../../../../contracts/accountSecurity.ts";
import { hasRecentMfaVerification } from "../../auth/sessionService.ts";
import { json } from "../../http/core.ts";
import { type ParametersRequest, routeFailureResponse } from "../../http/routeSupport.ts";
import { authenticationThrottleResponse } from "../../services/authenticationRequest.ts";
import {
    clearAuthenticationFailures,
    recordAuthenticationFailure,
} from "../../services/authenticationThrottle.ts";
import {
    confirmTotpEnrollment,
    createTotpEnrollment,
    didRemoveTotpFactor,
    normalizeFactorId,
    normalizeFactorLabel,
} from "../../services/multiFactorAuth/factorService.ts";
import {
    canManageFactors,
    normalizedCode,
    readSecurityBody,
    recentVerificationRequired,
    requestContext,
    securityEvent,
    upgradeAfterFirstFactor,
} from "./support.ts";

/**
 * Creates TOTP enrollment, confirmation, and removal routes.
 * @returns Account-security route handlers.
 */
export function createAccountTotpRoutes() {
    return {
        "/api/account/security/totp/setup": {
            POST: async (request: Request, server: Server<unknown>) => {
                void server;
                const context = requestContext(request);
                if (context instanceof Response) return context;
                if (!canManageFactors(context.session)) {
                    return recentVerificationRequired();
                }
                const throttled = authenticationThrottleResponse(
                    request,
                    "second-factor",
                    context.session.id
                );
                if (throttled) return throttled;
                const body = await readSecurityBody(request, parseTotpEnrollmentRequest);
                if (body instanceof Response) return body;
                let label: string;
                try {
                    label = normalizeFactorLabel(body.label, "Authenticator app");
                } catch (error) {
                    return routeFailureResponse({
                        context: "account-security",
                        message:
                            error instanceof Error
                                ? error.message
                                : "Invalid factor label",
                        status: 400,
                    });
                }
                const enrollment = createTotpEnrollment(
                    context.session.id,
                    context.session.username,
                    label
                );
                securityEvent("account.totp-enrollment-started", enrollment.factorId, {
                    label: enrollment.label,
                });
                return json({ enrollment }, { status: 201 });
            },
        },

        "/api/account/security/totp/confirm": {
            POST: async (request: Request, server: Server<unknown>) => {
                const context = requestContext(request);
                if (context instanceof Response) return context;
                if (!canManageFactors(context.session)) {
                    return recentVerificationRequired();
                }
                const throttled = authenticationThrottleResponse(
                    request,
                    "second-factor",
                    context.session.id
                );
                if (throttled) return throttled;
                const body = await readSecurityBody(
                    request,
                    parseTotpConfirmationRequest
                );
                if (body instanceof Response) return body;
                let factorId: string;
                try {
                    factorId = normalizeFactorId(body.factorId);
                } catch {
                    return routeFailureResponse({
                        context: "account-security",
                        message: "Invalid factor identifier",
                        status: 400,
                    });
                }
                const code = normalizedCode(body.code);
                const confirmation = code
                    ? await confirmTotpEnrollment(context.session.id, factorId, code)
                    : undefined;
                if (!confirmation) {
                    recordAuthenticationFailure("second-factor", context.session.id);
                    return routeFailureResponse({
                        context: "account-security",
                        message: "Invalid authenticator code",
                        status: 400,
                    });
                }
                clearAuthenticationFailures("second-factor", context.session.id);
                securityEvent("account.totp-added", factorId);
                const responseBody = {
                    factorId,
                    isOk: true,
                    recoveryCodes: confirmation.recoveryCodes,
                    sessionRotated: confirmation.enabledMfa,
                } satisfies TotpConfirmationResponse;
                return confirmation.enabledMfa
                    ? upgradeAfterFirstFactor(
                          request,
                          server,
                          context,
                          "totp",
                          responseBody
                      )
                    : json(responseBody);
            },
        },

        "/api/account/security/totp/:factorId": {
            DELETE: (request: ParametersRequest<"factorId">, server: Server<unknown>) => {
                void server;
                const context = requestContext(request);
                if (context instanceof Response) return context;
                if (!hasRecentMfaVerification(context.session)) {
                    return recentVerificationRequired();
                }
                let factorId: string;
                try {
                    factorId = normalizeFactorId(request.params.factorId);
                } catch {
                    return routeFailureResponse({
                        context: "account-security",
                        message: "Invalid factor identifier",
                        status: 400,
                    });
                }
                if (!didRemoveTotpFactor(context.session.id, factorId)) {
                    return routeFailureResponse({
                        context: "account-security",
                        message:
                            "Factor not found or cannot remove the final second factor",
                        status: 409,
                    });
                }
                securityEvent("account.totp-removed", factorId);
                return json({ isOk: true });
            },
        },
    } as const;
}
