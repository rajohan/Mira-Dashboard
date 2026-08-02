import type { Server } from "bun";

import { didRevokeUserSession, revokeUserSessions } from "../../auth/sessionService.ts";
import {
    clearPendingLoginCookie,
    clearSessionCookie,
    json,
    withCookies,
} from "../../http/core.ts";
import { type ParametersRequest, routeFailureResponse } from "../../http/routeSupport.ts";
import {
    canManageFactors,
    recentVerificationRequired,
    requestContext,
    securityEvent,
} from "./support.ts";

const SESSION_ID_PATTERN = /^[a-f0-9]{32}$/u;

/**
 * Creates account-session revocation routes.
 * @returns Account-security route handlers.
 */
export function createAccountSessionRoutes() {
    return {
        "/api/account/security/sessions/:sessionId": {
            DELETE: (
                request: ParametersRequest<"sessionId">,
                server: Server<unknown>
            ) => {
                const context = requestContext(request);
                if (context instanceof Response) return context;
                if (!canManageFactors(context.session)) {
                    return recentVerificationRequired();
                }
                const sessionId = request.params.sessionId;
                if (!SESSION_ID_PATTERN.test(sessionId)) {
                    return routeFailureResponse({
                        context: "account-security",
                        message: "Invalid session identifier",
                        status: 400,
                    });
                }
                if (!didRevokeUserSession(context.session.id, sessionId)) {
                    return routeFailureResponse({
                        context: "account-security",
                        message: "Session not found",
                        status: 404,
                    });
                }
                securityEvent("account.session-revoked", sessionId, {
                    current: sessionId === context.session.sessionId,
                });
                return sessionId === context.session.sessionId
                    ? withCookies(json({ isOk: true, loggedOut: true }), [
                          clearSessionCookie(request, server),
                      ])
                    : json({ isOk: true, loggedOut: false });
            },
        },

        "/api/account/security/sessions/revoke-others": {
            POST: (request: Request, server: Server<unknown>) => {
                void server;
                const context = requestContext(request);
                if (context instanceof Response) return context;
                if (!canManageFactors(context.session)) {
                    return recentVerificationRequired();
                }
                const revoked = revokeUserSessions(
                    context.session.id,
                    context.session.sessionId
                );
                securityEvent("account.sessions-revoked", String(context.session.id), {
                    currentPreserved: true,
                    revoked,
                });
                return json({ isOk: true, revoked });
            },
        },

        "/api/account/security/sessions/revoke-all": {
            POST: (request: Request, server: Server<unknown>) => {
                const context = requestContext(request);
                if (context instanceof Response) return context;
                if (!canManageFactors(context.session)) {
                    return recentVerificationRequired();
                }
                const revoked = revokeUserSessions(context.session.id);
                securityEvent("account.sessions-revoked", String(context.session.id), {
                    currentPreserved: false,
                    revoked,
                });
                return withCookies(json({ isOk: true, revoked }), [
                    clearSessionCookie(request, server),
                    clearPendingLoginCookie(request, server),
                ]);
            },
        },
    } as const;
}
