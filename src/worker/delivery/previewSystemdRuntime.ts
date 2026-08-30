import path from "node:path";

import { hasNoUnicodeControlOrFormat } from "../../shared/validation.ts";
import {
    startPreviewGatewayBroker,
    type PreviewGatewayBroker,
    type PreviewGatewayBrokerOptions,
} from "./previewGatewayBroker.ts";
import type { PreviewGatewayProxyPort } from "./previewGatewayProxy.ts";
import type { PreviewRuntimePort } from "./previewHost.ts";
import type {
    PreviewIngressSpecification,
    PreviewLaunchSpecification,
} from "./previewSandbox.ts";
import { PreviewHostError, type PreviewRuntimeState } from "./previewTypes.ts";

const systemdRunExecutable = "/usr/bin/systemd-run";
const systemctlExecutable = "/usr/bin/systemctl";
const bubblewrapExecutable = "/usr/bin/bwrap";
const socketProxydExecutable = "/usr/lib/systemd/systemd-socket-proxyd";
const processDeadlineMs = 30_000;
const defaultReadinessDeadlineMs = 90_000;
const readinessPollMs = 250;
const processOutputMaximumBytes = 64 * 1024;
const commandMaximumBytes = 64 * 1024;
const commandArgumentMaximum = 256;
const operationIdSource =
    "[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const previewUnitPattern = new RegExp(
    `^mira-dashboard-preview-(${operationIdSource})\\.service$`,
    "u"
);
const ingressServicePattern = new RegExp(
    `^mira-dashboard-preview-ingress-(${operationIdSource})\\.service$`,
    "u"
);
const ingressSocketPattern = new RegExp(
    `^mira-dashboard-preview-ingress-(${operationIdSource})\\.socket$`,
    "u"
);

export interface PreviewSystemdProcessResult {
    readonly exitCode: number;
    readonly stderr: Uint8Array;
    readonly stdout: Uint8Array;
}

export interface PreviewSystemdProcessRequest {
    readonly command: readonly string[];
    readonly environment: Readonly<Record<string, string>>;
    readonly signal: AbortSignal;
}

export type PreviewSystemdProcessRunner = (
    request: PreviewSystemdProcessRequest
) => Promise<PreviewSystemdProcessResult>;

export type PreviewIngressReadinessProbe = (
    socketPath: string,
    publicOrigin: string,
    signal: AbortSignal
) => Promise<boolean>;

export interface PreviewIngressRuntimePort {
    readonly start: (
        specification: PreviewIngressSpecification,
        signal?: AbortSignal
    ) => Promise<void>;
    readonly stop: (
        specification: PreviewIngressSpecification,
        signal?: AbortSignal
    ) => Promise<void>;
}

export interface PreviewSystemdRuntime extends PreviewRuntimePort {
    readonly ingress: PreviewIngressRuntimePort;
}

export interface PreviewSystemdRuntimeDependencies {
    readonly delay?: (delayMs: number, signal: AbortSignal) => Promise<void>;
    readonly gatewayPort: PreviewGatewayProxyPort;
    readonly ingressReadinessProbe?: PreviewIngressReadinessProbe;
    readonly processRunner?: PreviewSystemdProcessRunner;
    readonly readinessDeadlineMs?: number;
    readonly runtimeUserId?: number;
    readonly startGatewayBroker?: (
        options: PreviewGatewayBrokerOptions
    ) => Promise<PreviewGatewayBroker>;
}

function fail(): never {
    throw new PreviewHostError({ reason: "operation-failed" });
}

function safeCommand(command: readonly string[]): boolean {
    return (
        command.length > 0 &&
        command.length <= commandArgumentMaximum &&
        command.reduce((total, argument) => total + Buffer.byteLength(argument), 0) <=
            commandMaximumBytes &&
        command.every(
            (argument) =>
                argument.length > 0 &&
                argument.length <= 4096 &&
                !argument.includes("\0") &&
                hasNoUnicodeControlOrFormat(argument)
        )
    );
}

function requiredUserId(configured?: number): number {
    const value = configured ?? process.getuid?.();
    if (!Number.isSafeInteger(value) || value === undefined || value < 0) fail();
    return value;
}

function managerEnvironment(userId: number): Readonly<Record<string, string>> {
    const runtimeDirectory = `/run/user/${userId}`;
    return Object.freeze({
        DBUS_SESSION_BUS_ADDRESS: `unix:path=${runtimeDirectory}/bus`,
        HOME: "/nonexistent",
        LANG: "C.UTF-8",
        LC_ALL: "C.UTF-8",
        PATH: "/usr/bin:/bin",
        XDG_RUNTIME_DIR: runtimeDirectory,
    });
}

function sameEnvironment(
    actual: Readonly<Record<string, string>>,
    expected: Readonly<Record<string, string>>
): boolean {
    const names = Object.keys(actual).toSorted();
    const expectedNames = Object.keys(expected).toSorted();
    return (
        names.length === expectedNames.length &&
        names.every(
            (name, index) =>
                name === expectedNames[index] && actual[name] === expected[name]
        )
    );
}

function assertLaunchSpecification(
    specification: PreviewLaunchSpecification,
    environment: Readonly<Record<string, string>>
): void {
    if (
        !previewUnitPattern.test(specification.unitName) ||
        !sameEnvironment(specification.environment, environment) ||
        !safeCommand(specification.argv) ||
        specification.argv[0] !== systemdRunExecutable ||
        specification.argv.filter(
            (argument) => argument === `--unit=${specification.unitName}`
        ).length !== 1 ||
        !specification.argv.includes("--user") ||
        !specification.argv.includes("--collect") ||
        !specification.argv.includes("--quiet") ||
        !specification.argv.includes("--property=RuntimeMaxSec=4h") ||
        !specification.argv.includes("--property=UMask=0077") ||
        specification.argv.some((argument) => argument.startsWith("--setenv="))
    ) {
        fail();
    }
    const delimiter = specification.argv.indexOf("--");
    if (
        delimiter < 1 ||
        specification.argv[delimiter + 1] !== bubblewrapExecutable ||
        !specification.argv.slice(delimiter + 1).includes("--clearenv") ||
        specification.argv.slice(delimiter + 1).includes("--share-net")
    ) {
        fail();
    }
}

function ingressOperationId(specification: PreviewIngressSpecification): string {
    const serviceMatch = ingressServicePattern.exec(specification.serviceUnitName);
    const socketMatch = ingressSocketPattern.exec(specification.socketUnitName);
    if (!serviceMatch || !socketMatch || serviceMatch[1] !== socketMatch[1]) fail();
    return serviceMatch[1]!;
}

function assertIngressSpecification(specification: PreviewIngressSpecification): void {
    const operationId = ingressOperationId(specification);
    const unitBaseName = specification.serviceUnitName.slice(0, -".service".length);
    if (
        !path.isAbsolute(specification.listenUnixSocket) ||
        path.normalize(specification.listenUnixSocket) !==
            specification.listenUnixSocket ||
        specification.listenUnixSocket.includes("\0") ||
        !safeCommand(specification.argv) ||
        specification.argv[0] !== systemdRunExecutable ||
        specification.argv.filter((argument) => argument === `--unit=${unitBaseName}`)
            .length !== 1 ||
        !specification.argv.includes("--user") ||
        !specification.argv.includes("--collect") ||
        !specification.argv.includes("--quiet") ||
        !specification.argv.includes(
            `--property=JoinsNamespaceOf=mira-dashboard-preview-${operationId}.service`
        ) ||
        !specification.argv.includes("--property=PrivateNetwork=yes") ||
        !specification.argv.includes("--socket-property=SocketMode=0600") ||
        !specification.argv.includes("--socket-property=RemoveOnStop=yes") ||
        !specification.argv.includes(
            `--socket-property=ListenStream=${specification.listenUnixSocket}`
        ) ||
        specification.argv.filter((argument) =>
            argument.startsWith("--socket-property=ListenStream=")
        ).length !== 1 ||
        specification.argv.some((argument) => argument.startsWith("--setenv="))
    ) {
        fail();
    }
    const delimiter = specification.argv.indexOf("--");
    if (
        delimiter < 1 ||
        specification.argv.includes("--", delimiter + 1) ||
        specification.argv[delimiter + 1] !== socketProxydExecutable ||
        !specification.argv.slice(delimiter + 1).includes("--connections-max=16")
    ) {
        fail();
    }
}

async function readBounded(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
        while (true) {
            const next = await reader.read();
            if (next.done) break;
            total += next.value.byteLength;
            if (total > processOutputMaximumBytes) fail();
            chunks.push(next.value);
        }
    } finally {
        reader.releaseLock();
    }
    const output = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        output.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return output;
}

async function defaultProcessRunner(
    request: PreviewSystemdProcessRequest
): Promise<PreviewSystemdProcessResult> {
    const child = Bun.spawn([...request.command], {
        cwd: "/",
        env: { ...request.environment },
        killSignal: "SIGKILL",
        signal: request.signal,
        stderr: "pipe",
        stdin: "ignore",
        stdout: "pipe",
    });
    try {
        const [exitCode, stderr, stdout] = await Promise.all([
            child.exited,
            readBounded(child.stderr),
            readBounded(child.stdout),
        ]);
        return Object.freeze({ exitCode, stderr, stdout });
    } catch {
        child.kill();
        await child.exited.catch(() => null);
        return fail();
    }
}

function abortScope(parent: AbortSignal | undefined, deadlineMs: number) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (parent?.aborted) controller.abort();
    else parent?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, deadlineMs);
    timer.unref?.();
    return Object.freeze({
        dispose() {
            clearTimeout(timer);
            parent?.removeEventListener("abort", abort);
        },
        signal: controller.signal,
    });
}

async function runProcess(
    runner: PreviewSystemdProcessRunner,
    command: readonly string[],
    environment: Readonly<Record<string, string>>,
    signal?: AbortSignal
): Promise<PreviewSystemdProcessResult> {
    if (!safeCommand(command)) fail();
    const scope = abortScope(signal, processDeadlineMs);
    try {
        const aborted = new Promise<never>((_resolve, reject) => {
            const onAbort = () =>
                reject(new PreviewHostError({ reason: "operation-failed" }));
            if (scope.signal.aborted) onAbort();
            else scope.signal.addEventListener("abort", onAbort, { once: true });
        });
        const result = await Promise.race([
            runner({ command, environment, signal: scope.signal }),
            aborted,
        ]);
        if (
            !Number.isSafeInteger(result.exitCode) ||
            result.stdout.byteLength > processOutputMaximumBytes ||
            result.stderr.byteLength > processOutputMaximumBytes
        ) {
            fail();
        }
        return result;
    } catch (error) {
        if (error instanceof PreviewHostError) throw error;
        return fail();
    } finally {
        scope.dispose();
    }
}

function decodeOutput(bytes: Uint8Array): string {
    try {
        return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
        return fail();
    }
}

function parseUnitState(bytes: Uint8Array): PreviewRuntimeState {
    const properties = new Map<string, string>();
    for (const line of decodeOutput(bytes).split("\n")) {
        if (line.length === 0) continue;
        const separator = line.indexOf("=");
        const name = line.slice(0, separator);
        const value = line.slice(separator + 1);
        if (
            separator <= 0 ||
            !["ActiveState", "Result", "SubState"].includes(name) ||
            properties.has(name) ||
            value.length > 64 ||
            !hasNoUnicodeControlOrFormat(value)
        ) {
            fail();
        }
        properties.set(name, value);
    }
    const activeState = properties.get("ActiveState");
    const subState = properties.get("SubState");
    const result = properties.get("Result");
    if (activeState === undefined || subState === undefined || result === undefined) {
        fail();
    }
    const active = ["active", "activating", "deactivating", "reloading"].includes(
        activeState
    );
    let outcome: PreviewRuntimeState["result"];
    if (
        activeState === "failed" ||
        (activeState === "inactive" && result !== "success")
    ) {
        outcome = "failed";
    } else if (activeState === "inactive" && result === "success") {
        outcome = "success";
    }
    return Object.freeze({
        active,
        ready:
            activeState === "active" &&
            (subState === "running" || subState === "listening"),
        result: outcome,
    });
}

async function defaultIngressReadinessProbe(
    socketPath: string,
    publicOrigin: string,
    signal: AbortSignal
): Promise<boolean> {
    try {
        const origin = new URL(publicOrigin);
        origin.protocol = "http:";
        const response = await fetch(new URL("/api/health/ready", origin), {
            method: "HEAD",
            redirect: "error",
            signal,
            unix: socketPath,
        });
        await response.body?.cancel().catch(() => {});
        return response.status === 200;
    } catch {
        return false;
    }
}

function showCommand(unitName: string): readonly string[] {
    return Object.freeze([
        systemctlExecutable,
        "--user",
        "--no-ask-password",
        "--no-pager",
        "show",
        unitName,
        "--property=ActiveState",
        "--property=SubState",
        "--property=Result",
    ]);
}

function stopCommand(unitName: string): readonly string[] {
    return Object.freeze([
        systemctlExecutable,
        "--user",
        "--no-ask-password",
        "--no-pager",
        "stop",
        unitName,
    ]);
}

function defaultDelay(delayMs: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        const onAbort = () => {
            clearTimeout(timer);
            reject(new PreviewHostError({ reason: "operation-failed" }));
        };
        const timer = setTimeout(() => {
            signal.removeEventListener("abort", onAbort);
            resolve();
        }, delayMs);
        timer.unref?.();
        signal.addEventListener("abort", onAbort, { once: true });
    });
}

/**
 * Creates the fixed, bounded systemd boundary for one managed preview slot.
 * @param dependencies Injectable process and timer seams used by focused tests.
 * @returns Preview and socket-ingress runtime ports with no generic process authority.
 */
export function createPreviewSystemdRuntime(
    dependencies: PreviewSystemdRuntimeDependencies
): PreviewSystemdRuntime {
    const userId = requiredUserId(dependencies.runtimeUserId);
    const environment = managerEnvironment(userId);
    const runner = dependencies.processRunner ?? defaultProcessRunner;
    const delay = dependencies.delay ?? defaultDelay;
    const readinessDeadlineMs =
        dependencies.readinessDeadlineMs ?? defaultReadinessDeadlineMs;
    const gatewayBrokerStarter =
        dependencies.startGatewayBroker ?? startPreviewGatewayBroker;
    const ingressReadinessProbe =
        dependencies.ingressReadinessProbe ?? defaultIngressReadinessProbe;
    let activeGatewayBroker: PreviewGatewayBroker | undefined;
    let activeIngress:
        | Readonly<{ operationId: string; publicOrigin: string; socketPath: string }>
        | undefined;

    const inspectUnit = async (
        unitName: string,
        pattern: RegExp,
        signal?: AbortSignal
    ): Promise<PreviewRuntimeState> => {
        if (!pattern.test(unitName)) fail();
        const result = await runProcess(
            runner,
            showCommand(unitName),
            environment,
            signal
        );
        if (result.exitCode === 4) {
            return Object.freeze({ active: false, ready: false, result: "success" });
        }
        if (result.exitCode !== 0 || result.stderr.byteLength !== 0) fail();
        return parseUnitState(result.stdout);
    };

    const inspect: PreviewRuntimePort["inspect"] = async (unitName, signal) => {
        const state = await inspectUnit(unitName, previewUnitPattern, signal);
        const operationId = previewUnitPattern.exec(unitName)?.[1];
        if (!state.ready || activeGatewayBroker?.operationId !== operationId) {
            return Object.freeze({ ...state, ready: false });
        }
        const ingress = activeIngress;
        let ingressReady = false;
        if (ingress !== undefined && ingress.operationId === operationId) {
            const scope = abortScope(signal, readinessDeadlineMs);
            try {
                const aborted = new Promise<false>((resolve) => {
                    if (scope.signal.aborted) resolve(false);
                    else
                        scope.signal.addEventListener("abort", () => resolve(false), {
                            once: true,
                        });
                });
                ingressReady = await Promise.race([
                    ingressReadinessProbe(
                        ingress.socketPath,
                        ingress.publicOrigin,
                        scope.signal
                    ),
                    aborted,
                ]);
                signal?.throwIfAborted();
            } finally {
                scope.dispose();
            }
        }
        return Object.freeze({
            ...state,
            ready: ingressReady,
        });
    };

    const stopUnit = async (
        unitName: string,
        pattern: RegExp,
        signal?: AbortSignal
    ): Promise<void> => {
        const state = await inspectUnit(unitName, pattern, signal);
        if (!state.active) return;
        const result = await runProcess(
            runner,
            stopCommand(unitName),
            environment,
            signal
        );
        if (
            result.exitCode !== 0 ||
            result.stdout.byteLength !== 0 ||
            result.stderr.byteLength !== 0
        ) {
            fail();
        }
    };

    const waitUntilReady = async (
        unitName: string,
        pattern: RegExp,
        signal?: AbortSignal
    ): Promise<void> => {
        const scope = abortScope(signal, readinessDeadlineMs);
        try {
            while (true) {
                const state = await inspectUnit(unitName, pattern, scope.signal);
                if (state.ready) return;
                if (state.result === "failed") fail();
                await delay(readinessPollMs, scope.signal);
            }
        } finally {
            scope.dispose();
        }
    };

    const bindGateway: PreviewRuntimePort["bindGateway"] = async (
        unitName,
        specification
    ) => {
        const operationId = previewUnitPattern.exec(unitName)?.[1];
        if (operationId === undefined) fail();
        if (activeGatewayBroker !== undefined) {
            await activeGatewayBroker.stop();
            activeGatewayBroker = undefined;
        }
        activeGatewayBroker = await gatewayBrokerStarter({
            operationId,
            port: dependencies.gatewayPort,
            specification,
        }).catch(() => fail());
    };

    const start: PreviewRuntimePort["start"] = async (specification, gateway, signal) => {
        assertLaunchSpecification(specification, environment);
        await bindGateway(specification.unitName, gateway);
        const result = await runProcess(
            runner,
            specification.argv,
            specification.environment,
            signal
        );
        if (
            result.exitCode !== 0 ||
            result.stdout.byteLength !== 0 ||
            result.stderr.byteLength !== 0
        ) {
            await activeGatewayBroker?.stop().catch(() => {});
            activeGatewayBroker = undefined;
            fail();
        }
        try {
            await waitUntilReady(specification.unitName, previewUnitPattern, signal);
        } catch (error) {
            await stopUnit(specification.unitName, previewUnitPattern).catch(() => {});
            await activeGatewayBroker?.stop().catch(() => {});
            activeGatewayBroker = undefined;
            throw error;
        }
    };

    const startIngress: PreviewIngressRuntimePort["start"] = async (
        specification,
        signal
    ) => {
        assertIngressSpecification(specification);
        const operationId = ingressSocketPattern.exec(specification.socketUnitName)?.[1];
        if (operationId === undefined) fail();
        activeIngress = Object.freeze({
            operationId,
            publicOrigin: specification.publicOrigin,
            socketPath: specification.listenUnixSocket,
        });
        try {
            const scope = abortScope(signal, readinessDeadlineMs);
            try {
                while (
                    !(await ingressReadinessProbe(
                        specification.listenUnixSocket,
                        specification.publicOrigin,
                        scope.signal
                    ))
                ) {
                    await delay(readinessPollMs, scope.signal);
                }
            } finally {
                scope.dispose();
            }
        } catch (error) {
            activeIngress = undefined;
            throw error;
        }
    };

    const stopIngress: PreviewIngressRuntimePort["stop"] = (specification, signal) => {
        assertIngressSpecification(specification);
        signal?.throwIfAborted();
        const operationId = ingressSocketPattern.exec(specification.socketUnitName)?.[1];
        if (activeIngress?.operationId === operationId) activeIngress = undefined;
        return Promise.resolve();
    };
    const stop: PreviewRuntimePort["stop"] = async (unitName, signal) => {
        const operationId = previewUnitPattern.exec(unitName)?.[1];
        if (operationId === undefined) fail();
        let failure: unknown;
        try {
            await stopUnit(unitName, previewUnitPattern, signal);
        } catch (error) {
            failure = error;
        }
        if (activeGatewayBroker?.operationId === operationId) {
            await activeGatewayBroker.stop().catch((error: unknown) => {
                failure ??= error;
            });
            activeGatewayBroker = undefined;
        }
        if (failure !== undefined) fail();
    };

    return Object.freeze({
        ingress: Object.freeze({ start: startIngress, stop: stopIngress }),
        bindGateway,
        inspect,
        start,
        stop,
    });
}
