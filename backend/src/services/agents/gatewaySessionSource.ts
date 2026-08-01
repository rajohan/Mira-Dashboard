import gateway from "../../gateway.ts";
import { CoalescedSnapshot } from "../../lib/coalescedSnapshot.ts";
import { createStructuredLogger } from "../../lib/structuredLogger.ts";

const logger = createStructuredLogger("agents");

export interface GatewaySessionSummary {
    key: string;
    model?: string;
    status?: string | undefined;
    updatedAt?: number | undefined;
    startedAt?: string | number | undefined;
    endedAt?: string | number | undefined;
    runId?: string | undefined;
    activeRunId?: string | undefined;
    currentRunId?: string | undefined;
    isRunning?: boolean | undefined;
    running?: boolean | undefined;
}

function cachedGatewaySessions(): GatewaySessionSummary[] {
    try {
        return gateway
            .getSessions()
            .filter(
                (session) => typeof session.key === "string" && session.key.length > 0
            )
            .map((session) => ({
                key: session.key,
                model:
                    typeof session.model === "string"
                        ? session.model.trim() || undefined
                        : undefined,
                status: session.status,
                updatedAt: session.updatedAt,
                startedAt: session.startedAt,
                endedAt: session.endedAt,
                runId: session.runId,
                activeRunId: session.activeRunId,
                currentRunId: session.currentRunId,
                isRunning: session.isRunning,
                running: session.running,
            }));
    } catch {
        return [];
    }
}

/**
 * Loads live Gateway sessions, falling back to the local Gateway cache.
 * @returns Normalized live sessions, or cached sessions when live loading fails.
 */
async function loadGatewaySessionsForAgents(): Promise<GatewaySessionSummary[]> {
    try {
        const result = (await gateway.request("sessions.list", {})) as {
            sessions?: Array<{
                key?: string;
                model?: string;
                status?: string | undefined;
                updatedAt?: number | undefined;
                startedAt?: number | undefined;
                endedAt?: number | undefined;
                runId?: string | undefined;
                activeRunId?: string | undefined;
                currentRunId?: string | undefined;
                isRunning?: boolean | undefined;
                running?: boolean | undefined;
            }>;
        };

        if (Array.isArray(result.sessions)) {
            return result.sessions
                .filter(
                    (session) => typeof session.key === "string" && session.key.length > 0
                )
                .map((session) => ({
                    key: session.key as string,
                    model:
                        typeof session.model === "string"
                            ? session.model.trim() || undefined
                            : undefined,
                    status: session.status,
                    updatedAt: session.updatedAt,
                    startedAt: session.startedAt,
                    endedAt: session.endedAt,
                    runId: session.runId,
                    activeRunId: session.activeRunId,
                    currentRunId: session.currentRunId,
                    isRunning: session.isRunning,
                    running: session.running,
                }));
        }
    } catch (error) {
        logger.warn("agents.gateway_sessions_list_failed", { error });
    }
    return cachedGatewaySessions();
}

const gatewayAgentSessionsSnapshot = new CoalescedSnapshot<GatewaySessionSummary[]>({
    freshForMs: 1500,
    load: loadGatewaySessionsForAgents,
    name: "openclaw.agent-sessions",
    staleForMs: 10_000,
});

export function getGatewaySessionsForAgents(): Promise<GatewaySessionSummary[]> {
    return gatewayAgentSessionsSnapshot.read();
}
