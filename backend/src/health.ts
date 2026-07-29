import type {
    DashboardDiagnosticsResponse,
    DashboardLivenessResponse,
    DashboardReadinessSnapshot,
    DatabaseReadiness,
    RuntimeReleaseIdentity,
} from "../../contracts/health.ts";
import { database } from "./database.ts";
import { validateDatabaseMigrationHistory } from "./databaseMigrationRunner.ts";
import {
    DASHBOARD_DATABASE_SCHEMA_COMPATIBILITY,
    isDatabaseSchemaCompatible,
} from "./databaseSchemaCompatibility.ts";
import { isFrontendIndexReady } from "./frontendAssets.ts";
import gateway from "./gateway.ts";
import { createStructuredLogger } from "./lib/structuredLogger.ts";
import { getAppObservabilityMetrics } from "./observability.ts";
import { getRuntimeReleaseIdentity } from "./releaseManifest.ts";
import {
    getJobExecutionSummary,
    isJobWorkerReleaseReady,
} from "./services/jobExecutionQueue.ts";

const logger = createStructuredLogger("health");

export interface ReadinessSignals {
    database: DatabaseReadiness;
    frontendReady: boolean;
    gatewayConnected: boolean;
    release: RuntimeReleaseIdentity;
    sessionCount: number;
    workerReady: boolean;
}

function databaseReadiness(): DatabaseReadiness {
    try {
        database.query("SELECT 1").get();
        const currentSchemaVersion = validateDatabaseMigrationHistory(database);
        return {
            currentSchemaVersion,
            maximumCompatibleSchemaVersion:
                DASHBOARD_DATABASE_SCHEMA_COMPATIBILITY.maximum,
            minimumCompatibleSchemaVersion:
                DASHBOARD_DATABASE_SCHEMA_COMPATIBILITY.minimum,
            ready: isDatabaseSchemaCompatible(currentSchemaVersion),
            targetSchemaVersion: DASHBOARD_DATABASE_SCHEMA_COMPATIBILITY.target,
        };
    } catch (error) {
        logger.warn("health.database_readiness_failed", { error });
        return {
            maximumCompatibleSchemaVersion:
                DASHBOARD_DATABASE_SCHEMA_COMPATIBILITY.maximum,
            minimumCompatibleSchemaVersion:
                DASHBOARD_DATABASE_SCHEMA_COMPATIBILITY.minimum,
            ready: false,
            targetSchemaVersion: DASHBOARD_DATABASE_SCHEMA_COMPATIBILITY.target,
        };
    }
}

function isWorkerReady(release: RuntimeReleaseIdentity): boolean {
    try {
        if (release.source === "manifest" && release.commitSha) {
            return isJobWorkerReleaseReady(release.commitSha);
        }
        return getJobExecutionSummary().workerOnline;
    } catch (error) {
        logger.warn("health.worker_telemetry_read_failed", { error });
        return false;
    }
}

export async function collectReadinessSignals(): Promise<ReadinessSignals> {
    const release = await getRuntimeReleaseIdentity();
    return {
        database: databaseReadiness(),
        frontendReady: isFrontendIndexReady(),
        gatewayConnected: gateway.isConnected(),
        release,
        sessionCount: gateway.getSessions().length,
        workerReady: isWorkerReady(release),
    };
}

export function evaluateReadiness(signals: ReadinessSignals): DashboardReadinessSnapshot {
    const ready =
        signals.database.ready &&
        signals.frontendReady &&
        signals.release.ready &&
        signals.workerReady;
    return {
        checks: {
            database: signals.database,
            frontend: { ready: signals.frontendReady },
            release: {
                backendCommit: signals.release.backendCommit,
                frontendCommit: signals.release.frontendCommit,
                ...(signals.release.issue && { issue: signals.release.issue }),
                ...(signals.release.manifestFormatVersion !== undefined && {
                    manifestFormatVersion: signals.release.manifestFormatVersion,
                }),
                ready: signals.release.ready,
                source: signals.release.source,
            },
            worker: { ready: signals.workerReady },
        },
        dependencies: {
            // Gateway availability is diagnostic. A Gateway outage cannot be
            // repaired by rolling Dashboard code back.
            gatewayConnected: signals.gatewayConnected,
        },
        status: ready ? "isReady" : "notReady",
    };
}

export function livenessSnapshot(): DashboardLivenessResponse {
    return {
        status: "isOk" as const,
        uptimeSeconds: Math.floor(process.uptime()),
    };
}

export async function readinessSnapshot(): Promise<DashboardReadinessSnapshot> {
    return evaluateReadiness(await collectReadinessSignals());
}

export async function diagnosticsSnapshot(): Promise<DashboardDiagnosticsResponse> {
    const [signals, observability] = await Promise.all([
        collectReadinessSignals(),
        getAppObservabilityMetrics(),
    ]);
    return {
        ...evaluateReadiness(signals),
        observability,
        releaseDetails: signals.release,
        sessionCount: signals.sessionCount,
    };
}
