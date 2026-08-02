import type { Server } from "bun";

import type { DashboardMfaMethod } from "../../../../contracts/accountSecurity.ts";
import type { AuthLoginResponse } from "../../../../contracts/auth.ts";
import { createSession } from "../../auth/sessionService.ts";
import {
    clearPendingLoginCookie,
    json,
    pendingLoginFromCookie,
    sessionCookie,
    withCookies,
} from "../../http/core.ts";
import { routeFailureResponse } from "../../http/routeSupport.ts";
import {
    consumePendingLogin,
    getPendingLogin,
    type PendingLogin,
    recordPendingLoginFailure,
} from "../../services/multiFactorAuth/pendingLoginService.ts";

export function pendingLoginForMethod(
    request: Request,
    method: DashboardMfaMethod
): { pending: PendingLogin; token: string } | undefined {
    const token = pendingLoginFromCookie(request);
    const pending = token ? getPendingLogin(token) : undefined;
    return token && pending?.methods.includes(method) ? { pending, token } : undefined;
}

export function failedSecondFactor(
    request: Request,
    server: Server<unknown>,
    pending?: PendingLogin
): Response {
    if (pending) {
        recordPendingLoginFailure(pending.pendingLoginId);
    }
    const response = routeFailureResponse({
        context: "auth",
        message: "Invalid or expired authentication attempt",
        status: 401,
    });
    return pending
        ? response
        : withCookies(response, [clearPendingLoginCookie(request, server)]);
}

export function completePendingLogin(
    request: Request,
    server: Server<unknown>,
    pendingToken: string,
    method: DashboardMfaMethod
): Response {
    const pending = consumePendingLogin(pendingToken);
    if (!pending) {
        return failedSecondFactor(request, server);
    }
    const timestamp = new Date().toISOString();
    const sessionId = createSession(pending.userId, {
        authMethod: method,
        elevatedAt: timestamp,
        elevatedMethod: method,
        mfaVerifiedAt: timestamp,
        userAgent: pending.userAgent,
    });
    return withCookies(
        json({
            authenticated: true,
            mfaRequired: false,
            user: { id: pending.userId, username: pending.username },
        } satisfies AuthLoginResponse),
        [
            sessionCookie(request, server, sessionId),
            clearPendingLoginCookie(request, server),
        ]
    );
}
