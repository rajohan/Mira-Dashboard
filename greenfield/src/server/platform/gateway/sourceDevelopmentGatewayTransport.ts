import {
    constants,
    closeSync,
    fstatSync,
    fsyncSync,
    mkdirSync,
    openSync,
    readFileSync,
    realpathSync,
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
    type PersistentGatewayConnectionSnapshot,
    type PersistentGatewayRequestOptions,
    type PersistentGatewayTransport,
} from "./persistentGatewayTransport.ts";

const developmentStateMarkerFileName = ".mira-dashboard-development-state.json";
const simulatorOwner = "mira-dashboard-source-development-v1";
const simulatorDirectoryName = "development-authority-simulator";
const gatewayJournalFileName = "gateway-mutations.ndjson";

const developmentStateMarkerSchema = v.strictObject({
    formatVersion: v.literal(1),
    owner: v.literal(simulatorOwner),
});

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

/** Exact live Gateway authority retained by ordinary source development. */
export type SourceDevelopmentGatewayReadTransport = Pick<
    PersistentGatewayTransport,
    | "request"
    | "requestChatRead"
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

interface SimulatorState {
    readonly companionExchanges: Map<string, readonly CompanionExchange[]>;
    readonly observedResponses: Map<string, unknown>;
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
            return Object.freeze({
                runId: parameterString(parameters, "idempotencyKey", 256),
                status: "started",
            });
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
    const stateRoot = assertMarkedDevelopmentStateRoot(options.stateRoot);
    const simulatorDirectory = path.join(stateRoot, simulatorDirectoryName);
    mkdirSync(simulatorDirectory, { mode: 0o700, recursive: true });
    if (realpathSync(simulatorDirectory) !== simulatorDirectory) {
        throw new Error("Development Gateway simulator directory is invalid");
    }
    const journalPath = path.join(simulatorDirectory, gatewayJournalFileName);
    const nowMs = options.nowMs ?? Date.now;
    const state: SimulatorState = {
        companionExchanges: new Map(),
        observedResponses: new Map(),
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
            const response = simulatedResponse(method, parameters, now, state);
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
            const key = readKey(method, parameters);
            return observedRead(state, key, () =>
                options.readTransport.request(method, parameters, requestOptions)
            );
        },
        requestAdmin(method, parameters, requestOptions) {
            assertPersistentGatewayAdminParameters(method, parameters);
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
