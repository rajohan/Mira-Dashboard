import express, { type RequestHandler } from "express";

import gateway from "../gateway.js";
import { stringFallback } from "../lib/values.js";

function isValidSessionKey(sessionKey: string): boolean {
    return sessionKey.trim().length > 0;
}

/** Registers sessions API routes. */
export default function sessionsRoutes(app: express.Application): void {
    // List sessions with optional filtering
    app.get("/api/sessions/list", (async (req, res) => {
        try {
            let sessions = gateway.getSessions();

            // Filter by type
            const type = req.query.type as string | undefined;
            if (type) {
                sessions = sessions.filter((s) => s.type === type);
            }

            // Filter by model
            const model = req.query.model as string | undefined;
            if (model) {
                sessions = sessions.filter((s) => s.model.includes(model));
            }

            // Sort by token count (descending)
            sessions.sort((a, b) => b.tokenCount - a.tokenCount);

            res.json({ sessions });
        } catch (error) {
            res.status(500).json({ error: (error as Error).message });
        }
    }) as RequestHandler);

    app.post("/api/sessions/:id/action", (async (req, res) => {
        const sessionKey = stringFallback(req.params.id).trim();
        const action = stringFallback(req.body?.action).trim().toLowerCase();
        if (!isValidSessionKey(sessionKey)) {
            res.status(400).json({ error: "Invalid session id" });
            return;
        }

        try {
            if (action === "stop") {
                await gateway.abortSessionRun(sessionKey);
                res.json({ success: true, action });
                return;
            }

            if (action === "compact") {
                await gateway.sendSessionMessage(sessionKey, "/compact");
                res.json({ success: true, action });
                return;
            }

            if (action === "reset") {
                await gateway.sendSessionMessage(sessionKey, "/reset");
                res.json({ success: true, action });
                return;
            }

            res.status(400).json({ error: `Unsupported action: ${action}` });
        } catch (error) {
            res.status(500).json({ error: (error as Error).message });
        }
    }) as RequestHandler);

    // Delete a session and archive its transcript through OpenClaw.
    app.delete("/api/sessions/:id", (async (req, res) => {
        const sessionKey = stringFallback(req.params.id).trim();
        if (!isValidSessionKey(sessionKey)) {
            res.status(400).json({ error: "Invalid session id" });
            return;
        }

        try {
            const result = await gateway.deleteSession(sessionKey);
            res.json({ success: true, result });
        } catch (error) {
            res.status(500).json({ error: (error as Error).message });
        }
    }) as RequestHandler);

    // Get session stats
    app.get("/api/sessions/stats", (async (_req, res) => {
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

            res.json(stats);
        } catch (error) {
            res.status(500).json({ error: (error as Error).message });
        }
    }) as RequestHandler);
}
