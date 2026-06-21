import gateway from "../gateway.ts";
import { json, readJson } from "../http.ts";
import { httpStatusCode } from "../lib/errors.ts";
import { stringFallback } from "../lib/values.ts";

type ParametersRequest<T extends string> = Request & { params: Record<T, string> };

function isValidSessionKey(sessionKey: string): boolean {
    return sessionKey.length > 0;
}

function sessionRouteError(error: unknown, fallback = "Internal server error"): Response {
    console.error("[Sessions] Request failed:", error);
    return json({ error: fallback }, { status: httpStatusCode(error) });
}

export const sessionRoutes = {
    "/api/sessions/list": {
        GET: (request: Request) => {
            try {
                const query = new URL(request.url).searchParams;
                let sessions = gateway.getSessions();
                const type = query.get("type");
                const model = query.get("model");
                if (type) sessions = sessions.filter((session) => session.type === type);
                if (model)
                    sessions = sessions.filter((session) =>
                        typeof session.model === "string"
                            ? session.model.includes(model)
                            : false
                    );
                sessions.sort((a, b) => b.tokenCount - a.tokenCount);
                return json({ sessions });
            } catch (error) {
                return sessionRouteError(error);
            }
        },
    },

    "/api/sessions/:id/action": {
        POST: async (request: ParametersRequest<"id">) => {
            const sessionKey = stringFallback(request.params.id).trim();
            if (!isValidSessionKey(sessionKey)) {
                return json({ error: "Invalid session id" }, { status: 400 });
            }
            try {
                const body = await readJson<{ action?: unknown }>(request);
                const action = stringFallback(body.action).trim().toLowerCase();
                if (action === "stop") {
                    await gateway.abortSessionRun(sessionKey);
                    return json({ action, isSuccess: true });
                }
                if (action === "compact") {
                    await gateway.sendSessionMessage(sessionKey, "/compact");
                    return json({ action, isSuccess: true });
                }
                if (action === "reset") {
                    await gateway.sendSessionMessage(sessionKey, "/reset");
                    return json({ action, isSuccess: true });
                }
                return json({ error: `Unsupported action: ${action}` }, { status: 400 });
            } catch (error) {
                return sessionRouteError(error);
            }
        },
    },

    "/api/sessions/:id": {
        DELETE: async (request: ParametersRequest<"id">) => {
            const sessionKey = stringFallback(request.params.id).trim();
            if (!isValidSessionKey(sessionKey)) {
                return json({ error: "Invalid session id" }, { status: 400 });
            }
            try {
                return json({
                    isSuccess: true,
                    result: await gateway.deleteSession(sessionKey),
                });
            } catch (error) {
                return sessionRouteError(error);
            }
        },
    },

    "/api/sessions/stats": {
        GET: () => {
            try {
                const sessions = gateway.getSessions();
                const now = Date.now();
                const stats = {
                    activeInLastHour: 0,
                    byModel: {} as Record<string, number>,
                    byType: {} as Record<string, number>,
                    total: sessions.length,
                    totalTokens: 0,
                };
                for (const session of sessions) {
                    const type = session.type || "Unknown";
                    const model = session.model || "Unknown";
                    stats.byType[type] = (stats.byType[type] || 0) + 1;
                    stats.byModel[model] = (stats.byModel[model] || 0) + 1;
                    stats.totalTokens += session.tokenCount || 0;
                    if (session.updatedAt && now - session.updatedAt < 3_600_000) {
                        stats.activeInLastHour += 1;
                    }
                }
                return json(stats);
            } catch (error) {
                return sessionRouteError(error);
            }
        },
    },
} as const;
