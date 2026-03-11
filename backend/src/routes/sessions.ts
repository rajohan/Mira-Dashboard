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
        const sessionKey = req.params.id;
        const limit = Number.parseInt((req.query.limit as string) || "50", 10);
        const offset = Number.parseInt((req.query.offset as string) || "0", 10);

        try {
            // Find the session first
            const sessions = gateway.getSessions();
            const session = sessions.find(
                (s: Session) => s.id === sessionKey || s.key === sessionKey
            );

            if (!session) {
                res.status(404).json({ error: "Session not found" });
                return;
            }

            // Get history from gateway
            const history = await gateway.getSessionHistory(session.key, limit, offset);

            // Transform messages to match frontend expectations
            const messages = history.messages.map(
                (
                    msg: {
                        role?: string;
                        content?: string | Array<{ type?: string; text?: string }>;
                        timestamp?: string | number;
                    },
                    idx: number
                ) => {
                    // Handle content as array of blocks
                    const content = Array.isArray(msg.content)
                        ? msg.content
                              .map(
                                  (block: { type?: string; text?: string }) =>
                                      block.text || ""
                              )
                              .join("")
                        : String(msg.content || "");

                    // Handle timestamp
                    const timestamp = msg.timestamp
                        ? typeof msg.timestamp === "number"
                            ? new Date(msg.timestamp).toISOString()
                            : msg.timestamp
                        : undefined;

                    return {
                        id: `${offset + idx}`,
                        role: msg.role || "unknown",
                        content,
                        timestamp,
                    };
                }
            );

            const hasMore = history.total > offset + messages.length;
            const nextOffset = hasMore ? offset + messages.length : undefined;

            res.json({
                messages,
                total: history.total,
                hasMore,
                nextOffset,
            } as HistoryResponse);
        } catch (error) {
            res.status(500).json({ error: (error as Error).message });
        }
    }) as RequestHandler);

    app.post("/api/sessions/:id/action", (async (req, res) => {
        const sessionKeyParam = req.params.id;
        const sessionKey = Array.isArray(sessionKeyParam)
            ? sessionKeyParam[0] || ""
            : sessionKeyParam || "";
        const action = String(req.body?.action || "").trim().toLowerCase();

        try {
            console.log("[Sessions] action request", { sessionKey, action });

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
