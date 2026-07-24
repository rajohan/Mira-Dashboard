const UNKNOWN_FORWARDED_CLIENT = "unknown";

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
