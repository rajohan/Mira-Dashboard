import { getCacheEntry, parseJsonField } from "./cacheStore.ts";

/** Represents cached OpenClaw version. */
export interface CachedOpenClawVersion {
    current: string;
    latest: string | undefined;
    updateAvailable: boolean;
    checkedAt: number;
}

/** Represents the system host payload. */
interface SystemHostPayload {
    version?: CachedOpenClawVersion;
    gateway?: Record<string, unknown> | undefined;
    gatewayService?: Record<string, unknown> | undefined;
    nodeService?: Record<string, unknown> | undefined;
    heartbeat?: Record<string, unknown> | undefined;
    tasks?: Record<string, unknown> | undefined;
    taskAudit?: Record<string, unknown> | undefined;
    doctorWarnings?: string[];
    doctorWarningCount?: number;
    security?: Record<string, unknown> | undefined;
    checkedAt?: string;
}

function normalizeCacheNulls(value: unknown): unknown {
    if (value === null) {
        return undefined;
    }
    if (Array.isArray(value)) {
        return value.map((entry) => normalizeCacheNulls(entry));
    }
    if (typeof value === "object" && value !== null) {
        return Object.fromEntries(
            Object.entries(value).map(([key, entry]) => [key, normalizeCacheNulls(entry)])
        );
    }
    return value;
}

/** Represents the cached system host API response. */
export interface CachedSystemHostResponse {
    source: string;
    status: string;
    updatedAt: string | undefined;
    expiresAt: string | undefined;
    errorCode: string | undefined;
    errorMessage: string | undefined;
    consecutiveFailures: number;
    data: SystemHostPayload;
    meta: Record<string, unknown>;
}

/** Fetches cached system host. */
export async function fetchCachedSystemHost(): Promise<CachedSystemHostResponse> {
    const row = await getCacheEntry("system.host");
    if (!row || row.status !== "fresh") {
        throw new Error("System host cache entry not found or not fresh");
    }

    const parsedData = parseJsonField<SystemHostPayload>(row.data);
    if (!parsedData) {
        throw new Error("System host cache payload is invalid");
    }
    const data = normalizeCacheNulls(parsedData) as SystemHostPayload;

    return {
        source: row.source,
        status: row.status,
        updatedAt: row.updated_at || undefined,
        expiresAt: row.expires_at || undefined,
        errorCode: row.error_code || undefined,
        errorMessage: row.error_message || undefined,
        consecutiveFailures: Number(row.consecutive_failures),
        data,
        meta: parseJsonField<Record<string, unknown>>(row.meta) ?? {},
    };
}
