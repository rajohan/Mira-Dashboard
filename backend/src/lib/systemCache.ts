import { getCacheEntry, parseJsonField } from "./cacheStore.js";

export interface CachedOpenClawVersion {
    current: string;
    latest: string | null;
    updateAvailable: boolean;
    checkedAt: number;
}

interface SystemOpenClawPayload {
    version?: CachedOpenClawVersion;
    gateway?: Record<string, unknown> | null;
    gatewayService?: Record<string, unknown> | null;
    nodeService?: Record<string, unknown> | null;
    heartbeat?: Record<string, unknown> | null;
    tasks?: Record<string, unknown> | null;
    taskAudit?: Record<string, unknown> | null;
    doctorWarnings?: string[];
    doctorWarningCount?: number;
    security?: Record<string, unknown> | null;
    checkedAt?: string;
}

export interface CachedSystemOpenClawResponse {
    source: string;
    status: string;
    updatedAt: string | null;
    expiresAt: string | null;
    errorCode: string | null;
    errorMessage: string | null;
    consecutiveFailures: number;
    data: SystemOpenClawPayload;
    meta: Record<string, unknown>;
}

export async function fetchCachedSystemOpenClaw(): Promise<CachedSystemOpenClawResponse> {
    const row = await getCacheEntry("system.openclaw");
    if (!row || row.status !== "fresh") {
        throw new Error("System OpenClaw cache entry not found or not fresh");
    }

    const data = parseJsonField<SystemOpenClawPayload>(row.data);
    if (!data) {
        throw new Error("System OpenClaw cache payload is invalid");
    }

    return {
        source: row.source,
        status: row.status,
        updatedAt: row.updated_at || null,
        expiresAt: row.expires_at || null,
        errorCode: row.error_code || null,
        errorMessage: row.error_message || null,
        consecutiveFailures: Number(row.consecutive_failures || 0),
        data,
        meta: parseJsonField<Record<string, unknown>>(row.meta) ?? {},
    };
}
