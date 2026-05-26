import type { RequestHandler } from "express";

/** Returns a stable message for unknown caught values. */
export function errorMessage(error: unknown, fallback: string): string {
    return error instanceof Error ? error.message : fallback;
}

/** Wraps async Express handlers with consistent JSON error responses. */
export function asyncRoute(
    handler: RequestHandler,
    { fallback = "Route failed", logLabel }: { fallback?: string; logLabel?: string } = {}
): RequestHandler {
    return (req, res, next) => {
        Promise.resolve()
            .then(() => handler(req, res, next))
            .catch((error: unknown) => {
                if (logLabel) {
                    console.error(logLabel, error);
                }
                if (res.headersSent) {
                    next(error);
                    return;
                }
                res.status(500).json({ error: errorMessage(error, fallback) });
            });
    };
}
