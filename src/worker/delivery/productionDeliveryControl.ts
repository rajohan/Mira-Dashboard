import * as v from "valibot";

import {
    deliveryProductionOperationMaximumBytes,
    parseDeliveryProductionOperationInspection,
    parseDeliveryProductionOperationRecord,
    serializeDeliveryProductionOperationCapsule,
    type DeliveryProductionOperationCapsule,
    type DeliveryProductionOperationInspection,
    type DeliveryProductionOperationRecord,
} from "../../shared/deliveryProductionOperation.ts";
import { parseProductionDeliveryExecutorOwner } from "../../shared/productionDeliveryExecutorOwner.ts";
import { lowercaseUuidV7Schema } from "../../shared/validation.ts";
import {
    resolveVerifiedProductionDeliveryExecutor,
    type ProductionDeliveryLaunchOptions,
    type ProductionDeliveryLaunchProcessResult,
} from "./productionDeliveryLauncher.ts";

const controlFailureMessage = "Production Delivery control failed";
const controlDeadlineMs = 30_000;
const envExecutable = "/usr/bin/env";
const controlOptionsSchema = v.strictObject({
    executorReleaseId: v.string(),
    projectRoot: v.string(),
    runtimeRevision: v.string(),
});

export interface ProductionDeliveryControlPort {
    readonly clear: (
        transitionId: string,
        signal?: AbortSignal
    ) => Promise<DeliveryProductionOperationRecord>;
    readonly inspectActive: (
        signal?: AbortSignal
    ) => Promise<DeliveryProductionOperationInspection>;
    readonly inspectOwner?: (
        signal?: AbortSignal
    ) => Promise<ReturnType<typeof parseProductionDeliveryExecutorOwner> | null>;
    readonly inspect: (
        transitionId: string,
        signal?: AbortSignal
    ) => Promise<DeliveryProductionOperationInspection>;
    readonly prepare: (
        capsule: DeliveryProductionOperationCapsule,
        signal?: AbortSignal
    ) => Promise<Exclude<DeliveryProductionOperationRecord, { phase: "terminal" }>>;
}

export interface ProductionDeliveryControlDependencies {
    readonly execute?: (
        command: readonly string[],
        environment: Readonly<Record<string, string>>,
        standardInput: Uint8Array,
        signal?: AbortSignal
    ) => Promise<ProductionDeliveryLaunchProcessResult>;
}

function failure(): Error {
    return new Error(controlFailureMessage);
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
            if (total > deliveryProductionOperationMaximumBytes) throw failure();
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

async function execute(
    command: readonly string[],
    environment: Readonly<Record<string, string>>,
    standardInput: Uint8Array,
    signal?: AbortSignal
): Promise<ProductionDeliveryLaunchProcessResult> {
    const deadline = AbortSignal.timeout(controlDeadlineMs);
    const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
    const child = Bun.spawn([...command], {
        cwd: "/",
        env: { ...environment },
        signal: combined,
        stderr: "pipe",
        stdin: "pipe",
        stdout: "pipe",
    });
    try {
        await child.stdin.write(standardInput);
        await child.stdin.end();
        const [exitCode, stderr, stdout] = await Promise.all([
            child.exited,
            readBounded(child.stderr),
            readBounded(child.stdout),
        ]);
        return Object.freeze({ exitCode, stderr, stdout });
    } catch {
        child.kill();
        await child.exited.catch(() => null);
        throw failure();
    }
}

function environment(): Readonly<Record<string, string>> {
    return Object.freeze({ LANG: "C", PATH: "/usr/bin:/bin" });
}

function parseOutput(bytes: Uint8Array): unknown {
    try {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        return JSON.parse(text) as unknown;
    } catch {
        throw failure();
    }
}

/**
 * Creates the fixed one-shot worker boundary to the immutable executor control modes.
 * @param untrustedOptions Exact immutable executor identity and project root.
 * @param dependencies Optional fixed process executor seam.
 * @returns A bounded control port for the exact immutable executor.
 */
export function createProductionDeliveryControlPort(
    untrustedOptions: Pick<
        ProductionDeliveryLaunchOptions,
        "executorReleaseId" | "projectRoot" | "runtimeRevision"
    >,
    dependencies: ProductionDeliveryControlDependencies = {}
): ProductionDeliveryControlPort {
    const options = Object.freeze(v.parse(controlOptionsSchema, untrustedOptions));
    const run = dependencies.execute ?? execute;

    async function command(
        operation: "clear" | "inspect" | "inspect-active" | "inspect-owner" | "prepare",
        standardInput: Uint8Array,
        transitionId?: string,
        signal?: AbortSignal
    ): Promise<unknown> {
        const verified = await resolveVerifiedProductionDeliveryExecutor(options);
        const argv = Object.freeze([
            envExecutable,
            "-i",
            "NODE_ENV=production",
            verified.runtimeExecutable,
            verified.executor,
            `--operation=${operation}`,
            `--project-root=${options.projectRoot}`,
            ...(transitionId === undefined ? [] : [`--transition=${transitionId}`]),
        ]);
        const result = await run(argv, environment(), standardInput, signal);
        if (result.exitCode !== 0 || result.stderr.byteLength !== 0) throw failure();
        return parseOutput(result.stdout);
    }

    return Object.freeze({
        async clear(transitionId: string, signal?: AbortSignal) {
            const canonicalTransition = v.parse(lowercaseUuidV7Schema(), transitionId);
            const returned = parseDeliveryProductionOperationRecord(
                await command("clear", new Uint8Array(), canonicalTransition, signal)
            );
            if (
                returned.phase !== "terminal" ||
                returned.capsule.transitionId !== canonicalTransition
            ) {
                throw failure();
            }
            return returned;
        },
        async inspectActive(signal?: AbortSignal) {
            return parseDeliveryProductionOperationInspection(
                await command("inspect-active", new Uint8Array(), undefined, signal)
            );
        },
        async inspectOwner(signal?: AbortSignal) {
            const value = await command(
                "inspect-owner",
                new Uint8Array(),
                undefined,
                signal
            );
            return value === null ? null : parseProductionDeliveryExecutorOwner(value);
        },
        async inspect(transitionId: string, signal?: AbortSignal) {
            const canonicalTransition = v.parse(lowercaseUuidV7Schema(), transitionId);
            return parseDeliveryProductionOperationInspection(
                await command("inspect", new Uint8Array(), canonicalTransition, signal)
            );
        },
        async prepare(capsule: DeliveryProductionOperationCapsule, signal?: AbortSignal) {
            const serialized = serializeDeliveryProductionOperationCapsule(capsule);
            const returned = parseDeliveryProductionOperationRecord(
                await command(
                    "prepare",
                    new TextEncoder().encode(serialized),
                    undefined,
                    signal
                )
            );
            if (
                returned.phase === "terminal" ||
                serializeDeliveryProductionOperationCapsule(returned.capsule) !==
                    serialized
            ) {
                throw failure();
            }
            return returned;
        },
    });
}
