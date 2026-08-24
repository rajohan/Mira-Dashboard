import { browserSessionAbsoluteDurationMs } from "../domains/security/authenticationPolicy.ts";
import { dashboardSessionCookieName } from "../domains/security/requestAuthentication.ts";
import { parseOpaqueToken } from "../shared/opaqueToken.ts";

const browserSessionMaximumAgeSeconds = browserSessionAbsoluteDurationMs / 1000;
const browserSessionCookieAttributes = "Path=/; Secure; HttpOnly; SameSite=Strict";

/** Appends the one-time browser-session token as a hardened host cookie. */
export function appendDashboardSessionCookie(
    responseHeaders: Headers,
    token: string
): void {
    if (parseOpaqueToken(token, "session") === undefined) {
        throw new Error("Cannot serialize an invalid Dashboard session token");
    }
    responseHeaders.append(
        "set-cookie",
        `${dashboardSessionCookieName}=${token}; Max-Age=${browserSessionMaximumAgeSeconds}; ${browserSessionCookieAttributes}`
    );
}

/** Appends an immediately expired browser-session cookie. */
export function appendClearedDashboardSessionCookie(responseHeaders: Headers): void {
    responseHeaders.append(
        "set-cookie",
        `${dashboardSessionCookieName}=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; ${browserSessionCookieAttributes}`
    );
}
