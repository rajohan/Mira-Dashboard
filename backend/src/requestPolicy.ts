import type { Server } from "bun";

import { authUser, json, requestIp } from "./http.ts";

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

function isApiRoute(pathname: string): boolean {
    return pathname === "/api" || pathname.startsWith("/api/");
}

function isAuthRoute(pathname: string): boolean {
    return pathname === "/api/auth" || pathname.startsWith("/api/auth/");
}

function rateLimitKey(
    rule: RateLimitRule,
    request: Request,
    server: Server<unknown>
): string {
    const forwardedFor = request.headers.get("x-forwarded-for")?.split(",", 1)[0]?.trim();
    return `${rule.keyPrefix}:${forwardedFor || requestIp(request, server) || "unknown"}`;
}

function withRateLimitHeaders(
    response: Response,
    rule: RateLimitRule,
    remaining: number,
    resetAt: number
): Response {
    const headers = new Headers(response.headers);
    headers.set("RateLimit-Policy", `${rule.max};w=${Math.floor(rule.windowMs / 1000)}`);
    headers.set(
        "RateLimit",
        `limit=${rule.max}, remaining=${Math.max(remaining, 0)}, reset=${Math.ceil(resetAt / 1000)}`
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
): Response | null {
    const now = Date.now();
    const key = rateLimitKey(rule, request, server);
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
        bucket = { resetAt: now + rule.windowMs, used: 0 };
        buckets.set(key, bucket);
    }

    bucket.used += 1;
    if (bucket.used <= rule.max) {
        return null;
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
        return handler;
    }
    return handler(request, server);
}

function secureHandler(routePath: string, handler: BunHandler | Response): BunHandler {
    return async (request, server) => {
        const pathname = new URL(request.url).pathname || routePath;
        const rateRule = isAuthRoute(pathname)
            ? authRule
            : isApiRoute(pathname)
              ? apiRule
              : null;
        if (rateRule) {
            const limited = checkRateLimit(request, server, rateRule);
            if (limited) return limited;
        }

        if (
            isApiRoute(pathname) &&
            !isAuthRoute(pathname) &&
            !authUser(request, server)
        ) {
            return json({ error: "Unauthorized" }, { status: 401 });
        }

        try {
            const response = await callHandler(handler, request, server);
            if (!rateRule) return response;
            const key = rateLimitKey(rateRule, request, server);
            const bucket = buckets.get(key);
            if (!bucket) return response;
            return withRateLimitHeaders(
                response,
                rateRule,
                rateRule.max - bucket.used,
                bucket.resetAt
            );
        } catch (error) {
            if (error instanceof SyntaxError) {
                return json({ error: "Invalid JSON" }, { status: 400 });
            }
            console.error("[BunServer] Request failed:", error);
            return json({ error: "Internal server error" }, { status: 500 });
        }
    };
}

function secureEntry(routePath: string, entry: BunRouteEntry): BunRouteEntry {
    if (entry instanceof Response || typeof entry === "function") {
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
}
