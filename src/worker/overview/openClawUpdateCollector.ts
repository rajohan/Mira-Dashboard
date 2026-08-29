import { userInfo } from "node:os";
import path from "node:path";

import * as v from "valibot";

import {
    type OpenClawUpdateStatus,
    openClawUpdateStatusSchema,
} from "../../contracts/system.ts";

const outputMaximumBytes = 16 * 1024;
const updateCommandSchema = v.object({
    availability: v.object({
        available: v.boolean(),
        latestVersion: v.nullable(v.string()),
    }),
    channel: v.object({ value: v.string() }),
});

export interface OpenClawUpdateCollectorAdapter {
    readonly run: (
        arguments_: readonly string[],
        signal?: AbortSignal
    ) => Promise<string>;
}

interface OpenClawUpdateProcess {
    readonly exited: Promise<number>;
    readonly stdout: ReadableStream<Uint8Array>;
}

export interface OpenClawUpdateProcessAdapterOptions {
    readonly homeDirectory: string;
    readonly openClawRoot: string;
    readonly spawn?: (
        command: readonly string[],
        options: {
            readonly env: Readonly<Record<string, string>>;
            readonly signal?: AbortSignal;
            readonly stderr: "ignore";
            readonly stdin: "ignore";
            readonly stdout: "pipe";
        }
    ) => OpenClawUpdateProcess;
}

async function readBounded(stream: ReadableStream<Uint8Array>): Promise<string> {
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
        while (true) {
            const next = await reader.read();
            if (next.done) break;
            bytes += next.value.byteLength;
            if (bytes > outputMaximumBytes)
                throw new Error("OpenClaw output is too large");
            chunks.push(next.value);
        }
    } finally {
        reader.releaseLock();
    }
    const output = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) {
        output.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return new TextDecoder().decode(output).trim();
}

/** @returns A fixed-environment adapter for the reviewed OpenClaw executable. */
export function createOpenClawUpdateProcessAdapter(
    options: OpenClawUpdateProcessAdapterOptions
): OpenClawUpdateCollectorAdapter {
    const { homeDirectory, openClawRoot } = options;
    if (
        !path.isAbsolute(openClawRoot) ||
        path.resolve(openClawRoot) !== openClawRoot ||
        openClawRoot === path.parse(openClawRoot).root ||
        !path.isAbsolute(homeDirectory) ||
        path.resolve(homeDirectory) !== homeDirectory ||
        homeDirectory === path.parse(homeDirectory).root
    ) {
        throw new TypeError("OpenClaw update collector configuration is invalid");
    }
    const executable = path.join(homeDirectory, ".local", "bin", "openclaw");
    const environment = Object.freeze({
        HOME: homeDirectory,
        LANG: "C",
        LC_ALL: "C",
        OPENCLAW_STATE_DIR: openClawRoot,
        PATH: "/usr/local/bin:/usr/bin:/bin",
    });
    const spawn =
        options.spawn ??
        ((command, spawnOptions) => Bun.spawn([...command], spawnOptions));
    return Object.freeze({
        async run(arguments_: readonly string[], signal?: AbortSignal) {
            const child = spawn([executable, ...arguments_], {
                env: { ...environment },
                signal,
                stderr: "ignore",
                stdin: "ignore",
                stdout: "pipe",
            });
            const [output, exitCode] = await Promise.all([
                readBounded(child.stdout),
                child.exited,
            ]);
            if (exitCode !== 0) throw new Error("OpenClaw command failed");
            return output;
        },
    });
}

function defaultAdapter(openClawRoot: string): OpenClawUpdateCollectorAdapter {
    return createOpenClawUpdateProcessAdapter({
        homeDirectory: userInfo().homedir,
        openClawRoot,
    });
}

export interface OpenClawUpdateCollectorOptions {
    readonly adapter?: OpenClawUpdateCollectorAdapter;
    readonly openClawRoot: string;
}

/**
 * @param signal Caller-owned cancellation signal.
 * @param options Reviewed OpenClaw root and optional injected process adapter.
 * @returns Validated installed/latest OpenClaw versions without provider internals.
 */
export async function collectOpenClawUpdateStatus(
    signal: AbortSignal | undefined,
    options: OpenClawUpdateCollectorOptions
): Promise<OpenClawUpdateStatus> {
    const adapter = options.adapter ?? defaultAdapter(options.openClawRoot);
    const [installedOutput, rawStatus] = await Promise.all([
        adapter.run(["--version"], signal),
        adapter.run(["update", "status", "--json"], signal),
    ]);
    const installedMatch =
        /^OpenClaw ([0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)(?: \([0-9a-f]{7,40}\))?$/u.exec(
            installedOutput
        );
    if (installedMatch?.[1] === undefined) {
        throw new Error("OpenClaw installed version is invalid");
    }
    const status = v.parse(updateCommandSchema, JSON.parse(rawStatus));
    if (status.availability.available && status.availability.latestVersion === null) {
        throw new Error("OpenClaw available update version is invalid");
    }
    return v.parse(openClawUpdateStatusSchema, {
        available: status.availability.available,
        channel: status.channel.value,
        installedVersion: installedMatch[1],
        latestVersion: status.availability.latestVersion ?? installedMatch[1],
        state: "observed",
    });
}
