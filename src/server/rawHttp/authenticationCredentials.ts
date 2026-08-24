import { CookieMap } from "bun";
import * as v from "valibot";

import { parseOpaqueToken, type ParsedOpaqueToken } from "../shared/opaqueToken.ts";

/** Browser session cookie read only by the server. */
export const dashboardSessionCookieName = "__Host-mira_dashboard_session";
/** Password-first login cookie read only by the server. */
export const dashboardPendingLoginCookieName = "__Host-mira_dashboard_pending_login";

const bearerHeaderSchema = v.pipe(
    v.string("Automation authorization header is invalid"),
    v.maxLength(128, "Automation authorization header is invalid"),
    v.regex(
        /^bearer [0-9a-f]{32}\.[0-9a-f]{64}$/iu,
        "Automation authorization header is invalid"
    ),
    v.transform((header) => header.slice("Bearer ".length))
);

type CookieValue =
    | { readonly kind: "absent" }
    | { readonly kind: "invalid" }
    | { readonly kind: "present"; readonly value: string };

/** Parsed credential passed from the raw HTTP adapter to identity resolution. */
export type RawAuthenticationCredential =
    | { readonly kind: "anonymous" }
    | { readonly kind: "automation"; readonly token: ParsedOpaqueToken }
    | { readonly kind: "invalid" }
    | { readonly kind: "session"; readonly token: ParsedOpaqueToken };

/** Parsed password-first login credential carried independently of a browser session. */
export type PendingLoginCredential =
    | { readonly kind: "absent" }
    | { readonly kind: "invalid" }
    | { readonly kind: "present"; readonly token: ParsedOpaqueToken };

/** Complete credential state extracted once at the raw request boundary. */
export interface AuthenticationHttpCredentials {
    readonly authentication: RawAuthenticationCredential;
    readonly isAmbiguous: boolean;
    readonly pendingLogin: PendingLoginCredential;
}

function readSingleCookie(request: Request, name: string): CookieValue {
    const header = request.headers.get("cookie");
    if (header === null) return { kind: "absent" };

    const matchingParts = header.split(";").filter((part) => {
        const normalized = part.trim();
        const separator = normalized.indexOf("=");
        const cookieName =
            separator === -1 ? normalized : normalized.slice(0, separator).trim();
        return cookieName === name;
    });
    if (matchingParts.length > 1) return { kind: "invalid" };
    if (matchingParts.length === 0) return { kind: "absent" };
    if (!matchingParts[0]?.includes("=")) return { kind: "invalid" };

    try {
        const value = new CookieMap(header).get(name);
        return value === null ? { kind: "invalid" } : { kind: "present", value };
    } catch {
        return { kind: "invalid" };
    }
}

function pendingLoginCredential(cookie: CookieValue): PendingLoginCredential {
    if (cookie.kind !== "present") return cookie;
    const token = parseOpaqueToken(cookie.value, "pending-login");
    return token === undefined ? { kind: "invalid" } : { kind: "present", token };
}

function automationCredential(authorization: string): RawAuthenticationCredential {
    const bearer = v.safeParse(bearerHeaderSchema, authorization, {
        abortEarly: true,
    });
    if (!bearer.success) return { kind: "invalid" };
    const token = parseOpaqueToken(bearer.output, "automation");
    return token === undefined ? { kind: "invalid" } : { kind: "automation", token };
}

function sessionCredential(cookie: CookieValue): RawAuthenticationCredential {
    if (cookie.kind === "absent") return { kind: "anonymous" };
    if (cookie.kind === "invalid") return cookie;
    const token = parseOpaqueToken(cookie.value, "session");
    return token === undefined ? { kind: "invalid" } : { kind: "session", token };
}

/**
 * Parses authorization and Dashboard cookies exactly once before context creation.
 * Any automation header combined with either Dashboard cookie is ambiguous, including
 * malformed and duplicate cookie occurrences.
 * @param request Raw HTTP request entering the application boundary.
 * @returns Parsed authentication and pending-login credential state.
 */
export function readAuthenticationHttpCredentials(
    request: Request
): AuthenticationHttpCredentials {
    const authorization = request.headers.get("authorization");
    const sessionCookie = readSingleCookie(request, dashboardSessionCookieName);
    const pendingLoginCookie = readSingleCookie(request, dashboardPendingLoginCookieName);
    const isAmbiguous =
        authorization !== null &&
        (sessionCookie.kind !== "absent" || pendingLoginCookie.kind !== "absent");
    let authentication: RawAuthenticationCredential;
    if (isAmbiguous) {
        authentication = { kind: "invalid" };
    } else if (authorization === null) {
        authentication = sessionCredential(sessionCookie);
    } else {
        authentication = automationCredential(authorization);
    }
    return Object.freeze({
        authentication,
        isAmbiguous,
        pendingLogin: pendingLoginCredential(pendingLoginCookie),
    });
}
