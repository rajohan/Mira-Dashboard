import express, { type RequestHandler } from "express";

import gateway, { type Session } from "../gateway.js";

interface HistoryMessage {
    id: string;
    role: string;
    content: string;
    timestamp?: string;
    tokens?: number;
}

interface HistoryResponse {
    messages: HistoryMessage[];
    total: number;
    hasMore: boolean;
}

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

    // Get session history
    app.get("/api/sessions/:id/history", (async (req, res) => {
        const sessionId = req.params.id;
        const limit = Number.parseInt((req.query.limit as string) || "50", 10);
        const offset = Number.parseInt((req.query.offset as string) || "0", 10);

        try {
            // Find the session
            const sessions = gateway.getSessions();
            const session = sessions.find(
                (s: Session) => s.id === sessionId || s.key === sessionId
            );

            if (!session) {
                res.status(404).json({ error: "Session not found" });
                return;
            }

            // For now, return empty history - this would need gateway integration
            // to fetch actual message history. Parameters limit/offset would be used here.
            console.log(
                `History request for ${sessionId}: limit=${limit}, offset=${offset}`
            );
            res.json({
                messages: [],
                total: 0,
                hasMore: false,
            } as HistoryResponse);
        } catch (error) {
            res.status(500).json({ error: (error as Error).message });
        }
    }) as RequestHandler);

    // Kill a session
    app.delete("/api/sessions/:id", (async (_req, res) => {
        try {
            // This would need gateway integration to actually kill sessions
            res.json({ success: true, message: "Session kill request sent" });
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
