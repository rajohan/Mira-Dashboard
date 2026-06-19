import express, { type RequestHandler } from "express";

import gateway from "../gateway.ts";
import { stringFallback } from "../lib/values.ts";

function isValidSessionKey(sessionKey: string): boolean {
    return sessionKey.length > 0;
}

/** Registers sessions API routes. */
export default function sessionsRoutes(app: express.Application): void {
    // List sessions with optional filtering
    app.get("/api/sessions/list", (async (request, response) => {
        try {
            let sessions = gateway.getSessions();

            // Filter by type
            const type = request.query.type as string | undefined;
            if (type) {
                sessions = sessions.filter((s) => s.type === type);
            }

            // Filter by model
            const model = request.query.model as string | undefined;
            if (model) {
                sessions = sessions.filter((s) => s.model.includes(model));
            }

            // Sort by token count (descending)
            sessions.sort((a, b) => b.tokenCount - a.tokenCount);

            response.json({ sessions });
        } catch (error) {
            response.status(500).json({ error: (error as Error).message });
        }
    }) as RequestHandler);

    app.post("/api/sessions/:id/action", (async (request, response) => {
        const sessionKey = stringFallback(request.params.id).trim();
        if (!isValidSessionKey(sessionKey)) {
            response.status(400).json({ error: "Invalid session id" });
            return;
        }
        const action = stringFallback(request.body?.action).trim().toLowerCase();

        try {
            if (action === "stop") {
                await gateway.abortSessionRun(sessionKey);
                response.json({ success: true, action });
                return;
            }

            if (action === "compact") {
                await gateway.sendSessionMessage(sessionKey, "/compact");
                response.json({ success: true, action });
                return;
            }

            if (action === "reset") {
                await gateway.sendSessionMessage(sessionKey, "/reset");
                response.json({ success: true, action });
                return;
            }

            response.status(400).json({ error: `Unsupported action: ${action}` });
        } catch (error) {
            response.status(500).json({ error: (error as Error).message });
        }
    }) as RequestHandler);

    // Delete a session and archive its transcript through OpenClaw.
    app.delete("/api/sessions/:id", (async (request, response) => {
        const sessionKey = stringFallback(request.params.id).trim();
        if (!isValidSessionKey(sessionKey)) {
            response.status(400).json({ error: "Invalid session id" });
            return;
        }

        try {
            const result = await gateway.deleteSession(sessionKey);
            response.json({ success: true, result });
        } catch (error) {
            response.status(500).json({ error: (error as Error).message });
        }
    }) as RequestHandler);

    // Get session stats
    app.get("/api/sessions/stats", (async (_request, response) => {
        try {
            const sessions = gateway.getSessions();
            const now = Date.now();

            const stats = {
                total: sessions.length,
                byType: {} as Record<string, number>,
                byModel: {} as Record<string, number>,
                totalTokens: 0,
                activeInLastHour: 0,
            };

            for (const session of sessions) {
                // By type
                const type = session.type || "Unknown";
                stats.byType[type] = (stats.byType[type] || 0) + 1;

                // By model
                const model = session.model || "Unknown";
                stats.byModel[model] = (stats.byModel[model] || 0) + 1;

                // Total tokens
                stats.totalTokens += session.tokenCount || 0;

                // Active in last hour
                if (session.updatedAt && now - session.updatedAt < 3600000) {
                    stats.activeInLastHour++;
                }
            }

            response.json(stats);
        } catch (error) {
            response.status(500).json({ error: (error as Error).message });
        }
    }) as RequestHandler);
}
