import * as v from "valibot";

import {
    type AgentStatus,
    type AgentStatusProjection,
    agentStatusProjectionSchema,
} from "../../../contracts/agentModel.ts";
import type {
    GatewaySession,
    ListGatewaySessionsResult,
} from "../../../contracts/gatewaySessions.ts";
import { compareStrings } from "../../../shared/validation.ts";
import { GatewaySessionsUnavailableError } from "../gatewaySessions/errors.ts";
import type { GatewaySessionsService } from "../gatewaySessions/service.ts";

function sessionAgentId(key: string): string | undefined {
    const [prefix, agentId, firstScope] = key.split(":");
    return prefix === "agent" &&
        agentId !== undefined &&
        agentId.length > 0 &&
        firstScope !== undefined &&
        firstScope.length > 0
        ? agentId
        : undefined;
}

function lastSeenAtMs(session: GatewaySession): number | undefined {
    return (
        session.updatedAtMs ??
        session.endedAtMs ??
        session.startedAtMs ??
        session.createdAtMs
    );
}

function compareAvailabilityCandidates(
    left: GatewaySession,
    right: GatewaySession
): number {
    if (left.hasActiveRun !== right.hasActiveRun) return left.hasActiveRun ? -1 : 1;
    const leftLastSeen = lastSeenAtMs(left) ?? -1;
    const rightLastSeen = lastSeenAtMs(right) ?? -1;
    if (leftLastSeen !== rightLastSeen) return leftLastSeen > rightLastSeen ? -1 : 1;
    return compareStrings(left.key, right.key);
}

function providerModel(session: GatewaySession): string | undefined {
    if (session.modelProvider !== undefined && session.model !== undefined) {
        return `${session.modelProvider}/${session.model}`;
    }
    return session.modelProvider ?? session.model;
}

function unavailableProjection(status: AgentStatus): AgentStatusProjection {
    return v.parse(agentStatusProjectionSchema, {
        ...status,
        freshness: "unavailable",
        gatewayAvailability: "disconnected",
    });
}

function snapshotProjection(
    status: AgentStatus,
    snapshot: ListGatewaySessionsResult
): AgentStatusProjection {
    const session = snapshot.sessions
        .filter(({ key }) => sessionAgentId(key) === status.agentId)
        .toSorted(compareAvailabilityCandidates)[0];
    if (session === undefined) {
        return v.parse(agentStatusProjectionSchema, {
            ...status,
            freshness: snapshot.source.freshness,
            gatewayAvailability:
                snapshot.source.freshness === "fresh" || snapshot.projectionTruncated
                    ? "unknown"
                    : "disconnected",
            observedAtMs: snapshot.source.observedAtMs,
        });
    }
    const freshness = snapshot.source.freshness;
    let gatewayAvailability: "active" | "idle" | "stale" = "stale";
    if (freshness === "fresh") {
        gatewayAvailability = session.hasActiveRun ? "active" : "idle";
    }
    const sessionLastSeenAtMs = lastSeenAtMs(session);
    const sessionProviderModel = providerModel(session);
    return v.parse(agentStatusProjectionSchema, {
        ...status,
        freshness,
        gatewayAvailability,
        hasActiveRun: session.hasActiveRun,
        ...(sessionLastSeenAtMs === undefined
            ? {}
            : { lastSeenAtMs: sessionLastSeenAtMs }),
        observedAtMs: snapshot.source.observedAtMs,
        ...(sessionProviderModel === undefined
            ? {}
            : { providerModel: sessionProviderModel }),
        sessionKey: session.key,
    });
}

/**
 * Joins Dashboard-owned task states to a bounded Gateway sessions snapshot.
 * Provider rows can only enrich the supplied reviewed IDs and never create identities.
 * @param statuses Complete configured Dashboard task-state projection.
 * @param snapshot Fresh or last-known-good Gateway session snapshot, when available.
 * @returns Task states with a separate Gateway availability overlay.
 */
export function projectAgentGatewayAvailability(
    statuses: readonly AgentStatus[],
    snapshot?: ListGatewaySessionsResult
): AgentStatusProjection[] {
    return statuses.map((status) =>
        snapshot === undefined
            ? unavailableProjection(status)
            : snapshotProjection(status, snapshot)
    );
}

/**
 * Reads the shared sessions service and safely projects its last-known-good semantics.
 * @param statuses Complete configured Dashboard task-state projection.
 * @param gatewaySessionsService Process-owned Gateway sessions service.
 * @param signal Resolver cancellation propagated to the shared provider request.
 * @returns Task states enriched by fresh, stale, or unavailable session availability.
 */
export async function readAgentGatewayAvailability(
    statuses: readonly AgentStatus[],
    gatewaySessionsService: GatewaySessionsService,
    signal?: AbortSignal
): Promise<AgentStatusProjection[]> {
    try {
        const snapshot = await gatewaySessionsService.list({ filter: "ALL" }, signal);
        return projectAgentGatewayAvailability(statuses, snapshot);
    } catch (error) {
        if (error instanceof GatewaySessionsUnavailableError) {
            return projectAgentGatewayAvailability(statuses);
        }
        throw error;
    }
}
