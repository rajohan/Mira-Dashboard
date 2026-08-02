import {
    parseSessionActionRequest,
    type SessionActionResponse,
    type SessionDeleteResponse,
    type SessionListResponse,
    type SessionStats,
} from "../../../contracts/sessions.ts";
import { json } from "../http/core.ts";
import {
    type ParametersRequest,
    readApiJsonOrError,
    routeErrorResponse,
    routeFailureResponse,
} from "../http/routeSupport.ts";
import { stringFallback } from "../lib/values.ts";
import gateway from "../services/gateway/runtime.ts";

function isValidSessionKey(sessionKey: string): boolean {
    return sessionKey.length > 0;
}

function sessionRouteError(error: unknown, fallback = "Internal server error"): Response {
    return routeErrorResponse(undefined, error, {
        code: "session_request_failed",
        context: "session",
        message: fallback,
    });
}

export const sessionRoutes = {
    "/api/sessions/list": {
        GET: (request: Request) => {
            try {
                const query = new URL(request.url).searchParams;
                let sessions = [...gateway.getSessions()];
                const type = query.get("type");
                const model = query.get("model");
                if (type) sessions = sessions.filter((session) => session.type === type);
                if (model)
                    sessions = sessions.filter((session) =>
                        typeof session.model === "string"
                            ? session.model.includes(model)
                            : false
                    );
                sessions = sessions.toSorted((a, b) => b.tokenCount - a.tokenCount);
                return json({ sessions } satisfies SessionListResponse);
            } catch (error) {
                return sessionRouteError(error);
            }
        },
    },

    "/api/sessions/:id/action": {
        POST: async (request: ParametersRequest<"id">) => {
            const sessionKey = stringFallback(request.params.id).trim();
            if (!isValidSessionKey(sessionKey)) {
                return routeFailureResponse({
                    context: "session",
                    message: "Invalid session id",
                    status: 400,
                });
            }
            try {
                const body = await readApiJsonOrError(
                    request,
                    parseSessionActionRequest,
                    {
                        code: "invalid_session_action",
                        context: "session.action",
                        message: "Invalid session action",
                    }
                );
                if (body instanceof Response) return body;
                const { action } = body;
                if (action === "stop") {
                    await gateway.abortSessionRun(sessionKey);
                    return json({
                        action,
                        isSuccess: true,
                    } satisfies SessionActionResponse);
                }
                if (action === "compact") {
                    await gateway.sendSessionMessage(sessionKey, "/compact");
                    return json({
                        action,
                        isSuccess: true,
                    } satisfies SessionActionResponse);
                }
                await gateway.sendSessionMessage(sessionKey, "/reset");
                return json({
                    action,
                    isSuccess: true,
                } satisfies SessionActionResponse);
            } catch (error) {
                return sessionRouteError(error);
            }
        },
    },

    "/api/sessions/:id": {
        DELETE: async (request: ParametersRequest<"id">) => {
            const sessionKey = stringFallback(request.params.id).trim();
            if (!isValidSessionKey(sessionKey)) {
                return routeFailureResponse({
                    context: "session",
                    message: "Invalid session id",
                    status: 400,
                });
            }
            try {
                return json({
                    isSuccess: true,
                    result: await gateway.deleteSession(sessionKey),
                } satisfies SessionDeleteResponse);
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
                const stats: SessionStats = {
                    activeInLastHour: 0,
                    byModel: {},
                    byType: {},
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
