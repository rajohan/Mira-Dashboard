import { constants } from "node:fs";
import { open } from "node:fs/promises";

import * as v from "valibot";

import {
    cacheHeartbeatResultSchema,
    cacheHeartbeatSchemaVersion,
    type CacheHeartbeatResult,
} from "../src/contracts/cache.ts";
import {
    completeMonitoringSnapshotInputSchema,
    monitoringMutationInputMaximumBytes,
    monitoringSubmissionResultSchema,
    type CompleteMonitoringSnapshotInput,
    type MonitoringSubmissionResult,
} from "../src/contracts/monitoring.ts";
import { opaqueTokenSchema } from "../src/contracts/security.ts";

const dashboardOrigin = "http://127.0.0.1:3100";
const requestTimeoutMs = 30_000;
const responseMaximumBytes = 1024 * 1024;
const credentialMaximumBytes = 128;
const credentialPath =
    "/home/ubuntu/.config/mira-dashboard/automation/openclaw-heartbeat.token";
const collectProcedure = "cache.getHeartbeat";
const reportProcedure = "monitoring.submitCompleteSnapshot";
const safeFailureMessage = "OpenClaw heartbeat automation failed";

export const openClawHeartbeatAutomationProfile = Object.freeze({
    capabilities: Object.freeze(["cache:read", "monitoring:write"] as const),
    credentialFile: "openclaw-heartbeat.token",
    id: "openclaw-heartbeat",
});

interface TrpcSuccessEnvelope {
    readonly result: {
        readonly data: {
            readonly json: unknown;
        };
    };
}

const trpcSuccessEnvelopeSchema = v.strictObject({
    result: v.strictObject({
        data: v.strictObject({ json: v.unknown() }),
    }),
});

export interface OpenClawHeartbeatDependencies {
    readonly fetch?: (
        input: string | URL | Request,
        init?: RequestInit
    ) => Promise<Response>;
    readonly readCredential?: () => Promise<string>;
    readonly readStandardInput?: () => Promise<string>;
    readonly writeStandardOutput?: (value: string) => void;
    readonly generateRunId?: () => string;
}

function failure(): Error {
    return new Error(safeFailureMessage);
}

async function readBoundedStream(
    stream: ReadableStream<Uint8Array>,
    maximumBytes: number
): Promise<Uint8Array> {
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
        while (true) {
            const next = await reader.read();
            if (next.done) break;
            length += next.value.byteLength;
            if (length > maximumBytes) {
                await reader.cancel().catch(() => {});
                throw failure();
            }
            chunks.push(next.value);
        }
    } finally {
        reader.releaseLock();
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return bytes;
}

function decodeJson(bytes: Uint8Array): unknown {
    try {
        return JSON.parse(
            new TextDecoder("utf-8", { fatal: true }).decode(bytes)
        ) as unknown;
    } catch {
        throw failure();
    }
}

async function readBoundedResponse(response: Response): Promise<unknown> {
    const declaredLength = response.headers.get("content-length");
    if (
        declaredLength !== null &&
        (!/^(?:0|[1-9][0-9]*)$/u.test(declaredLength) ||
            Number(declaredLength) > responseMaximumBytes)
    ) {
        await response.body?.cancel().catch(() => {});
        throw failure();
    }
    if (!response.ok || response.body === null) {
        await response.body?.cancel().catch(() => {});
        throw failure();
    }
    return decodeJson(await readBoundedStream(response.body, responseMaximumBytes));
}

function parseEnvelope(value: unknown): TrpcSuccessEnvelope {
    const parsed = v.safeParse(trpcSuccessEnvelopeSchema, value);
    if (!parsed.success) throw failure();
    return parsed.output;
}

async function readCredential(): Promise<string> {
    try {
        // Bun.file follows symlinks. The descriptor flags are required for this secret.
        const file = await open(
            credentialPath,
            constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
        );
        try {
            const status = await file.stat();
            if (
                !status.isFile() ||
                (status.mode & 0o777) !== 0o600 ||
                status.size === 0 ||
                status.size > credentialMaximumBytes ||
                (typeof process.getuid === "function" && status.uid !== process.getuid())
            ) {
                throw failure();
            }
            const bytes = new Uint8Array(credentialMaximumBytes + 1);
            const { bytesRead } = await file.read(bytes, 0, bytes.byteLength, 0);
            if (bytesRead > credentialMaximumBytes) throw failure();
            const contents = new TextDecoder("utf-8", { fatal: true }).decode(
                bytes.subarray(0, bytesRead)
            );
            const token = contents.trim();
            const parsed = v.safeParse(opaqueTokenSchema, token);
            if (!parsed.success) throw failure();
            return parsed.output;
        } finally {
            await file.close();
        }
    } catch {
        throw failure();
    }
}

async function readStandardInput(): Promise<string> {
    try {
        const bytes = await readBoundedStream(
            Bun.stdin.stream(),
            monitoringMutationInputMaximumBytes
        );
        return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
        throw failure();
    }
}

function parseSnapshot(
    value: string,
    generateRunId: () => string
): CompleteMonitoringSnapshotInput {
    try {
        const agentSnapshot = JSON.parse(value) as unknown;
        if (
            typeof agentSnapshot !== "object" ||
            agentSnapshot === null ||
            Array.isArray(agentSnapshot)
        ) {
            throw failure();
        }
        return v.parse(completeMonitoringSnapshotInputSchema, {
            ...agentSnapshot,
            runId: generateRunId(),
        });
    } catch {
        throw failure();
    }
}

async function requestProcedure(
    dependencies: OpenClawHeartbeatDependencies,
    procedure: typeof collectProcedure | typeof reportProcedure,
    input: unknown,
    method: "GET" | "POST"
): Promise<unknown> {
    const readToken = dependencies.readCredential ?? readCredential;
    const token = await readToken().catch(() => {
        throw failure();
    });
    const parsedToken = v.safeParse(opaqueTokenSchema, token);
    if (!parsedToken.success) throw failure();
    let baseUrl: URL;
    try {
        baseUrl = new URL(dashboardOrigin);
    } catch {
        throw failure();
    }
    if (
        baseUrl.protocol !== "http:" ||
        baseUrl.hostname !== "127.0.0.1" ||
        baseUrl.username !== "" ||
        baseUrl.password !== "" ||
        baseUrl.pathname !== "/" ||
        baseUrl.search !== "" ||
        baseUrl.hash !== ""
    ) {
        throw failure();
    }
    const encodedInput = JSON.stringify({ json: input });
    const url = new URL(`/trpc/${procedure}`, baseUrl);
    if (method === "GET") url.searchParams.set("input", encodedInput);
    let response: Response;
    try {
        response = await (dependencies.fetch ?? globalThis.fetch)(url, {
            ...(method === "POST" ? { body: encodedInput } : {}),
            headers: {
                Accept: "application/json",
                Authorization: `Bearer ${parsedToken.output}`,
                ...(method === "POST" ? { "Content-Type": "application/json" } : {}),
                "User-Agent": "mira-dashboard-openclaw-heartbeat/1.0",
            },
            method,
            redirect: "error",
            signal: AbortSignal.timeout(requestTimeoutMs),
        });
    } catch {
        throw failure();
    }
    return parseEnvelope(await readBoundedResponse(response)).result.data.json;
}

/**
 * Performs the one allowed heartbeat collection request and validates schema v5.
 * @param dependencies Injected transport seams used by focused tests.
 * @returns One strict payload-free heartbeat v5 snapshot.
 */
export async function collectOpenClawHeartbeat(
    dependencies: OpenClawHeartbeatDependencies = {}
): Promise<CacheHeartbeatResult> {
    const result = v.safeParse(
        cacheHeartbeatResultSchema,
        await requestProcedure(dependencies, collectProcedure, {}, "GET")
    );
    if (!result.success || result.output.schemaVersion !== cacheHeartbeatSchemaVersion) {
        throw failure();
    }
    return result.output;
}

/**
 * Performs the one allowed complete-monitoring-snapshot report request.
 * @param snapshot Complete replacement monitoring snapshot.
 * @param dependencies Injected transport seams used by focused tests.
 * @returns The causally matching monitoring-ingestion result.
 */
export async function reportOpenClawHeartbeat(
    snapshot: CompleteMonitoringSnapshotInput,
    dependencies: OpenClawHeartbeatDependencies = {}
): Promise<MonitoringSubmissionResult> {
    const validatedSnapshot = v.safeParse(
        completeMonitoringSnapshotInputSchema,
        snapshot
    );
    if (!validatedSnapshot.success) throw failure();
    const result = v.safeParse(
        monitoringSubmissionResultSchema,
        await requestProcedure(
            dependencies,
            reportProcedure,
            validatedSnapshot.output,
            "POST"
        )
    );
    if (!result.success || result.output.runId !== validatedSnapshot.output.runId) {
        throw failure();
    }
    return result.output;
}

/**
 * Runs the fixed two-command CLI without exposing a generic tRPC procedure boundary.
 * @param arguments_ Exact one-word collect or report operation.
 * @param dependencies Injected process and transport seams used by focused tests.
 * @returns Nothing after writing one validated JSON result.
 */
export async function runOpenClawHeartbeatCommand(
    arguments_: readonly string[],
    dependencies: OpenClawHeartbeatDependencies = {}
): Promise<void> {
    if (arguments_.length !== 1) throw failure();
    const write =
        dependencies.writeStandardOutput ?? ((value) => process.stdout.write(value));
    if (arguments_[0] === "collect") {
        write(`${JSON.stringify(await collectOpenClawHeartbeat(dependencies))}\n`);
        return;
    }
    if (arguments_[0] === "report") {
        const readInput = dependencies.readStandardInput ?? readStandardInput;
        const snapshot = parseSnapshot(
            await readInput(),
            dependencies.generateRunId ?? (() => Bun.randomUUIDv7())
        );
        write(
            `${JSON.stringify(await reportOpenClawHeartbeat(snapshot, dependencies))}\n`
        );
        return;
    }
    throw failure();
}

if (import.meta.main) {
    try {
        await runOpenClawHeartbeatCommand(Bun.argv.slice(2));
    } catch {
        console.error(safeFailureMessage);
        process.exitCode = 1;
    }
}
