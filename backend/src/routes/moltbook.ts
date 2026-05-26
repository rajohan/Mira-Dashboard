import express, { type RequestHandler } from "express";

import { errorMessage } from "../lib/errors.js";
import {
    fetchCachedMoltbookFeed,
    fetchCachedMoltbookHome,
    fetchCachedMoltbookMyContent,
    fetchCachedMoltbookProfile,
} from "../lib/moltbookCache.js";

/** Registers moltbook API routes. */
export default function moltbookRoutes(app: express.Application): void {
    app.get("/api/moltbook/home", (async (_req, res) => {
        try {
            const cached = await fetchCachedMoltbookHome();
            res.json(cached);
        } catch (error) {
            res.status(503).json({
                error: errorMessage(error, "Moltbook cache unavailable"),
            });
        }
    }) as RequestHandler);

    app.get("/api/moltbook/feed", (async (req, res) => {
        try {
            const sort = req.query.sort === "new" ? "new" : "hot";
            const cached = await fetchCachedMoltbookFeed(sort);
            res.json(cached.data);
        } catch (error) {
            res.status(503).json({
                error: errorMessage(error, "Moltbook feed cache unavailable"),
            });
        }
    }) as RequestHandler);

    app.get("/api/moltbook/profile", (async (_req, res) => {
        try {
            const cached = await fetchCachedMoltbookProfile();
            res.json(cached.data);
        } catch (error) {
            res.status(503).json({
                error: errorMessage(error, "Moltbook profile cache unavailable"),
            });
        }
    }) as RequestHandler);

    app.get("/api/moltbook/my-posts", (async (_req, res) => {
        try {
            const cached = await fetchCachedMoltbookMyContent();
            res.json(cached.data);
        } catch (error) {
            res.status(503).json({
                error: errorMessage(error, "Moltbook content cache unavailable"),
            });
        }
    }) as RequestHandler);
}
