import * as v from "valibot";

const safeRequestMethodSchema = v.picklist(["GET", "HEAD", "OPTIONS"]);
const allowedBrowserFetchSiteSchema = v.picklist(["none", "same-origin"]);
const browserOriginSchema = v.pipe(
    v.string("Dashboard browser origin is invalid"),
    v.url("Dashboard browser origin is invalid"),
    v.check((value) => {
        const url = new URL(value);
        return (
            (url.protocol === "http:" || url.protocol === "https:") &&
            url.origin === value
        );
    }, "Dashboard browser origin is invalid")
);

/**
 * Validates one explicit canonical browser origin at server composition time.
 * @param value Untrusted server configuration value.
 * @returns Canonical HTTP or HTTPS origin.
 */
export function parseBrowserOrigin(value: unknown): string {
    return v.parse(browserOriginSchema, value);
}

function hasAllowedOrigin(
    value: string,
    request: Request,
    allowedBrowserOrigin?: string
): boolean {
    const origin = v.safeParse(browserOriginSchema, value, { abortEarly: true });
    return (
        origin.success &&
        origin.output === (allowedBrowserOrigin ?? new URL(request.url).origin)
    );
}

/**
 * Rejects browser-originated requests outside the exact Dashboard origin.
 * Direct clients without browser provenance remain available to bearer auth.
 * @param request Raw request before authentication or handler execution.
 * @param allowedBrowserOrigin Explicit public origin when a trusted proxy terminates TLS.
 * @returns Whether the request may cross the tRPC trust boundary.
 */
export function isAllowedRequestSource(
    request: Request,
    allowedBrowserOrigin?: string
): boolean {
    const hasSafeMethod = v.safeParse(safeRequestMethodSchema, request.method).success;
    const origin = request.headers.get("origin");
    const fetchSite = request.headers.get("sec-fetch-site");

    if (origin === null && fetchSite === null) return true;
    if (!hasSafeMethod && origin === null) return false;
    if (origin !== null && !hasAllowedOrigin(origin, request, allowedBrowserOrigin)) {
        return false;
    }

    return (
        fetchSite === null ||
        v.safeParse(allowedBrowserFetchSiteSchema, fetchSite).success
    );
}
