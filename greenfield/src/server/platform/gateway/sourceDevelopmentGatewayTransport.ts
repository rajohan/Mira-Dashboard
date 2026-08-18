import { randomUUID } from "node:crypto";
import {
    constants,
    closeSync,
    fstatSync,
    fsyncSync,
    mkdirSync,
    openSync,
    readFileSync,
    realpathSync,
    unlinkSync,
    writeSync,
} from "node:fs";
import path from "node:path";

import * as v from "valibot";

import {
    assertPersistentGatewayAdminParameters,
    assertPersistentGatewayChatReadMutationParameters,
    assertPersistentGatewayChatWriteParameters,
    assertPersistentGatewayOpenClawSettingsWriteParameters,
    assertPersistentGatewayTaskWriteParameters,
    type PersistentGatewayAdminMethod,
    type PersistentGatewayChatReadMutationMethod,
    type PersistentGatewayChatWriteMethod,
    type PersistentGatewayOpenClawSettingsWriteMethod,
    type PersistentGatewayTaskWriteMethod,
} from "./persistentGatewayProtocol.ts";
import {
    PersistentGatewayCapacityError,
    type PersistentGatewayConnectionSnapshot,
    type PersistentGatewayRequestOptions,
    PersistentGatewayRequestError,
    type PersistentGatewayTransport,
} from "./persistentGatewayTransport.ts";

const developmentStateMarkerFileName = ".mira-dashboard-development-state.json";
const simulatorOwner = "mira-dashboard-source-development-v1";
const simulatorDirectoryName = "development-authority-simulator";
const gatewayJournalFileName = "gateway-mutations.ndjson";
const chatWriteCapabilityFileName = "chat-e2e-write-capability.json";
const chatWriteCapabilityOwner = "mira-dashboard-chat-e2e-v1";
const chatWriteCapabilityMaximumLifetimeMs = 10 * 60_000;
const simulatedCronInventoryMaximum = 1000;
const simulatedCronInventoryMaximumBytes = 32 * 1024 * 1024;
const simulatedCronMaterializationMaximum = 4;
const simulatedCronUpstreamPageMaximum = 100;

const developmentStateMarkerSchema = v.strictObject({
    formatVersion: v.literal(1),
    owner: v.literal(simulatorOwner),
});

const chatWriteCapabilitySchema = v.strictObject({
    capabilityId: v.pipe(v.string(), v.uuid()),
    expiresAtMs: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
    formatVersion: v.literal(1),
    owner: v.literal(chatWriteCapabilityOwner),
    sessionKey: v.pipe(v.string(), v.minLength(1), v.maxLength(512)),
});

export interface SourceDevelopmentChatWriteCapability {
    readonly revoke: () => void;
}

type SimulatedGatewayMethod =
    | PersistentGatewayAdminMethod
    | PersistentGatewayChatReadMutationMethod
    | PersistentGatewayChatWriteMethod
    | PersistentGatewayOpenClawSettingsWriteMethod
    | PersistentGatewayTaskWriteMethod;

export interface SourceDevelopmentGatewayTransportOptions {
    readonly nowMs?: () => number;
    readonly readTransport: SourceDevelopmentGatewayReadTransport;
    readonly stateRoot: string;
}

/** Live Gateway reads plus the exact capability-gated chat-write delegation. */
export type SourceDevelopmentGatewayReadTransport = Pick<
    PersistentGatewayTransport,
    | "request"
    | "requestAdmin"
    | "requestChatRead"
    | "requestChatWrite"
    | "requestOpenClawSettingsRead"
    | "requestTaskRead"
    | "snapshot"
    | "start"
    | "stop"
    | "subscribe"
    | "subscribeChat"
>;

interface CompanionExchange {
    readonly answer: string;
    readonly question: string;
    readonly ts: number;
}

interface SimulatedCronListSnapshot {
    readonly jobs: readonly unknown[];
    readonly upstreamRevision: string;
}

interface SimulatedCronListPage {
    readonly hasMore: boolean;
    readonly jobs: readonly unknown[];
    readonly limit: number;
    readonly nextOffset: number | null;
    readonly offset: number;
    readonly snapshotRevision: string;
    readonly total: number;
}

interface SimulatedCronMaterializationAdmission {
    readonly tryAcquire: () => SimulatedCronMaterializationLease | undefined;
}

interface SimulatedCronMaterializationLease {
    readonly release: () => void;
}

interface SimulatorState {
    readonly companionExchanges: Map<string, readonly CompanionExchange[]>;
    readonly cronMaterializationAdmission: SimulatedCronMaterializationAdmission;
    readonly observedResponses: Map<string, unknown>;
    readonly removedCronJobIds: Set<string>;
    readonly simulatedResponses: Map<string, unknown>;
}

function assertMarkedDevelopmentStateRoot(stateRoot: string): string {
    const canonical = realpathSync(stateRoot);
    if (
        canonical !== stateRoot ||
        !path.isAbsolute(canonical) ||
        canonical === path.parse(canonical).root
    ) {
        throw new Error("Development Gateway simulator state root is invalid");
    }
    const markerPath = path.join(canonical, developmentStateMarkerFileName);
    let descriptor: number;
    try {
        descriptor = openSync(
            markerPath,
            constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
        );
    } catch {
        throw new Error("Development Gateway simulator marker is invalid");
    }
    try {
        const markerStatus = fstatSync(descriptor);
        if (!markerStatus.isFile() || markerStatus.nlink !== 1) {
            throw new Error("invalid marker");
        }
        v.parse(
            developmentStateMarkerSchema,
            JSON.parse(readFileSync(descriptor, "utf8"))
        );
    } catch {
        throw new Error("Development Gateway simulator marker is invalid");
    } finally {
        closeSync(descriptor);
    }
    return canonical;
}

function checkedNow(nowMs: () => number): number {
    const now = nowMs();
    if (!Number.isSafeInteger(now) || now < 0) {
        throw new Error("Development Gateway simulator clock is invalid");
    }
    return now;
}

function simulatorDirectory(stateRoot: string): string {
    const directory = path.join(
        assertMarkedDevelopmentStateRoot(stateRoot),
        simulatorDirectoryName
    );
    mkdirSync(directory, { mode: 0o700, recursive: true });
    if (realpathSync(directory) !== directory) {
        throw new Error("Development Gateway simulator directory is invalid");
    }
    return directory;
}

/**
 * Grants one short-lived source-development browser probe authority to write to one
 * exact chat session. Ordinary development remains mutation-free.
 * @returns A revocable write capability scoped to the requested development session.
 */
export function createSourceDevelopmentChatWriteCapability(
    input: Readonly<{
        expiresAtMs: number;
        nowMs?: number;
        sessionKey: string;
        stateRoot: string;
    }>
): SourceDevelopmentChatWriteCapability {
    const now = input.nowMs ?? Date.now();
    const capability = v.parse(chatWriteCapabilitySchema, {
        capabilityId: randomUUID(),
        expiresAtMs: input.expiresAtMs,
        formatVersion: 1,
        owner: chatWriteCapabilityOwner,
        sessionKey: input.sessionKey,
    });
    if (
        capability.expiresAtMs <= now ||
        capability.expiresAtMs - now > chatWriteCapabilityMaximumLifetimeMs
    ) {
        throw new RangeError("Development chat write capability lifetime is invalid");
    }
    const capabilityPath = path.join(
        simulatorDirectory(input.stateRoot),
        chatWriteCapabilityFileName
    );
    let descriptor: number;
    try {
        descriptor = openSync(
            capabilityPath,
            constants.O_CREAT |
                constants.O_EXCL |
                constants.O_NOFOLLOW |
                constants.O_WRONLY,
            0o600
        );
    } catch (error) {
        if (!existingChatWriteCapabilityIsExpired(capabilityPath, now)) throw error;
        unlinkSync(capabilityPath);
        descriptor = openSync(
            capabilityPath,
            constants.O_CREAT |
                constants.O_EXCL |
                constants.O_NOFOLLOW |
                constants.O_WRONLY,
            0o600
        );
    }
    try {
        writeSync(descriptor, JSON.stringify(capability), undefined, "utf8");
        fsyncSync(descriptor);
    } finally {
        closeSync(descriptor);
    }
    let revoked = false;
    return Object.freeze({
        revoke(): void {
            if (revoked) return;
            revoked = true;
            if (
                readChatWriteCapability(capabilityPath)?.capabilityId ===
                capability.capabilityId
            ) {
                unlinkSync(capabilityPath);
            }
        },
    });
}

function readChatWriteCapability(
    capabilityPath: string
): v.InferOutput<typeof chatWriteCapabilitySchema> | undefined {
    try {
        const result = v.safeParse(
            chatWriteCapabilitySchema,
            JSON.parse(readFileSync(capabilityPath, "utf8"))
        );
        return result.success ? result.output : undefined;
    } catch {
        return undefined;
    }
}

function existingChatWriteCapabilityIsExpired(
    capabilityPath: string,
    nowMs: number
): boolean {
    let descriptor: number;
    try {
        descriptor = openSync(
            capabilityPath,
            constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
        );
    } catch {
        return false;
    }
    try {
        const status = fstatSync(descriptor);
        if (!status.isFile() || status.nlink !== 1 || (status.mode & 0o077) !== 0)
            return false;
        const parsed = v.safeParse(
            chatWriteCapabilitySchema,
            JSON.parse(readFileSync(descriptor, "utf8"))
        );
        return parsed.success && parsed.output.expiresAtMs <= nowMs;
    } catch {
        return false;
    } finally {
        closeSync(descriptor);
    }
}

function chatWriteIsAuthorized(
    input: Readonly<{
        capabilityPath: string;
        nowMs: () => number;
        parameters: Readonly<Record<string, unknown>>;
    }>
): boolean {
    let descriptor: number;
    try {
        descriptor = openSync(
            input.capabilityPath,
            constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
        );
    } catch {
        return false;
    }
    try {
        const status = fstatSync(descriptor);
        if (!status.isFile() || status.nlink !== 1 || (status.mode & 0o077) !== 0) {
            return false;
        }
        const parsed = v.safeParse(
            chatWriteCapabilitySchema,
            JSON.parse(readFileSync(descriptor, "utf8"))
        );
        return (
            parsed.success &&
            parsed.output.expiresAtMs > checkedNow(input.nowMs) &&
            parsed.output.sessionKey === input.parameters.sessionKey
        );
    } catch {
        return false;
    } finally {
        closeSync(descriptor);
    }
}

function parameterString(
    parameters: Readonly<Record<string, unknown>>,
    key: string,
    maximum = 512
): string {
    const value = parameters[key];
    if (typeof value !== "string" || value.length === 0 || value.length > maximum) {
        throw new TypeError("Development Gateway mutation parameters are invalid");
    }
    return value;
}

function readKey(method: string, parameters: Readonly<Record<string, unknown>>): string {
    return JSON.stringify([method, parameters]);
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        ? (value as Readonly<Record<string, unknown>>)
        : undefined;
}

function simulatedCronSnapshotRevision(
    upstreamRevision: unknown,
    removedCronJobIds: ReadonlySet<string>
): string {
    const serialized = JSON.stringify([
        upstreamRevision,
        [...removedCronJobIds].toSorted(),
    ]);
    return `sha256:${new Bun.CryptoHasher("sha256")
        .update(serialized)
        .digest("base64url")}`;
}

function cronListPageInteger(
    parameters: Readonly<Record<string, unknown>>,
    key: "limit" | "offset",
    minimum: number,
    maximum: number
): number {
    const value = parameters[key];
    if (
        typeof value !== "number" ||
        !Number.isSafeInteger(value) ||
        value < minimum ||
        value > maximum
    ) {
        throw new TypeError("Development cron list parameters are invalid");
    }
    return value;
}

function createSimulatedCronMaterializationAdmission(): SimulatedCronMaterializationAdmission {
    let active = 0;
    return Object.freeze({
        tryAcquire(): SimulatedCronMaterializationLease | undefined {
            if (active >= simulatedCronMaterializationMaximum) return;
            active += 1;
            let released = false;
            return Object.freeze({
                release(): void {
                    if (released) return;
                    released = true;
                    active -= 1;
                },
            });
        },
    });
}

function assertCronUpstreamPage(
    response: unknown,
    expectedOffset: number,
    admittedBytes: number,
    ids: Set<string>,
    expectedRevision?: string
): Readonly<{
    jobs: readonly unknown[];
    nextOffset: number | null;
    snapshotRevision: string;
    total: number;
}> {
    const page = asRecord(response);
    if (page === undefined) {
        throw new TypeError("Development cron inventory is invalid");
    }
    const rawJobs = page.jobs;
    if (!Array.isArray(rawJobs)) {
        throw new TypeError("Development cron inventory is invalid");
    }
    const jobs: readonly unknown[] = rawJobs;
    const { hasMore, limit, nextOffset, offset, snapshotRevision, total } = page;
    const consumed = expectedOffset + jobs.length;
    if (
        typeof hasMore !== "boolean" ||
        limit !== simulatedCronUpstreamPageMaximum ||
        offset !== expectedOffset ||
        typeof total !== "number" ||
        !Number.isSafeInteger(total) ||
        total < consumed ||
        total > simulatedCronInventoryMaximum ||
        jobs.length > simulatedCronUpstreamPageMaximum ||
        (hasMore && jobs.length === 0) ||
        hasMore !== consumed < total ||
        nextOffset !== (hasMore ? consumed : null) ||
        typeof snapshotRevision !== "string" ||
        (expectedRevision !== undefined && snapshotRevision !== expectedRevision) ||
        admittedBytes > simulatedCronInventoryMaximumBytes
    ) {
        throw new TypeError("Development cron inventory is invalid");
    }
    for (const job of jobs) {
        const id = asRecord(job)?.id;
        if (typeof id !== "string" || ids.has(id)) {
            throw new TypeError("Development cron inventory is invalid");
        }
        ids.add(id);
    }
    return Object.freeze({
        jobs: Object.freeze([...jobs]),
        nextOffset: typeof nextOffset === "number" ? nextOffset : null,
        snapshotRevision,
        total,
    });
}

async function materializeCronListSnapshot(
    parameters: Readonly<Record<string, unknown>>,
    requestOptions: PersistentGatewayRequestOptions,
    read: (
        parameters: Readonly<Record<string, unknown>>,
        requestOptions: PersistentGatewayRequestOptions
    ) => Promise<unknown>
): Promise<SimulatedCronListSnapshot> {
    const { limit: _limit, offset: _offset, ...filters } = parameters;
    const timeoutMs = requestOptions.timeoutMs;
    if (timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1)) {
        throw new TypeError("Development cron list timeout is invalid");
    }
    let signal = requestOptions.signal;
    if (timeoutMs !== undefined) {
        const deadlineSignal = AbortSignal.timeout(timeoutMs);
        signal =
            signal === undefined
                ? deadlineSignal
                : AbortSignal.any([signal, deadlineSignal]);
    }
    const upstreamOptions: PersistentGatewayRequestOptions =
        signal === undefined ? {} : { signal };
    const jobs: unknown[] = [];
    const ids = new Set<string>();
    let admittedBytes = 0;
    let expectedRevision: string | undefined;
    let expectedTotal: number | undefined;
    let offset = 0;
    while (true) {
        signal?.throwIfAborted();
        const response = await read(
            {
                ...filters,
                limit: simulatedCronUpstreamPageMaximum,
                offset,
            },
            upstreamOptions
        );
        admittedBytes += responseByteLength(response);
        const page = assertCronUpstreamPage(
            response,
            offset,
            admittedBytes,
            ids,
            expectedRevision
        );
        expectedRevision = page.snapshotRevision;
        expectedTotal ??= page.total;
        if (page.total !== expectedTotal) {
            throw new TypeError("Development cron inventory is invalid");
        }
        jobs.push(...page.jobs);
        if (page.nextOffset === null) break;
        offset = page.nextOffset;
    }
    signal?.throwIfAborted();
    if (jobs.length !== expectedTotal || expectedRevision === undefined) {
        throw new TypeError("Development cron inventory is invalid");
    }
    return Object.freeze({
        jobs: Object.freeze(jobs),
        upstreamRevision: expectedRevision,
    });
}

function projectCronListSnapshot(
    snapshot: SimulatedCronListSnapshot,
    parameters: Readonly<Record<string, unknown>>,
    removedCronJobIds: ReadonlySet<string>
): Readonly<SimulatedCronListPage> {
    const limit = cronListPageInteger(parameters, "limit", 1, 100);
    const offset = cronListPageInteger(
        parameters,
        "offset",
        0,
        simulatedCronInventoryMaximum
    );
    const filteredJobs = snapshot.jobs.filter((job) => {
        const id = asRecord(job)?.id;
        return typeof id !== "string" || !removedCronJobIds.has(id);
    });
    const jobs = filteredJobs.slice(offset, offset + limit);
    const consumed = offset + jobs.length;
    const total = filteredJobs.length;
    const hasMore = consumed < total;
    return Object.freeze({
        hasMore,
        jobs: Object.freeze(jobs),
        limit,
        nextOffset: hasMore ? consumed : null,
        offset,
        snapshotRevision: simulatedCronSnapshotRevision(
            snapshot.upstreamRevision,
            removedCronJobIds
        ),
        total,
    });
}

async function simulatedCronListRead(
    state: SimulatorState,
    parameters: Readonly<Record<string, unknown>>,
    requestOptions: PersistentGatewayRequestOptions,
    read: (
        parameters: Readonly<Record<string, unknown>>,
        requestOptions: PersistentGatewayRequestOptions
    ) => Promise<unknown>
): Promise<unknown> {
    cronListPageInteger(parameters, "limit", 1, 100);
    cronListPageInteger(parameters, "offset", 0, simulatedCronInventoryMaximum);
    const admission = state.cronMaterializationAdmission.tryAcquire();
    if (admission === undefined) throw new PersistentGatewayCapacityError();
    try {
        const snapshot = await materializeCronListSnapshot(
            parameters,
            requestOptions,
            read
        );
        const response = projectCronListSnapshot(
            snapshot,
            parameters,
            state.removedCronJobIds
        );
        requestOptions.signal?.throwIfAborted();
        requestOptions.onResponseBytes?.(responseByteLength(response));
        return response;
    } finally {
        admission.release();
    }
}

function deepMerge(
    base: Readonly<Record<string, unknown>>,
    patch: Readonly<Record<string, unknown>>
): Readonly<Record<string, unknown>> {
    const merged: Record<string, unknown> = { ...base };
    for (const [key, value] of Object.entries(patch)) {
        const baseValue = asRecord(base[key]);
        const patchValue = asRecord(value);
        merged[key] =
            baseValue === undefined || patchValue === undefined
                ? value
                : deepMerge(baseValue, patchValue);
    }
    return Object.freeze(merged);
}

function hashConfiguration(configuration: Readonly<Record<string, unknown>>): Readonly<{
    hash: string;
    revisionHash: string;
}> {
    const serialized = JSON.stringify(configuration);
    return Object.freeze({
        hash: new Bun.CryptoHasher("sha256").update(serialized).digest("hex"),
        revisionHash: new Bun.CryptoHasher("sha256")
            .update(`revision:${serialized}`)
            .digest("base64url"),
    });
}

function observedConfigResponse(
    state: SimulatorState
): Readonly<Record<string, unknown>> {
    const observed = asRecord(state.observedResponses.get(readKey("config.get", {})));
    if (observed === undefined) {
        throw new TypeError("Development configuration has no live read base");
    }
    return observed;
}

function simulateConfigurationPatch(
    parameters: Readonly<Record<string, unknown>>,
    state: SimulatorState
): unknown {
    const observed = observedConfigResponse(state);
    const configuration = asRecord(observed.config);
    const raw = parameters.raw;
    if (configuration === undefined || typeof raw !== "string") {
        throw new TypeError("Development configuration patch is invalid");
    }
    const patch = asRecord(JSON.parse(raw) as unknown);
    if (patch === undefined) {
        throw new TypeError("Development configuration patch is invalid");
    }
    const merged = deepMerge(configuration, patch);
    const identity = hashConfiguration(merged);
    const readback = Object.freeze({
        ...observed,
        config: merged,
        configRevisionHash: identity.revisionHash,
        hash: identity.hash,
        parsed: merged,
        sourceConfig: merged,
        valid: true,
    });
    state.observedResponses.set(readKey("config.get", {}), readback);
    state.simulatedResponses.set(readKey("config.get", {}), readback);
    return Object.freeze({
        config: merged,
        hash: identity.hash,
        ok: true,
        sentinel: Object.freeze({
            payload: Object.freeze({
                stats: Object.freeze({ requiresRestart: false }),
            }),
            persisted: true,
        }),
    });
}

function simulateSkillUpdate(
    parameters: Readonly<Record<string, unknown>>,
    state: SimulatorState
): unknown {
    const skillKey = parameterString(parameters, "skillKey", 128);
    const enabled = parameters.enabled;
    if (typeof enabled !== "boolean") {
        throw new TypeError("Development skill update is invalid");
    }
    const observed = observedConfigResponse(state);
    const configuration = asRecord(observed.config) ?? {};
    const skills = asRecord(configuration.skills) ?? {};
    const entries = asRecord(skills.entries) ?? {};
    const existing = asRecord(entries[skillKey]) ?? {};
    const merged = deepMerge(configuration, {
        skills: {
            ...skills,
            entries: {
                ...entries,
                [skillKey]: { ...existing, enabled },
            },
        },
    });
    const identity = hashConfiguration(merged);
    const readback = Object.freeze({
        ...observed,
        config: merged,
        configRevisionHash: identity.revisionHash,
        hash: identity.hash,
        parsed: merged,
        sourceConfig: merged,
        valid: true,
    });
    state.observedResponses.set(readKey("config.get", {}), readback);
    state.simulatedResponses.set(readKey("config.get", {}), readback);
    return Object.freeze({
        config: Object.freeze({ enabled }),
        ok: true,
        skillKey,
    });
}

function simulatedResponse(
    method: SimulatedGatewayMethod,
    parameters: Readonly<Record<string, unknown>>,
    now: number,
    state: SimulatorState
): unknown {
    switch (method) {
        case "chat.send": {
            // Development reads and events still come from the live Gateway. A local
            // started ACK would therefore create a run that can never receive events.
            parameterString(parameters, "idempotencyKey", 256);
            throw new PersistentGatewayRequestError({ code: "UNAVAILABLE" });
        }
        case "chat.abort": {
            const runId =
                parameters.runId === undefined
                    ? undefined
                    : parameterString(parameters, "runId", 256);
            return Object.freeze({
                aborted: runId !== undefined,
                ok: true,
                runIds: Object.freeze(runId === undefined ? [] : [runId]),
            });
        }
        case "sessions.companion.ask": {
            const sessionKey = parameterString(parameters, "sessionKey");
            const question = parameterString(parameters, "question", 400);
            const answer = "Simulated source-development companion response.";
            const exchanges = state.companionExchanges.get(sessionKey) ?? [];
            const updated = Object.freeze([
                ...exchanges,
                Object.freeze({ answer, question, ts: now }),
            ]);
            state.companionExchanges.set(sessionKey, updated);
            state.simulatedResponses.set(
                readKey("sessions.companion.state", { sessionKey }),
                Object.freeze({ exchanges: updated })
            );
            return Object.freeze({ answer, ts: now });
        }
        case "sessions.companion.reset": {
            const sessionKey = parameterString(parameters, "sessionKey");
            state.companionExchanges.delete(sessionKey);
            state.simulatedResponses.set(
                readKey("sessions.companion.state", { sessionKey }),
                Object.freeze({ exchanges: Object.freeze([]) })
            );
            return Object.freeze({ ok: true });
        }
        case "sessions.patch": {
            const key = parameterString(parameters, "key");
            return Object.freeze({
                entry: Object.freeze({
                    ...(parameters.fastMode === undefined
                        ? {}
                        : { fastMode: parameters.fastMode }),
                    ...(parameters.expectedSessionId === undefined
                        ? {}
                        : { sessionId: parameters.expectedSessionId }),
                    ...(parameters.thinkingLevel === undefined
                        ? {}
                        : { thinkingLevel: parameters.thinkingLevel }),
                }),
                key,
                ok: true,
                resolved: Object.freeze({
                    ...(parameters.model === undefined
                        ? {}
                        : { model: parameters.model }),
                    ...(parameters.thinkingLevel === undefined
                        ? {}
                        : { thinkingLevel: parameters.thinkingLevel }),
                }),
            });
        }
        case "sessions.compact": {
            return Object.freeze({
                compacted: false,
                key: parameterString(parameters, "key"),
                ok: true,
                reason: "simulated",
            });
        }
        case "sessions.reset": {
            return Object.freeze({
                key: parameterString(parameters, "key"),
                ok: true,
            });
        }
        case "sessions.delete": {
            return Object.freeze({
                archived: Object.freeze([]),
                deleted: true,
                key: parameterString(parameters, "key"),
                ok: true,
            });
        }
        case "tasks.cancel": {
            const taskId = parameterString(parameters, "taskId", 256);
            return Object.freeze({
                cancelled: true,
                found: true,
                task: Object.freeze({ id: taskId, status: "cancelled", updatedAt: now }),
            });
        }
        case "cron.remove": {
            const id = parameterString(parameters, "id");
            state.removedCronJobIds.add(id);
            const key = readKey("cron.get", { id });
            state.observedResponses.delete(key);
            state.simulatedResponses.delete(key);
            return Object.freeze({ removed: true });
        }
        case "cron.run": {
            return Object.freeze({
                enqueued: true,
                ok: true,
                processInstanceId: parameterString(
                    parameters,
                    "expectedProcessInstanceId",
                    256
                ),
                runId: `dev-${String(now)}`,
            });
        }
        case "cron.scratch.get": {
            throw new TypeError("Development cron scratch reads must be delegated");
        }
        case "cron.scratch.set": {
            const id = parameterString(parameters, "id");
            const content = parameters.content;
            const expectedRevision = parameters.expectedRevision;
            if (
                typeof content !== "string" ||
                content.length > 64 * 1024 ||
                !Number.isSafeInteger(expectedRevision) ||
                (expectedRevision as number) < 0
            ) {
                throw new TypeError("Development cron scratch update is invalid");
            }
            const revision = (expectedRevision as number) + 1;
            const response = Object.freeze({
                currentRevision: revision,
                maxBytes: 64 * 1024,
                ok: true,
                scratch: Object.freeze({ content, revision, updatedAtMs: now }),
            });
            state.simulatedResponses.set(readKey("cron.scratch.get", { id }), {
                currentRevision: revision,
                maxBytes: 64 * 1024,
                scratch: response.scratch,
            });
            return response;
        }
        case "cron.update": {
            const id = parameterString(parameters, "id");
            const patch = asRecord(parameters.patch);
            if (patch === undefined) {
                throw new TypeError("Development cron update is invalid");
            }
            const current =
                asRecord(state.observedResponses.get(readKey("cron.get", { id }))) ?? {};
            const updated = Object.freeze({ ...current, ...patch, id, updatedAtMs: now });
            state.simulatedResponses.set(readKey("cron.get", { id }), updated);
            return updated;
        }
        case "config.patch": {
            return simulateConfigurationPatch(parameters, state);
        }
        case "skills.update": {
            return simulateSkillUpdate(parameters, state);
        }
    }
}

function responseByteLength(response: unknown): number {
    return Buffer.byteLength(JSON.stringify(response), "utf8");
}

function appendJournalReceipt(
    journalPath: string,
    input: Readonly<{
        atMs: number;
        method: SimulatedGatewayMethod;
        parametersJson: string;
    }>
): void {
    const receipt = JSON.stringify({
        atMs: input.atMs,
        method: input.method,
        outcome: "simulated",
        parameterBytes: Buffer.byteLength(input.parametersJson, "utf8"),
        parametersSha256: new Bun.CryptoHasher("sha256")
            .update(input.parametersJson)
            .digest("hex"),
    });
    const descriptor = openSync(
        journalPath,
        constants.O_APPEND |
            constants.O_CREAT |
            constants.O_NOFOLLOW |
            constants.O_WRONLY,
        0o600
    );
    try {
        const status = fstatSync(descriptor);
        if (!status.isFile() || status.nlink !== 1) {
            throw new Error("Development Gateway simulator journal is invalid");
        }
        writeSync(descriptor, `${receipt}\n`, undefined, "utf8");
        fsyncSync(descriptor);
    } finally {
        closeSync(descriptor);
    }
}

function observedRead(
    state: SimulatorState,
    key: string,
    read: () => Promise<unknown>
): Promise<unknown> {
    if (state.simulatedResponses.has(key)) {
        return Promise.resolve(state.simulatedResponses.get(key));
    }
    return read().then((response) => {
        state.observedResponses.set(key, response);
        return response;
    });
}

function observedGatewayRead(
    state: SimulatorState,
    method: string,
    parameters: Readonly<Record<string, unknown>>,
    read: () => Promise<unknown>
): Promise<unknown> {
    if (method === "cron.get") {
        const id = parameters.id;
        if (typeof id === "string" && state.removedCronJobIds.has(id)) {
            return Promise.reject(
                new PersistentGatewayRequestError({ code: "INVALID_REQUEST" })
            );
        }
    }
    const key = readKey(method, parameters);
    return observedRead(state, key, read);
}

/**
 * Creates a hybrid source-development Gateway transport: all read/event calls stay
 * on the reviewed production read lane, while every mutation is validated, recorded
 * under marked development state, and answered by an explicit local simulator.
 * @param options Read transport and marked development-state location.
 * @returns A transport that delegates reads and simulates every mutation locally.
 */
export function createSourceDevelopmentGatewayTransport(
    options: SourceDevelopmentGatewayTransportOptions
): PersistentGatewayTransport {
    const directory = simulatorDirectory(options.stateRoot);
    const journalPath = path.join(directory, gatewayJournalFileName);
    const chatWriteCapabilityPath = path.join(directory, chatWriteCapabilityFileName);
    const nowMs = options.nowMs ?? Date.now;
    const state: SimulatorState = {
        companionExchanges: new Map(),
        cronMaterializationAdmission: createSimulatedCronMaterializationAdmission(),
        observedResponses: new Map(),
        removedCronJobIds: new Set(),
        simulatedResponses: new Map(),
    };
    const dispatch = (
        method: SimulatedGatewayMethod,
        parameters: Readonly<Record<string, unknown>>,
        requestOptions: PersistentGatewayRequestOptions = {}
    ): Promise<unknown> =>
        Promise.resolve().then(() => {
            requestOptions.signal?.throwIfAborted();
            const parametersJson = JSON.stringify(parameters);
            const now = checkedNow(nowMs);
            let response: unknown;
            try {
                response = simulatedResponse(method, parameters, now, state);
            } catch (error) {
                if (method === "chat.send") {
                    appendJournalReceipt(journalPath, {
                        atMs: now,
                        method,
                        parametersJson,
                    });
                    requestOptions.signal?.throwIfAborted();
                }
                throw error;
            }
            appendJournalReceipt(journalPath, { atMs: now, method, parametersJson });
            requestOptions.signal?.throwIfAborted();
            requestOptions.onResponseBytes?.(responseByteLength(response));
            return response;
        });

    return Object.freeze<PersistentGatewayTransport>({
        get snapshot(): PersistentGatewayConnectionSnapshot {
            return options.readTransport.snapshot;
        },
        request(method, parameters, requestOptions) {
            if (method === "cron.list") {
                return simulatedCronListRead(
                    state,
                    parameters,
                    requestOptions ?? {},
                    (upstreamParameters, upstreamOptions) =>
                        options.readTransport.request(
                            method,
                            upstreamParameters,
                            upstreamOptions
                        )
                );
            }
            return observedGatewayRead(state, method, parameters, () =>
                options.readTransport.request(method, parameters, requestOptions)
            );
        },
        requestAdmin(method, parameters, requestOptions) {
            assertPersistentGatewayAdminParameters(method, parameters);
            if (method === "cron.scratch.get") {
                return options.readTransport.requestAdmin(
                    method,
                    parameters,
                    requestOptions
                );
            }
            return dispatch(method, parameters, requestOptions);
        },
        requestChatRead(method, parameters, requestOptions) {
            const key = readKey(method, parameters);
            return observedRead(state, key, () =>
                options.readTransport.requestChatRead(method, parameters, requestOptions)
            );
        },
        requestChatReadMutation(method, parameters, requestOptions) {
            assertPersistentGatewayChatReadMutationParameters(method, parameters);
            return dispatch(method, parameters, requestOptions);
        },
        requestChatWrite(method, parameters, requestOptions) {
            assertPersistentGatewayChatWriteParameters(method, parameters);
            if (
                (method === "chat.send" || method === "chat.abort") &&
                chatWriteIsAuthorized({
                    capabilityPath: chatWriteCapabilityPath,
                    nowMs,
                    parameters,
                })
            ) {
                return options.readTransport.requestChatWrite(
                    method,
                    parameters,
                    requestOptions
                );
            }
            return dispatch(method, parameters, requestOptions);
        },
        requestOpenClawSettingsRead(method, parameters, requestOptions) {
            const key = readKey(method, parameters);
            return observedRead(state, key, () =>
                options.readTransport.requestOpenClawSettingsRead(
                    method,
                    parameters,
                    requestOptions
                )
            );
        },
        requestOpenClawSettingsWrite(method, parameters, requestOptions) {
            assertPersistentGatewayOpenClawSettingsWriteParameters(method, parameters);
            return requestOptions
                .beforeDispatch()
                .then(() => dispatch(method, parameters, requestOptions));
        },
        requestTaskRead(method, parameters, requestOptions) {
            const key = readKey(method, parameters);
            return observedRead(state, key, () =>
                options.readTransport.requestTaskRead(method, parameters, requestOptions)
            );
        },
        requestTaskWrite(method, parameters, requestOptions) {
            assertPersistentGatewayTaskWriteParameters(method, parameters);
            return dispatch(method, parameters, requestOptions);
        },
        start: () => options.readTransport.start(),
        stop: () => options.readTransport.stop(),
        subscribe: (listener) => options.readTransport.subscribe(listener),
        subscribeChat: (subscription, listener) =>
            options.readTransport.subscribeChat(subscription, listener),
    });
}
