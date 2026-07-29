import { json } from "../http.ts";
import { routeFailureResponse } from "../routeSupport.ts";
import { listAuditEvents, MAX_AUDIT_PAGE_SIZE } from "../services/auditEvents.ts";

function auditLimit(value: string | null): number | Response {
    if (value === null) return 50;
    if (!/^\d+$/u.test(value)) {
        return routeFailureResponse({
            context: "audit",
            message: "Invalid audit limit",
            status: 400,
        });
    }
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= MAX_AUDIT_PAGE_SIZE
        ? parsed
        : routeFailureResponse({
              context: "audit",
              message: "Invalid audit limit",
              status: 400,
          });
}

export const auditRoutes = {
    "/api/audit-events": {
        GET: (request: Request) => {
            const url = new URL(request.url);
            const limit = auditLimit(url.searchParams.get("limit"));
            if (limit instanceof Response) return limit;
            try {
                return json(
                    listAuditEvents(limit, url.searchParams.get("before") || undefined)
                );
            } catch (error) {
                if (error instanceof TypeError) {
                    return routeFailureResponse({
                        context: "audit",
                        message: error.message,
                        status: 400,
                    });
                }
                throw error;
            }
        },
    },
} as const;
