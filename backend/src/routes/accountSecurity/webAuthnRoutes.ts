import type { Server } from "bun";

import type { WebAuthnRegistrationResponse } from "../../../../contracts/accountSecurity.ts";
import { parseWebAuthnRegistrationRequest } from "../../../../contracts/accountSecurity.ts";
import { hasRecentMfaVerification } from "../../auth/sessionService.ts";
import { json } from "../../http/core.ts";
import { type ParametersRequest, routeFailureResponse } from "../../http/routeSupport.ts";
import { normalizeFactorLabel } from "../../services/multiFactorAuth/factorIdentity.ts";
import { didRemoveWebAuthnCredential } from "../../services/webAuthn/service.ts";
import {
    canManageFactors,
    credentialAuditTargetId,
    readSecurityBody,
    recentVerificationRequired,
    registrationResponse,
    requestContext,
    securityEvent,
    upgradeAfterFirstFactor,
} from "./support.ts";
import type { AccountSecurityWebAuthnDependencies } from "./webAuthnDependencies.ts";

/**
 * Creates WebAuthn credential enrollment and removal routes.
 * @returns Account-security route handlers.
 */
export function createAccountWebAuthnRoutes(
    webAuthn: AccountSecurityWebAuthnDependencies
) {
    return {
        "/api/account/security/webauthn/register/options": {
            POST: async (request: Request, server: Server<unknown>) => {
                void server;
                const context = requestContext(request);
                if (context instanceof Response) return context;
                if (!canManageFactors(context.session)) {
                    return recentVerificationRequired();
                }
                try {
                    const options = await webAuthn.createRegistrationOptions(
                        {
                            purpose: "registration",
                            sessionId: context.session.sessionId,
                            userId: context.session.id,
                        },
                        context.session.username
                    );
                    return json({ options });
                } catch {
                    return routeFailureResponse({
                        context: "account-security",
                        message: "Security-key enrollment is unavailable",
                        status: 503,
                    });
                }
            },
        },

        "/api/account/security/webauthn/register/verify": {
            POST: async (request: Request, server: Server<unknown>) => {
                const context = requestContext(request);
                if (context instanceof Response) return context;
                if (!canManageFactors(context.session)) {
                    return recentVerificationRequired();
                }
                const body = await readSecurityBody(
                    request,
                    parseWebAuthnRegistrationRequest
                );
                if (body instanceof Response) return body;
                let label: string;
                try {
                    label = normalizeFactorLabel(body.label, "Security key");
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
                const response = registrationResponse(body.response);
                const registration = response
                    ? await webAuthn.verifyRegistration(
                          {
                              purpose: "registration",
                              sessionId: context.session.sessionId,
                              userId: context.session.id,
                          },
                          response,
                          label
                      )
                    : undefined;
                if (!registration) {
                    return routeFailureResponse({
                        context: "account-security",
                        message: "Invalid security-key response",
                        status: 400,
                    });
                }
                securityEvent(
                    "account.security-key-added",
                    credentialAuditTargetId(registration.credential.id),
                    {
                        label: registration.credential.label,
                    }
                );
                const responseBody = {
                    credential: registration.credential,
                    isOk: true,
                    recoveryCodes: registration.confirmation.recoveryCodes,
                    sessionRotated: registration.confirmation.enabledMfa,
                } satisfies WebAuthnRegistrationResponse;
                return registration.confirmation.enabledMfa
                    ? upgradeAfterFirstFactor(
                          request,
                          server,
                          context,
                          "webauthn",
                          responseBody
                      )
                    : json(responseBody);
            },
        },

        "/api/account/security/webauthn/:credentialId": {
            DELETE: (
                request: ParametersRequest<"credentialId">,
                server: Server<unknown>
            ) => {
                void server;
                const context = requestContext(request);
                if (context instanceof Response) return context;
                if (!hasRecentMfaVerification(context.session)) {
                    return recentVerificationRequired();
                }
                const credentialId = request.params.credentialId;
                if (!didRemoveWebAuthnCredential(context.session.id, credentialId)) {
                    return routeFailureResponse({
                        context: "account-security",
                        message:
                            "Credential not found or cannot remove the final second factor",
                        status: 409,
                    });
                }
                securityEvent(
                    "account.security-key-removed",
                    credentialAuditTargetId(credentialId)
                );
                return json({ isOk: true });
            },
        },
    } as const;
}
