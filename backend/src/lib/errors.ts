import type { RequestHandler } from "express";

export interface HttpStatusError extends Error {
    statusCode?: number;
}

/** Returns a stable message for unknown caught values. */
export function errorMessage(error: unknown, fallback: string): string {
    if (!(error instanceof Error)) {
        return fallback;
    }
    return error.message.trim() || fallback;
}

export function httpStatusCode(error: unknown): number {
    if (typeof error === "object" && error !== null) {
        const statusCode = (error as HttpStatusError).statusCode;
        if (
            typeof statusCode === "number" &&
            Number.isSafeInteger(statusCode) &&
            statusCode >= 400 &&
            statusCode <= 599
        ) {
            return statusCode;
        }
    }
    return 500;
}

/** Wraps async Express handlers with consistent JSON error responses. */
export function asyncRoute(
    handler: RequestHandler,
    { fallback = "Route failed", logLabel }: { fallback?: string; logLabel?: string } = {}
): RequestHandler {
    return async (request, response, next) => {
        try {
            await handler(request, response, next);
        } catch (error) {
            if (logLabel) {
                console.error(logLabel, error);
            }
            if (response.headersSent) {
                next(error);
                return;
            }
            response.status(httpStatusCode(error)).json({
                error: errorMessage(error, fallback),
            });
        }
    };
}
