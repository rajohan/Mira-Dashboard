import { isIP } from "node:net";

import type { Server } from "bun";

import { authUser, HttpError, isTrustedProxyAddress, json, requestIp } from "./http.ts";
import { errorMessage, httpStatusCode } from "./lib/errors.ts";
import {
    isAllowedMutationSource,
    requestIdFor,
    withRequestSecurity,
} from "./requestSecurity.ts";

type BunHandler = (
    request: Request,
    server: Server<unknown>
) => Response | Promise<Response>;
type BunRouteEntry =
    | Response
    | BunHandler
    | {
          DELETE?: BunHandler | Response;
          GET?: BunHandler | Response;
          PATCH?: BunHandler | Response;
          POST?: BunHandler | Response;
          PUT?: BunHandler | Response;
      };

interface RateLimitBucket {
    lastSeenAt: number;
    resetAt: number;
    used: number;
}

interface RateLimitRule {
    keyPrefix: string;
    max: number;
    message: string;
    windowMs: number;
}

const apiRule: RateLimitRule = {
    keyPrefix: "api",
    max: 600,
    message: "Too many requests, please try again later",
    windowMs: 60_000,
};

const authRule: RateLimitRule = {
    keyPrefix: "auth",
    max: 20,
    message: "Too many authentication attempts, please try again later",
    windowMs: 60_000,
};

const buckets = new Map<string, RateLimitBucket>();
const BUCKET_CLEANUP_INTERVAL_MS = 60_000;
const BUCKET_STALE_MS = Math.max(apiRule.windowMs, authRule.windowMs) * 2;
const rateLimitState: { bucketCleanupTimer: Timer | undefined } = {
    bucketCleanupTimer: undefined,
};

function cleanupStaleBuckets(): void {
    const staleBefore = Date.now() - BUCKET_STALE_MS;
    for (const [key, bucket] of buckets) {
        if (bucket.lastSeenAt < staleBefore) {
            buckets.delete(key);
        }
    }
}

function ensureBucketCleanupTimer(): void {
    if (rateLimitState.bucketCleanupTimer) return;
    rateLimitState.bucketCleanupTimer = setInterval(
        cleanupStaleBuckets,
        BUCKET_CLEANUP_INTERVAL_MS
    );
    rateLimitState.bucketCleanupTimer.unref();
}

function isApiRoute(pathname: string): boolean {
    return pathname === "/api" || pathname.startsWith("/api/");
}

function isAuthRoute(pathname: string): boolean {
    return pathname === "/api/auth" || pathname.startsWith("/api/auth/");
}

function isPublicApiRoute(pathname: string): boolean {
    return pathname === "/api/health";
}

function rateLimitKey(
    rule: RateLimitRule,
    request: Request,
    server: Server<unknown>
): string {
    const peerAddress = requestIp(request, server);
    const trustedClientAddress = isTrustedProxyAddress(peerAddress)
        ? trustedProxyClientAddress(request)
        : undefined;
    return `${rule.keyPrefix}:${trustedClientAddress || peerAddress || "unknown"}`;
}

function trustedProxyClientAddress(request: Request): string | undefined {
    const realIp = request.headers.get("x-real-ip")?.trim();
    if (realIp && isIP(realIp)) return realIp;

    const forwardedFor = request.headers.get("x-forwarded-for")?.trim();
    if (!forwardedFor || forwardedFor.includes(",")) return undefined;
    return isIP(forwardedFor) ? forwardedFor : undefined;
}

function withRateLimitHeaders(
    response: Response,
    rule: RateLimitRule,
    remaining: number,
    resetAt: number
): Response {
    const headers = new Headers(response.headers);
    const resetSeconds = Math.max(0, Math.ceil((resetAt - Date.now()) / 1000));
    headers.set("RateLimit-Policy", `${rule.max};w=${Math.floor(rule.windowMs / 1000)}`);
    headers.set(
        "RateLimit",
        `limit=${rule.max}, remaining=${Math.max(remaining, 0)}, reset=${resetSeconds}`
    );
    return new Response(response.body, {
        headers,
        status: response.status,
        statusText: response.statusText,
    });
}

function checkRateLimit(
    request: Request,
    server: Server<unknown>,
    rule: RateLimitRule
): Response | undefined {
    const now = Date.now();
    ensureBucketCleanupTimer();
    const key = rateLimitKey(rule, request, server);
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
        bucket = { lastSeenAt: now, resetAt: now + rule.windowMs, used: 0 };
        buckets.set(key, bucket);
    }

    bucket.lastSeenAt = now;
    bucket.used += 1;
    if (bucket.used <= rule.max) {
        return undefined;
    }

    const remaining = rule.max - bucket.used;
    const response = json({ error: rule.message }, { status: 429 });
    const withHeaders = withRateLimitHeaders(response, rule, remaining, bucket.resetAt);
    const headers = new Headers(withHeaders.headers);
    headers.set("Retry-After", String(Math.ceil((bucket.resetAt - now) / 1000)));
    return new Response(withHeaders.body, {
        headers,
        status: withHeaders.status,
        statusText: withHeaders.statusText,
    });
}

async function callHandler(
    handler: BunHandler | Response,
    request: Request,
    server: Server<unknown>
): Promise<Response> {
    if (handler instanceof Response) {
        return handler.clone() as Response;
    }
    return handler(request, server);
}

function secureHandler(routePath: string, handler: BunHandler | Response): BunHandler {
    return async (request, server) => {
        const response = await (async () => {
            const pathname = new URL(request.url).pathname || routePath;
            const rateRule = isAuthRoute(pathname)
                ? authRule
                : isApiRoute(pathname)
                  ? apiRule
                  : undefined;
            if (rateRule) {
                const limited = checkRateLimit(request, server, rateRule);
                if (limited) return limited;
            }

            if (isApiRoute(pathname) && !isAllowedMutationSource(request)) {
                return json({ error: "Forbidden request origin" }, { status: 403 });
            }

            if (
                isApiRoute(pathname) &&
                !isAuthRoute(pathname) &&
                !isPublicApiRoute(pathname) &&
                !authUser(request, server)
            ) {
                return json({ error: "Unauthorized" }, { status: 401 });
            }

            try {
                const handlerResponse = await callHandler(handler, request, server);
                if (!rateRule) return handlerResponse;
                const key = rateLimitKey(rateRule, request, server);
                const bucket = buckets.get(key);
                if (!bucket) return handlerResponse;
                return withRateLimitHeaders(
                    handlerResponse,
                    rateRule,
                    rateRule.max - bucket.used,
                    bucket.resetAt
                );
            } catch (error) {
                if (error instanceof HttpError) {
                    return json({ error: error.message }, { status: error.statusCode });
                }
                if (error instanceof SyntaxError) {
                    return json({ error: "Invalid JSON" }, { status: 400 });
                }
                const mappedStatus = httpStatusCode(error);
                if (mappedStatus !== 500) {
                    return json(
                        { error: errorMessage(error, "Request failed") },
                        { status: mappedStatus }
                    );
                }
                console.error(
                    `[BunServer] Request ${requestIdFor(request)} failed:`,
                    error
                );
                return json({ error: "Internal server error" }, { status: 500 });
            }
        })();

        return withRequestSecurity(request, response, server);
    };
}

function secureEntry(routePath: string, entry: BunRouteEntry): BunRouteEntry {
    if (typeof entry === "function" || entry instanceof Response) {
        return secureHandler(routePath, entry);
    }

    return Object.fromEntries(
        Object.entries(entry).map(([method, handler]) => [
            method,
            secureHandler(routePath, handler as BunHandler | Response),
        ])
    ) as BunRouteEntry;
}

export function withRequestPolicy<T extends Record<string, unknown>>(routes: T): T {
    return Object.fromEntries(
        Object.entries(routes).map(([routePath, entry]) => [
            routePath,
            secureEntry(routePath, entry as BunRouteEntry),
        ])
    ) as T;
}

export function resetRequestPolicyForTests(): void {
    buckets.clear();
    if (rateLimitState.bucketCleanupTimer) {
        clearInterval(rateLimitState.bucketCleanupTimer);
        rateLimitState.bucketCleanupTimer = undefined;
    }
}
