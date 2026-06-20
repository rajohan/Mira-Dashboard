import type { Server } from "bun";

import { type AuthUser, getAuthUserFromSessionId } from "./auth.ts";

const SESSION_COOKIE = "mira_dashboard_session";
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30;
const DEFAULT_JSON_BODY_LIMIT = 2 * 1024 * 1024;
const TRUSTED_PROXY_IPS = new Set(
    (process.env.MIRA_DASHBOARD_TRUSTED_PROXY_IPS || "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean)
);

type HeaderInput = Record<string, string> | Array<[string, string]>;

interface BunResponseInit {
    headers?: HeaderInput;
    status?: number;
    statusText?: string;
}

export function json(data: unknown, init: BunResponseInit = {}): Response {
    const headers = new Headers(init.headers);
    headers.set("Content-Type", "application/json");
    return Response.json(data, { ...init, headers });
}

export function text(
    body: string,
    {
        contentType = "text/plain",
        ...init
    }: BunResponseInit & { contentType?: string } = {}
): Response {
    const headers = new Headers(init.headers);
    headers.set("Content-Type", contentType);
    return new Response(body, { ...init, headers });
}

export function notFound(message = "Not found"): Response {
    return text(message, { status: 404 });
}

export function methodNotAllowed(): Response {
    return json({ error: "Method not allowed" }, { status: 405 });
}

export class HttpError extends Error {
    constructor(
        message: string,
        readonly statusCode: number
    ) {
        super(message);
    }
}

export async function readRequestBytes(
    request: Request,
    maxBytes: number
): Promise<Buffer> {
    const contentLength = request.headers.get("content-length");
    if (contentLength) {
        const size = Number(contentLength);
        if (Number.isFinite(size) && size > maxBytes) {
            throw new HttpError("Request body too large", 413);
        }
    }

    const reader = request.body?.getReader();
    if (!reader) return Buffer.alloc(0);

    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            total += value.byteLength;
            if (total > maxBytes) {
                throw new HttpError("Request body too large", 413);
            }
            chunks.push(value);
        }
    } finally {
        reader.releaseLock();
    }

    return Buffer.concat(chunks, total);
}

export async function readJson<T>(
    request: Request,
    options: { maxBytes?: number } = {}
): Promise<T> {
    const body = await readRequestBytes(
        request,
        options.maxBytes ?? DEFAULT_JSON_BODY_LIMIT
    );
    return JSON.parse(body.toString("utf8")) as T;
}

export function requestIp(request: Request, server: Server<unknown>): string | undefined {
    return server.requestIP(request)?.address;
}

export function isLoopbackAddress(address?: string | null): boolean {
    return Boolean(address && ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(address));
}

export function isTrustedProxyAddress(address?: string | null): boolean {
    return (
        isLoopbackAddress(address) || Boolean(address && TRUSTED_PROXY_IPS.has(address))
    );
}

function forwardedAddresses(forwardedFor: string): string[] {
    return forwardedFor
        .split(",")
        .map((address) => address.trim())
        .filter(Boolean);
}

function clientAddressFromTrustedChain(
    peerAddress: string | undefined,
    forwardedFor: string
): string | undefined {
    let clientAddress = peerAddress;
    const forwardedChain = forwardedAddresses(forwardedFor);
    for (let index = forwardedChain.length - 1; index >= 0; index -= 1) {
        const address = forwardedChain[index];
        clientAddress = address;
        if (!isLoopbackAddress(address)) {
            break;
        }
    }
    return clientAddress;
}

export function isLoopbackRequest(request: Request, server: Server<unknown>): boolean {
    const peerAddress = requestIp(request, server);
    const isTrustForwardedHeaders = isTrustedProxyAddress(peerAddress);
    const realIp = request.headers.get("x-real-ip");
    if (isTrustForwardedHeaders && realIp) {
        return isLoopbackAddress(realIp.trim());
    }
    const forwardedFor = request.headers.get("x-forwarded-for");
    if (isTrustForwardedHeaders && forwardedFor) {
        return isLoopbackAddress(
            clientAddressFromTrustedChain(peerAddress, forwardedFor)
        );
    }
    return isLoopbackAddress(peerAddress);
}

export function sessionIdFromCookie(request: Request): string | null {
    const cookieHeader = request.headers.get("cookie");
    if (!cookieHeader) {
        return null;
    }
    for (const part of cookieHeader.split(";")) {
        const trimmed = part.trim();
        if (trimmed.startsWith(`${SESSION_COOKIE}=`)) {
            return decodeURIComponent(trimmed.slice(SESSION_COOKIE.length + 1));
        }
    }
    return null;
}

export function authUser(request: Request, server: Server<unknown>): AuthUser | null {
    if (isLoopbackRequest(request, server)) {
        return { id: 0, username: "mira-local" };
    }
    const sessionId = sessionIdFromCookie(request);
    return sessionId ? getAuthUserFromSessionId(sessionId) : null;
}

function isProductionRequest(request: Request, server: Server<unknown>): boolean {
    if (process.env.NODE_ENV === "production") {
        return true;
    }
    const forwardedProtocol = request.headers.get("x-forwarded-proto");
    const peerAddress = requestIp(request, server);
    return Boolean(
        isTrustedProxyAddress(peerAddress) &&
        forwardedProtocol &&
        forwardedProtocol.split(",", 1)[0]?.trim() === "https"
    );
}

export function sessionCookie(
    request: Request,
    server: Server<unknown>,
    sessionId: string
): string {
    const cookieParts = [
        `${SESSION_COOKIE}=${encodeURIComponent(sessionId)}`,
        "Path=/",
        "HttpOnly",
        "SameSite=Strict",
        `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
    ];
    if (isProductionRequest(request, server)) {
        cookieParts.push("Secure");
    }
    return cookieParts.join("; ");
}

export function clearSessionCookie(request: Request, server: Server<unknown>): string {
    const cookieParts = [
        `${SESSION_COOKIE}=`,
        "Path=/",
        "HttpOnly",
        "SameSite=Strict",
        "Max-Age=0",
    ];
    if (isProductionRequest(request, server)) {
        cookieParts.push("Secure");
    }
    return cookieParts.join("; ");
}

export function withCookie(response: Response, cookie: string): Response {
    const headers = new Headers(response.headers);
    headers.set("Set-Cookie", cookie);
    return new Response(response.body, {
        headers,
        status: response.status,
        statusText: response.statusText,
    });
}
