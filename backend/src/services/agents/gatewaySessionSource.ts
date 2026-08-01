import gateway from "../../gateway.ts";
import { CoalescedSnapshot } from "../../lib/coalescedSnapshot.ts";

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

/**
 * Performs to display model name.
 * @param model Model value.
 * @returns To display model name result.
 */

async function loadGatewaySessionsForAgents(): Promise<GatewaySessionSummary[]> {
    const cached: GatewaySessionSummary[] = (() => {
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
    })();

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
    } catch {
        // Fall back to cached sessions below
    }
    return cached;
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

/**
 * Performs now iso.
 * @returns Now iso result.
 */
