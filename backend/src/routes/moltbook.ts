import express, { type RequestHandler } from "express";

import { errorMessage } from "../lib/errors.ts";
import {
    fetchCachedMoltbookFeed,
    fetchCachedMoltbookHome,
    fetchCachedMoltbookMyContent,
    fetchCachedMoltbookProfile,
} from "../lib/moltbookCache.ts";

/** Registers moltbook API routes. */
export default function moltbookRoutes(app: express.Application): void {
    app.get("/api/moltbook/home", (async (_request, response) => {
        try {
            const cached = await fetchCachedMoltbookHome();
            response.json(cached);
        } catch (error) {
            response.status(503).json({
                error: errorMessage(error, "Moltbook cache unavailable"),
            });
        }
    }) as RequestHandler);

    app.get("/api/moltbook/feed", (async (request, response) => {
        try {
            const sort = request.query.sort === "new" ? "new" : "hot";
            const cached = await fetchCachedMoltbookFeed(sort);
            response.json(cached.data);
        } catch (error) {
            response.status(503).json({
                error: errorMessage(error, "Moltbook feed cache unavailable"),
            });
        }
    }) as RequestHandler);

    app.get("/api/moltbook/profile", (async (_request, response) => {
        try {
            const cached = await fetchCachedMoltbookProfile();
            response.json(cached.data);
        } catch (error) {
            response.status(503).json({
                error: errorMessage(error, "Moltbook profile cache unavailable"),
            });
        }
    }) as RequestHandler);

    app.get("/api/moltbook/my-posts", (async (_request, response) => {
        try {
            const cached = await fetchCachedMoltbookMyContent();
            response.json(cached.data);
        } catch (error) {
            response.status(503).json({
                error: errorMessage(error, "Moltbook content cache unavailable"),
            });
        }
    }) as RequestHandler);
}
