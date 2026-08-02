import type { Server } from "bun";

import type { AuthLoginResponse } from "../../../../contracts/auth.ts";
import { parseLoginCredentialsRequest } from "../../../../contracts/auth.ts";
import { createSession, deleteSession } from "../../auth/sessionService.ts";
import {
    findUserByUsername,
    isBootstrapRequired,
    verifyPassword,
} from "../../auth/userRepository.ts";
import {
    clearPendingLoginCookie,
    clearSessionCookie,
    json,
    pendingLoginCookie,
    sessionCookie,
    sessionIdFromCookie,
    withCookies,
} from "../../http/core.ts";
import { routeFailureResponse } from "../../http/routeSupport.ts";
import {
    authenticationThrottleResponse,
    normalizeLoginPassword,
    normalizeLoginUsername,
} from "../../services/authenticationRequest.ts";
import {
    clearAuthenticationFailures,
    recordAuthenticationFailure,
} from "../../services/authenticationThrottle.ts";
import { mfaMethodsForUser } from "../../services/multiFactorAuth/factorInventory.ts";
import { createPendingLogin } from "../../services/multiFactorAuth/pendingLoginService.ts";
import { readAuthBody } from "./request.ts";

// A non-secret Argon2id verifier keeps unknown-user and wrong-password work comparable.
const UNKNOWN_USER_PASSWORD_HASH =
    "$argon2id$v=19$m=65536,t=2,p=1$f3HFQG8vpt61lN+oOECsgjKF/kekaeFRsKlTi+dn71Y$Xlpldr0SHTMjbwyeJR9V352PLnlLWm9L6pHPUMS+9mQ";

/**
 * Creates username/password login and MFA handoff routes.
 * @returns Authentication route handlers.
 */
export function createPasswordLoginRoutes() {
    return {
        "/api/auth/login": {
            POST: async (request: Request, server: Server<unknown>) => {
                if (isBootstrapRequired()) {
                    return routeFailureResponse({
                        context: "auth",
                        message: "Create the first user before logging in",
                        status: 409,
                    });
                }
                const body = await readAuthBody(request, parseLoginCredentialsRequest);
                if (body instanceof Response) return body;
                const username = normalizeLoginUsername(body.username);
                const password = normalizeLoginPassword(body.password);
                if (!username || !password) {
                    return routeFailureResponse({
                        context: "auth",
                        message: "Username and password are required",
                        status: 400,
                    });
                }
                const throttled = authenticationThrottleResponse(
                    request,
                    "login-password",
                    username
                );
                if (throttled) return throttled;
                const user = findUserByUsername(username);
                const isPasswordValid = await verifyPassword(
                    password,
                    user?.password_hash ?? UNKNOWN_USER_PASSWORD_HASH
                );
                if (!user || !isPasswordValid) {
                    recordAuthenticationFailure("login-password", username);
                    return routeFailureResponse({
                        context: "auth",
                        message: "Invalid username or password",
                        status: 401,
                    });
                }
                clearAuthenticationFailures("login-password", username);
                const existingSession = sessionIdFromCookie(request);
                if (existingSession) {
                    deleteSession(existingSession);
                }
                if (user.mfa_enabled_at) {
                    const methods = mfaMethodsForUser(user.id);
                    if (methods.length === 0) {
                        return routeFailureResponse({
                            context: "auth",
                            message: "Multi-factor authentication is unavailable",
                            status: 503,
                        });
                    }
                    const pendingLogin = createPendingLogin(
                        user.id,
                        methods,
                        request.headers.get("user-agent") ?? undefined
                    );
                    return withCookies(
                        json(
                            {
                                authenticated: false,
                                methods,
                                mfaRequired: true,
                                user: { username: user.username },
                            } satisfies AuthLoginResponse,
                            { status: 202 }
                        ),
                        [
                            pendingLoginCookie(request, server, pendingLogin),
                            clearSessionCookie(request, server),
                        ]
                    );
                }
                const sessionId = createSession(user.id, {
                    userAgent: request.headers.get("user-agent") ?? undefined,
                });
                return withCookies(
                    json({
                        authenticated: true,
                        mfaRequired: false,
                        user: { id: user.id, username: user.username },
                    } satisfies AuthLoginResponse),
                    [
                        sessionCookie(request, server, sessionId),
                        clearPendingLoginCookie(request, server),
                    ]
                );
            },
        },
    } as const;
}
