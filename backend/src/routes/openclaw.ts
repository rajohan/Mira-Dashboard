import express, { type RequestHandler } from "express";

import { refreshCacheKey } from "./cache.js";
import { fetchCachedSystemOpenClaw } from "../lib/systemCache.js";

export interface VersionResponse {
    current: string;
    latest: string | null;
    updateAvailable: boolean;
    checkedAt: number;
}

export async function getOpenClawVersionCached(): Promise<VersionResponse> {
    const cached = await fetchCachedSystemOpenClaw();
    if (!cached.data.version) {
        throw new Error("OpenClaw version missing from system cache");
    }

    return cached.data.version;
}

export default function openclawRoutes(
    app: express.Application,
    _express: typeof express
): void {
    app.get("/api/openclaw/version", (async (_req, res) => {
        try {
            const version = await getOpenClawVersionCached();
            res.json(version);
        } catch (error) {
            res.status(503).json({
                error: error instanceof Error ? error.message : "OpenClaw version cache unavailable",
            });
        }
    }) as RequestHandler);

    app.post("/api/openclaw/version/refresh", (async (_req, res) => {
        try {
            await refreshCacheKey("system.openclaw");
            const version = await getOpenClawVersionCached();
            res.json({ ok: true, version });
        } catch (error) {
            res.status(500).json({
                error: error instanceof Error ? error.message : "OpenClaw version refresh failed",
            });
        }
    }) as RequestHandler);
}
