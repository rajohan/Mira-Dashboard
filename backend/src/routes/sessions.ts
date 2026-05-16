import express, { type RequestHandler } from "express";

import gateway, { type Session } from "../gateway.js";

/** Represents history message. */
interface HistoryMessage {
    id: number | string;
    role: string;
    content: string;
    timestamp?: string;
    tokens?: number;
}

/** Represents the history API response. */
interface HistoryResponse {
    messages: HistoryMessage[];
    total: number;
    hasMore: boolean;
}

/** Creates a compact deterministic hash for session-history fallback ids. */
function stableRouteHistoryHash(value: string): string {
    let hash = 0x811c9dc5;

    for (let index = 0; index < value.length; index += 1) {
        hash ^= value.codePointAt(index) || 0;
        hash = Math.imul(hash, 0x01000193);
    }

    return (hash >>> 0).toString(36);
}

/** Returns an upstream id or a deterministic fallback id for a response row. */
function getHistoryResponseMessageId(
    message: { id?: number | string; role?: string },
    content: string,
    timestamp: string | undefined,
    seenFallbacks: Map<string, number>
): number | string {
    if (
        message.id !== undefined &&
        message.id !== null &&
        String(message.id).length > 0
    ) {
        return message.id;
    }

    const fingerprint = stableRouteHistoryHash(
        [message.role || "unknown", timestamp || "", content].join("\u001F")
    );
    const occurrence = seenFallbacks.get(fingerprint) || 0;
    seenFallbacks.set(fingerprint, occurrence + 1);

    return `fallback:${fingerprint}:${occurrence}`;
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
            const fallbackIds = new Map<string, number>();
            const messages = history.messages.map(
                (
                    msg: {
                        id?: number | string;
                        role?: string;
                        content?: string | Array<{ type?: string; text?: string }>;
                        timestamp?: string | number;
                    },
                    _idx: number
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
                        id: getHistoryResponseMessageId(
                            msg,
                            content,
                            timestamp,
                            fallbackIds
                        ),
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
