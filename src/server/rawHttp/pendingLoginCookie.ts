import { parseOpaqueToken } from "../shared/opaqueToken.ts";
import { pendingLoginLifetimeMs } from "../shared/pendingLoginPolicy.ts";
import { dashboardPendingLoginCookieName } from "./authenticationCredentials.ts";

const pendingLoginMaximumAgeSeconds = pendingLoginLifetimeMs / 1000;
const pendingLoginCookieAttributes = "Path=/; Secure; HttpOnly; SameSite=Strict";

/** Appends a one-time password-first login credential as a host-isolated cookie. */
export function appendPendingLoginCookie(responseHeaders: Headers, token: string): void {
    if (parseOpaqueToken(token, "pending-login") === undefined) {
        throw new Error("Cannot serialize an invalid pending-login token");
    }
    responseHeaders.append(
        "set-cookie",
        `${dashboardPendingLoginCookieName}=${token}; Max-Age=${pendingLoginMaximumAgeSeconds}; ${pendingLoginCookieAttributes}`
    );
}

/** Appends an immediately expired password-first login cookie. */
export function appendClearedPendingLoginCookie(responseHeaders: Headers): void {
    responseHeaders.append(
        "set-cookie",
        `${dashboardPendingLoginCookieName}=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; ${pendingLoginCookieAttributes}`
    );
}
