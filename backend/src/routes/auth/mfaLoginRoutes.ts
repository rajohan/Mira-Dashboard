import type { Server } from "bun";

import {
    parseLoginMfaCodeRequest,
    parseLoginWebAuthnRequest,
} from "../../../../contracts/auth.ts";
import { json } from "../../http/core.ts";
import { routeFailureResponse } from "../../http/routeSupport.ts";
import { createStructuredLogger } from "../../lib/structuredLogger.ts";
import {
    authenticationThrottleResponse,
    normalizeSecondFactorCode,
    parseAuthenticationResponse,
} from "../../services/authenticationRequest.ts";
import {
    clearAuthenticationFailures,
    recordAuthenticationFailure,
} from "../../services/authenticationThrottle.ts";
import { verifyRecoveryCodeForUser } from "../../services/multiFactorAuth/recoveryCodeService.ts";
import { verifyTotpForUser } from "../../services/multiFactorAuth/totpFactorService.ts";
import {
    completePendingLogin,
    failedSecondFactor,
    pendingLoginForMethod,
} from "./pendingLoginResponses.ts";
import { readAuthBody } from "./request.ts";
import type { AuthWebAuthnDependencies } from "./webAuthnDependencies.ts";

const logger = createStructuredLogger("auth");

/**
 * Creates TOTP, recovery-code, and WebAuthn login completion routes.
 * @returns Authentication route handlers.
 */
export function createMfaLoginRoutes(webAuthn: AuthWebAuthnDependencies) {
    return {
        "/api/auth/login/totp": {
            POST: async (request: Request, server: Server<unknown>) => {
                const attempt = pendingLoginForMethod(request, "totp");
                if (!attempt) {
                    return failedSecondFactor(request, server);
                }
                const throttled = authenticationThrottleResponse(
                    request,
                    "second-factor",
                    attempt.pending.userId
                );
                if (throttled) return throttled;
                const body = await readAuthBody(request, parseLoginMfaCodeRequest);
                if (body instanceof Response) return body;
                const code = normalizeSecondFactorCode(body.code);
                const factor = code
                    ? await verifyTotpForUser(attempt.pending.userId, code)
                    : undefined;
                if (!factor) {
                    recordAuthenticationFailure("second-factor", attempt.pending.userId);
                    return failedSecondFactor(request, server, attempt.pending);
                }
                clearAuthenticationFailures("second-factor", attempt.pending.userId);
                return completePendingLogin(request, server, attempt.token, "totp");
            },
        },

        "/api/auth/login/recovery": {
            POST: async (request: Request, server: Server<unknown>) => {
                const attempt = pendingLoginForMethod(request, "recovery");
                if (!attempt) {
                    return failedSecondFactor(request, server);
                }
                const throttled = authenticationThrottleResponse(
                    request,
                    "second-factor",
                    attempt.pending.userId
                );
                if (throttled) return throttled;
                const body = await readAuthBody(request, parseLoginMfaCodeRequest);
                if (body instanceof Response) return body;
                const code = normalizeSecondFactorCode(body.code);
                const verified =
                    code &&
                    (await verifyRecoveryCodeForUser(attempt.pending.userId, code));
                if (!verified) {
                    recordAuthenticationFailure("second-factor", attempt.pending.userId);
                    return failedSecondFactor(request, server, attempt.pending);
                }
                clearAuthenticationFailures("second-factor", attempt.pending.userId);
                return completePendingLogin(request, server, attempt.token, "recovery");
            },
        },

        "/api/auth/login/webauthn/options": {
            POST: async (request: Request, server: Server<unknown>) => {
                const attempt = pendingLoginForMethod(request, "webauthn");
                if (!attempt) {
                    return failedSecondFactor(request, server);
                }
                const throttled = authenticationThrottleResponse(
                    request,
                    "second-factor",
                    attempt.pending.userId
                );
                if (throttled) return throttled;
                try {
                    const options = await webAuthn.createAuthenticationOptions({
                        pendingLoginId: attempt.pending.pendingLoginId,
                        purpose: "login",
                        userId: attempt.pending.userId,
                    });
                    return json({ options });
                } catch (error) {
                    logger.error("auth.webauthn_login_options_failed", { error });
                    return routeFailureResponse({
                        context: "auth",
                        message: "Security-key authentication is unavailable",
                        status: 503,
                    });
                }
            },
        },

        "/api/auth/login/webauthn/verify": {
            POST: async (request: Request, server: Server<unknown>) => {
                const attempt = pendingLoginForMethod(request, "webauthn");
                if (!attempt) {
                    return failedSecondFactor(request, server);
                }
                const throttled = authenticationThrottleResponse(
                    request,
                    "second-factor",
                    attempt.pending.userId
                );
                if (throttled) return throttled;
                const body = await readAuthBody(request, parseLoginWebAuthnRequest);
                if (body instanceof Response) return body;
                const response = parseAuthenticationResponse(body.response);
                const factor = response
                    ? await webAuthn.verifyAuthentication(
                          {
                              pendingLoginId: attempt.pending.pendingLoginId,
                              purpose: "login",
                              userId: attempt.pending.userId,
                          },
                          response
                      )
                    : undefined;
                if (!factor) {
                    recordAuthenticationFailure("second-factor", attempt.pending.userId);
                    return failedSecondFactor(request, server, attempt.pending);
                }
                clearAuthenticationFailures("second-factor", attempt.pending.userId);
                return completePendingLogin(request, server, attempt.token, "webauthn");
            },
        },
    } as const;
}
