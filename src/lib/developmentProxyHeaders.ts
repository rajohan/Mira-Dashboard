const UNKNOWN_FORWARDED_CLIENT = "unknown";

function developmentUrlProtocol(value: string): string {
    const origin = new URL(value);
    if (origin.protocol !== "http:" && origin.protocol !== "https:") {
        throw new TypeError("Development proxy origin must use HTTP or HTTPS");
    }
    return origin.protocol.slice(0, -1);
}

/** Validates the external origin at startup and falls back to each local request URL. */
export function createDevelopmentForwardedProtocolResolver(
    publicOrigin: string | undefined
): (requestUrl: string) => string {
    const externalProtocol = publicOrigin
        ? developmentUrlProtocol(publicOrigin)
        : undefined;
    return (requestUrl) => externalProtocol || developmentUrlProtocol(requestUrl);
}

/** Keeps only the isolated dev session cookies before proxying into PR backend code. */
export function developmentCookieHeader(
    cookieHeader: string | null,
    namespace: string
): string | undefined {
    if (!cookieHeader) return undefined;
    const allowedNames = new Set([`${namespace}_pending_login`, `${namespace}_session`]);
    const cookies = cookieHeader
        .split(";")
        .map((cookie) => cookie.trim())
        .filter((cookie) => allowedNames.has(cookie.split("=", 1)[0] || ""));
    return cookies.length > 0 ? cookies.join("; ") : undefined;
}

export function addForwardedClientHeaders(
    headers: Headers,
    clientAddress: string | undefined,
    protocol: string
): void {
    const forwardedClient = clientAddress || UNKNOWN_FORWARDED_CLIENT;
    headers.set("x-forwarded-for", forwardedClient);
    headers.set("x-real-ip", forwardedClient);
    headers.set("x-forwarded-proto", protocol);
}
