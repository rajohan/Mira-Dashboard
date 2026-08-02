import type { Server } from "bun";

import {
    parseMfaCodeRequest,
    parseWebAuthnAuthenticationRequest,
} from "../../../../contracts/accountSecurity/requests.ts";
import { json } from "../../http/core.ts";
import { routeFailureResponse } from "../../http/routeSupport.ts";
import {
    authenticationThrottleResponse,
    parseAuthenticationResponse,
} from "../../services/authenticationRequest.ts";
import {
    clearAuthenticationFailures,
    recordAuthenticationFailure,
} from "../../services/authenticationThrottle.ts";
import { verifyRecoveryCodeForUser } from "../../services/multiFactorAuth/recoveryCodeService.ts";
import { verifyTotpForUser } from "../../services/multiFactorAuth/totpFactorService.ts";
import {
    normalizedCode,
    readSecurityBody,
    requestContext,
    rotateAfterVerification,
} from "./support.ts";
import type { AccountSecurityWebAuthnDependencies } from "./webAuthnDependencies.ts";

/**
 * Creates TOTP, recovery-code, and WebAuthn step-up routes.
 * @returns Account-security route handlers.
 */
export function createAccountSecurityStepUpRoutes(
    webAuthn: AccountSecurityWebAuthnDependencies
) {
    return {
        "/api/account/security/step-up/totp": {
            POST: async (request: Request, server: Server<unknown>) => {
                const context = requestContext(request);
                if (context instanceof Response) return context;
                const throttled = authenticationThrottleResponse(
                    request,
                    "second-factor",
                    context.session.id
                );
                if (throttled) return throttled;
                const body = await readSecurityBody(request, parseMfaCodeRequest);
                if (body instanceof Response) return body;
                const code = normalizedCode(body.code);
                const factor = code
                    ? await verifyTotpForUser(context.session.id, code)
                    : undefined;
                if (!factor) {
                    recordAuthenticationFailure("second-factor", context.session.id);
                    return routeFailureResponse({
                        context: "account-security",
                        message: "Invalid authenticator code",
                        status: 400,
                    });
                }
                clearAuthenticationFailures("second-factor", context.session.id);
                return rotateAfterVerification(request, server, context, "totp");
            },
        },

        "/api/account/security/step-up/recovery": {
            POST: async (request: Request, server: Server<unknown>) => {
                const context = requestContext(request);
                if (context instanceof Response) return context;
                const throttled = authenticationThrottleResponse(
                    request,
                    "second-factor",
                    context.session.id
                );
                if (throttled) return throttled;
                const body = await readSecurityBody(request, parseMfaCodeRequest);
                if (body instanceof Response) return body;
                const code = normalizedCode(body.code);
                const verified =
                    code && (await verifyRecoveryCodeForUser(context.session.id, code));
                if (!verified) {
                    recordAuthenticationFailure("second-factor", context.session.id);
                    return routeFailureResponse({
                        context: "account-security",
                        message: "Invalid recovery code",
                        status: 400,
                    });
                }
                clearAuthenticationFailures("second-factor", context.session.id);
                return rotateAfterVerification(request, server, context, "recovery");
            },
        },

        "/api/account/security/step-up/webauthn/options": {
            POST: async (request: Request, server: Server<unknown>) => {
                void server;
                const context = requestContext(request);
                if (context instanceof Response) return context;
                const throttled = authenticationThrottleResponse(
                    request,
                    "second-factor",
                    context.session.id
                );
                if (throttled) return throttled;
                try {
                    const options = await webAuthn.createAuthenticationOptions({
                        purpose: "step-up",
                        sessionId: context.session.sessionId,
                        userId: context.session.id,
                    });
                    return json({ options });
                } catch {
                    return routeFailureResponse({
                        context: "account-security",
                        message: "Security-key verification is unavailable",
                        status: 503,
                    });
                }
            },
        },

        "/api/account/security/step-up/webauthn/verify": {
            POST: async (request: Request, server: Server<unknown>) => {
                const context = requestContext(request);
                if (context instanceof Response) return context;
                const throttled = authenticationThrottleResponse(
                    request,
                    "second-factor",
                    context.session.id
                );
                if (throttled) return throttled;
                const body = await readSecurityBody(
                    request,
                    parseWebAuthnAuthenticationRequest
                );
                if (body instanceof Response) return body;
                const response = parseAuthenticationResponse(body.response);
                const factor = response
                    ? await webAuthn.verifyAuthentication(
                          {
                              purpose: "step-up",
                              sessionId: context.session.sessionId,
                              userId: context.session.id,
                          },
                          response
                      )
                    : undefined;
                if (!factor) {
                    recordAuthenticationFailure("second-factor", context.session.id);
                    return routeFailureResponse({
                        context: "account-security",
                        message: "Invalid security-key response",
                        status: 400,
                    });
                }
                clearAuthenticationFailures("second-factor", context.session.id);
                return rotateAfterVerification(request, server, context, "webauthn");
            },
        },
    } as const;
}
