import express, { type RequestHandler } from "express";

import gateway from "../gateway.js";

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
        const sessionKeyParam = req.params.id;
        const sessionKey = Array.isArray(sessionKeyParam)
            ? sessionKeyParam[0] || ""
            : sessionKeyParam || "";
        const action = String(req.body?.action || "")
            .trim()
            .toLowerCase();

        try {
            if (!sessionKey) {
                res.status(400).json({ error: "Session id required" });
                return;
            }

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
        const sessionKeyParam = req.params.id;
        const sessionKey = Array.isArray(sessionKeyParam)
            ? sessionKeyParam[0] || ""
            : sessionKeyParam || "";

        try {
            if (!sessionKey) {
                res.status(400).json({ error: "Session id required" });
                return;
            }

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
