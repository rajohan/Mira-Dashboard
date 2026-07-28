import { type JobExecutionSummary, parseJobExecutionSummary } from "./jobs";
import {
    contractArray,
    contractFiniteNumber,
    contractRecord,
    contractString,
    invalidContract,
    optionalContractString,
    requiresContractBoolean,
} from "./runtime";

export interface ChildProcessMetrics {
    active: number;
    averageDurationMs: number;
    failed: number;
    lastDurationMs: number;
    maxDurationMs: number;
    started: number;
    succeeded: number;
    totalDurationMs: number;
}

export interface CoalescedSnapshotMetrics {
    activeLoads: number;
    averageLoadMs: number;
    coalescedHits: number;
    failures: number;
    freshHits: number;
    lastLoadMs: number;
    loads: number;
    name: string;
    requests: number;
    staleHits: number;
}

export interface HttpRouteMetrics {
    averageDurationMs: number;
    errors: number;
    maxDurationMs: number;
    method: string;
    requests: number;
    route: string;
    statusCodes: Record<string, number>;
}

export interface HttpRequestMetrics {
    averageDurationMs: number;
    errors: number;
    maxDurationMs: number;
    requests: number;
    routes: HttpRouteMetrics[];
}

export interface RuntimeMetrics {
    eventLoopDelayMs: number;
    externalBytes: number;
    heapTotalBytes: number;
    heapUsedBytes: number;
    rssBytes: number;
    uptimeSeconds: number;
}

export interface CacheRefreshMetrics {
    active: number;
    averageDurationMs: number;
    coalesced: number;
    failures: number;
    lastDurationMs: number;
    maxDurationMs: number;
    refreshes: number;
    requests: number;
    totalDurationMs: number;
}

export interface DatabaseMetrics {
    available: boolean;
    averageDurationMs: number;
    fileBytes: number;
    freelistBytes: number;
    freelistPages: number;
    freelistPercent: number;
    latencyMs: number;
    lockErrors: number;
    maxDurationMs: number;
    operations: number;
    shmBytes: number;
    walBytes: number;
}

export interface GatewayMetrics {
    connectFailures: number;
    connected: boolean;
    connections: number;
    disconnects: number;
    lastConnectedAt?: string;
    lastDisconnectedAt?: string;
    pendingRequests: number;
    reconnects: number;
}

export interface SchedulerMetrics extends JobExecutionSummary {
    dueJobs: number;
    executorActive: boolean;
    executorTickRunning: boolean;
    lastTickAt?: string;
    lastTickDurationMs: number;
    oldestDueAt?: string;
    queueFailures: number;
    scheduleLagMs: number;
    schedulerActive: boolean;
    schedulerTickRunning: boolean;
    tickFailures: number;
    ticks: number;
}

export interface AppObservabilityMetrics {
    cacheRefresh: CacheRefreshMetrics;
    database: DatabaseMetrics;
    gateway: GatewayMetrics;
    processes: ChildProcessMetrics;
    runtime: RuntimeMetrics;
    scheduler: SchedulerMetrics;
}

export interface Metrics {
    cacheRefresh: CacheRefreshMetrics;
    cpu: {
        count: number;
        loadAvg: number[];
        loadPercent: number;
        model: string;
    };
    disk: {
        percent: number;
        total: number;
        totalGB: number;
        used: number;
        usedGB: number;
    };
    database: DatabaseMetrics;
    gateway: GatewayMetrics;
    http: HttpRequestMetrics;
    memory: {
        free: number;
        percent: number;
        total: number;
        totalGB: number;
        used: number;
        usedGB: number;
    };
    network: {
        downloadMbps: number;
        uploadMbps: number;
    };
    polling: {
        snapshots: CoalescedSnapshotMetrics[];
    };
    processes: ChildProcessMetrics;
    runtime: RuntimeMetrics;
    scheduler: SchedulerMetrics;
    system: {
        hostname: string;
        platform: string;
        uptime: number;
    };
    timestamp: number;
    tokens: {
        byAgent: Array<{
            label: string;
            model: string;
            tokens: number;
            type: string;
        }>;
        byModel: Record<string, number>;
        sessionsByModel: Record<string, number>;
        total: number;
    };
}

function numberField(input: Record<string, unknown>, key: string, path: string): number {
    return contractFiniteNumber(input[key], `${path}.${key}`);
}

function stringField(input: Record<string, unknown>, key: string, path: string): string {
    return contractString(input[key], `${path}.${key}`, {
        allowEmpty: true,
        trim: false,
    });
}

function numberRecord(value: unknown, path: string): Record<string, number> {
    const input = contractRecord(value, path);
    return Object.fromEntries(
        Object.entries(input).map(([key, entry]) => [
            key,
            contractFiniteNumber(entry, `${path}.${key}`),
        ])
    );
}

function numberArray(value: unknown, path: string): number[] {
    if (!Array.isArray(value)) {
        return invalidContract(path, "must be an array");
    }
    return value.map((entry, index) => contractFiniteNumber(entry, `${path}[${index}]`));
}

function parseChildProcessMetrics(value: unknown, path: string): ChildProcessMetrics {
    const input = contractRecord(value, path);
    return {
        active: numberField(input, "active", path),
        averageDurationMs: numberField(input, "averageDurationMs", path),
        failed: numberField(input, "failed", path),
        lastDurationMs: numberField(input, "lastDurationMs", path),
        maxDurationMs: numberField(input, "maxDurationMs", path),
        started: numberField(input, "started", path),
        succeeded: numberField(input, "succeeded", path),
        totalDurationMs: numberField(input, "totalDurationMs", path),
    };
}

function parseCacheRefreshMetrics(value: unknown, path: string): CacheRefreshMetrics {
    const input = contractRecord(value, path);
    return {
        active: numberField(input, "active", path),
        averageDurationMs: numberField(input, "averageDurationMs", path),
        coalesced: numberField(input, "coalesced", path),
        failures: numberField(input, "failures", path),
        lastDurationMs: numberField(input, "lastDurationMs", path),
        maxDurationMs: numberField(input, "maxDurationMs", path),
        refreshes: numberField(input, "refreshes", path),
        requests: numberField(input, "requests", path),
        totalDurationMs: numberField(input, "totalDurationMs", path),
    };
}

function parseDatabaseMetrics(value: unknown, path: string): DatabaseMetrics {
    const input = contractRecord(value, path);
    return {
        available: requiresContractBoolean(input.available, `${path}.available`),
        averageDurationMs: numberField(input, "averageDurationMs", path),
        fileBytes: numberField(input, "fileBytes", path),
        freelistBytes: numberField(input, "freelistBytes", path),
        freelistPages: numberField(input, "freelistPages", path),
        freelistPercent: numberField(input, "freelistPercent", path),
        latencyMs: numberField(input, "latencyMs", path),
        lockErrors: numberField(input, "lockErrors", path),
        maxDurationMs: numberField(input, "maxDurationMs", path),
        operations: numberField(input, "operations", path),
        shmBytes: numberField(input, "shmBytes", path),
        walBytes: numberField(input, "walBytes", path),
    };
}

function parseGatewayMetrics(value: unknown, path: string): GatewayMetrics {
    const input = contractRecord(value, path);
    const lastConnectedAt = optionalContractString(
        input.lastConnectedAt,
        `${path}.lastConnectedAt`
    );
    const lastDisconnectedAt = optionalContractString(
        input.lastDisconnectedAt,
        `${path}.lastDisconnectedAt`
    );
    return {
        connectFailures: numberField(input, "connectFailures", path),
        connected: requiresContractBoolean(input.connected, `${path}.connected`),
        connections: numberField(input, "connections", path),
        disconnects: numberField(input, "disconnects", path),
        pendingRequests: numberField(input, "pendingRequests", path),
        reconnects: numberField(input, "reconnects", path),
        ...(lastConnectedAt !== undefined && { lastConnectedAt }),
        ...(lastDisconnectedAt !== undefined && { lastDisconnectedAt }),
    };
}

function parseRuntimeMetrics(value: unknown, path: string): RuntimeMetrics {
    const input = contractRecord(value, path);
    return {
        eventLoopDelayMs: numberField(input, "eventLoopDelayMs", path),
        externalBytes: numberField(input, "externalBytes", path),
        heapTotalBytes: numberField(input, "heapTotalBytes", path),
        heapUsedBytes: numberField(input, "heapUsedBytes", path),
        rssBytes: numberField(input, "rssBytes", path),
        uptimeSeconds: numberField(input, "uptimeSeconds", path),
    };
}

function parseSchedulerMetrics(value: unknown, path: string): SchedulerMetrics {
    const input = contractRecord(value, path);
    const queue = parseJobExecutionSummary(input, path);
    const lastTickAt = optionalContractString(input.lastTickAt, `${path}.lastTickAt`);
    const oldestDueAt = optionalContractString(input.oldestDueAt, `${path}.oldestDueAt`);
    return {
        ...queue,
        dueJobs: numberField(input, "dueJobs", path),
        executorActive: requiresContractBoolean(
            input.executorActive,
            `${path}.executorActive`
        ),
        executorTickRunning: requiresContractBoolean(
            input.executorTickRunning,
            `${path}.executorTickRunning`
        ),
        lastTickDurationMs: numberField(input, "lastTickDurationMs", path),
        queueFailures: numberField(input, "queueFailures", path),
        queued: numberField(input, "queued", path),
        running: numberField(input, "running", path),
        scheduleLagMs: numberField(input, "scheduleLagMs", path),
        schedulerActive: requiresContractBoolean(
            input.schedulerActive,
            `${path}.schedulerActive`
        ),
        schedulerTickRunning: requiresContractBoolean(
            input.schedulerTickRunning,
            `${path}.schedulerTickRunning`
        ),
        tickFailures: numberField(input, "tickFailures", path),
        ticks: numberField(input, "ticks", path),
        ...(lastTickAt !== undefined && { lastTickAt }),
        ...(oldestDueAt !== undefined && { oldestDueAt }),
    };
}

/** Parses the observability subset shared by diagnostics and metrics. */
export function parseAppObservabilityMetrics(
    value: unknown,
    path = "response.observability"
): AppObservabilityMetrics {
    const input = contractRecord(value, path);
    return {
        cacheRefresh: parseCacheRefreshMetrics(
            input.cacheRefresh,
            `${path}.cacheRefresh`
        ),
        database: parseDatabaseMetrics(input.database, `${path}.database`),
        gateway: parseGatewayMetrics(input.gateway, `${path}.gateway`),
        processes: parseChildProcessMetrics(input.processes, `${path}.processes`),
        runtime: parseRuntimeMetrics(input.runtime, `${path}.runtime`),
        scheduler: parseSchedulerMetrics(input.scheduler, `${path}.scheduler`),
    };
}

function parseHttpRouteMetrics(value: unknown, path: string): HttpRouteMetrics {
    const input = contractRecord(value, path);
    return {
        averageDurationMs: numberField(input, "averageDurationMs", path),
        errors: numberField(input, "errors", path),
        maxDurationMs: numberField(input, "maxDurationMs", path),
        method: stringField(input, "method", path),
        requests: numberField(input, "requests", path),
        route: stringField(input, "route", path),
        statusCodes: numberRecord(input.statusCodes, `${path}.statusCodes`),
    };
}

function parseHttpRequestMetrics(value: unknown, path: string): HttpRequestMetrics {
    const input = contractRecord(value, path);
    if (!Array.isArray(input.routes)) {
        return invalidContract(`${path}.routes`, "must be an array");
    }
    return {
        averageDurationMs: numberField(input, "averageDurationMs", path),
        errors: numberField(input, "errors", path),
        maxDurationMs: numberField(input, "maxDurationMs", path),
        requests: numberField(input, "requests", path),
        routes: input.routes.map((route, index) =>
            parseHttpRouteMetrics(route, `${path}.routes[${index}]`)
        ),
    };
}

function parseCoalescedSnapshotMetrics(
    value: unknown,
    path: string
): CoalescedSnapshotMetrics {
    const input = contractRecord(value, path);
    return {
        activeLoads: numberField(input, "activeLoads", path),
        averageLoadMs: numberField(input, "averageLoadMs", path),
        coalescedHits: numberField(input, "coalescedHits", path),
        failures: numberField(input, "failures", path),
        freshHits: numberField(input, "freshHits", path),
        lastLoadMs: numberField(input, "lastLoadMs", path),
        loads: numberField(input, "loads", path),
        name: stringField(input, "name", path),
        requests: numberField(input, "requests", path),
        staleHits: numberField(input, "staleHits", path),
    };
}

/** Parses the authenticated metrics response before frontend state accepts it. */
export function parseMetricsResponse(value: unknown): Metrics {
    const input = contractRecord(value, "response");
    const polling = contractRecord(input.polling, "response.polling");
    const cpu = contractRecord(input.cpu, "response.cpu");
    const disk = contractRecord(input.disk, "response.disk");
    const memory = contractRecord(input.memory, "response.memory");
    const network = contractRecord(input.network, "response.network");
    const system = contractRecord(input.system, "response.system");
    const tokens = contractRecord(input.tokens, "response.tokens");
    const pollingSnapshots = contractArray(
        polling.snapshots,
        "response.polling.snapshots"
    );
    const tokenAgents = contractArray(tokens.byAgent, "response.tokens.byAgent");
    return {
        ...parseAppObservabilityMetrics(input, "response"),
        cpu: {
            count: numberField(cpu, "count", "response.cpu"),
            loadAvg: numberArray(cpu.loadAvg, "response.cpu.loadAvg"),
            loadPercent: numberField(cpu, "loadPercent", "response.cpu"),
            model: stringField(cpu, "model", "response.cpu"),
        },
        disk: {
            percent: numberField(disk, "percent", "response.disk"),
            total: numberField(disk, "total", "response.disk"),
            totalGB: numberField(disk, "totalGB", "response.disk"),
            used: numberField(disk, "used", "response.disk"),
            usedGB: numberField(disk, "usedGB", "response.disk"),
        },
        http: parseHttpRequestMetrics(input.http, "response.http"),
        memory: {
            free: numberField(memory, "free", "response.memory"),
            percent: numberField(memory, "percent", "response.memory"),
            total: numberField(memory, "total", "response.memory"),
            totalGB: numberField(memory, "totalGB", "response.memory"),
            used: numberField(memory, "used", "response.memory"),
            usedGB: numberField(memory, "usedGB", "response.memory"),
        },
        network: {
            downloadMbps: numberField(network, "downloadMbps", "response.network"),
            uploadMbps: numberField(network, "uploadMbps", "response.network"),
        },
        polling: {
            snapshots: pollingSnapshots.map((snapshot, index) =>
                parseCoalescedSnapshotMetrics(
                    snapshot,
                    `response.polling.snapshots[${index}]`
                )
            ),
        },
        system: {
            hostname: stringField(system, "hostname", "response.system"),
            platform: stringField(system, "platform", "response.system"),
            uptime: numberField(system, "uptime", "response.system"),
        },
        timestamp: numberField(input, "timestamp", "response"),
        tokens: {
            byAgent: tokenAgents.map((agent, index) => {
                const entry = contractRecord(agent, `response.tokens.byAgent[${index}]`);
                return {
                    label: stringField(
                        entry,
                        "label",
                        `response.tokens.byAgent[${index}]`
                    ),
                    model: stringField(
                        entry,
                        "model",
                        `response.tokens.byAgent[${index}]`
                    ),
                    tokens: numberField(
                        entry,
                        "tokens",
                        `response.tokens.byAgent[${index}]`
                    ),
                    type: stringField(entry, "type", `response.tokens.byAgent[${index}]`),
                };
            }),
            byModel: numberRecord(tokens.byModel, "response.tokens.byModel"),
            sessionsByModel: numberRecord(
                tokens.sessionsByModel,
                "response.tokens.sessionsByModel"
            ),
            total: numberField(tokens, "total", "response.tokens"),
        },
    };
}
