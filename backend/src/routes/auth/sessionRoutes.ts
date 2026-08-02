import type { Server } from "bun";

import type { AuthSessionResponse } from "../../../../contracts/auth.ts";
import { deleteSession } from "../../auth/sessionRepository.ts";
import { isBootstrapRequired } from "../../auth/userRepository.ts";
import {
    authSession,
    clearPendingLoginCookie,
    clearSessionCookie,
    json,
    sessionIdFromCookie,
    withCookies,
} from "../../http/core.ts";

/**
 * Creates current-session inspection and logout routes.
 * @returns Authentication route handlers.
 */
export function createAuthSessionRoutes() {
    return {
        "/api/auth/session": {
            GET: (request: Request, server: Server<unknown>) => {
                void server;
                const needsBootstrap = isBootstrapRequired();
                const session = needsBootstrap ? undefined : authSession(request);
                const user = session
                    ? { id: session.id, username: session.username }
                    : undefined;
                return json({
                    authenticated: Boolean(session),
                    isBootstrapRequired: needsBootstrap,
                    ...(session && {
                        session: {
                            authMethod: session.authMethod,
                            expiresAt: session.expiresAt,
                            lastSeenAt: session.lastSeenAt,
                            mfaEnabled: session.mfaEnabled,
                            ...(session.mfaVerifiedAt && {
                                mfaVerifiedAt: session.mfaVerifiedAt,
                            }),
                            // This is only the non-secret selector; the validator stays in the cookie.
                            sessionId: session.sessionId,
                        },
                    }),
                    ...(user && { user }),
                } satisfies AuthSessionResponse);
            },
        },
        "/api/auth/logout": {
            POST: (request: Request, server: Server<unknown>) => {
                const sessionId = sessionIdFromCookie(request);
                if (sessionId) {
                    deleteSession(sessionId);
                }
                return withCookies(json({ isOk: true }), [
                    clearSessionCookie(request, server),
                    clearPendingLoginCookie(request, server),
                ]);
            },
        },
    } as const;
}
