import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

import * as v from "valibot";

import {
    terminalClientMessageMaximumBytes,
    terminalIdleTimeoutMs,
    type TerminalLocation,
    terminalLocationSchema,
    terminalOutputReplayMaximumBytes,
    terminalReconnectGraceMs,
    type TerminalRoot,
    terminalRootSchema,
    type TerminalRuntime,
    terminalRuntimeMode,
    terminalRuntimeSchema,
    terminalServerMessageMaximumBytes,
    terminalSessionMaximumDurationMs,
    terminalWebSocketProtocol,
} from "../../../contracts/terminal.ts";

export interface TerminalRootDefinition {
    readonly absolutePath: string;
    readonly defaultPath?: string;
    readonly id: string;
    readonly label: string;
}

interface ResolvedTerminalRoot {
    readonly absolutePath: string;
    readonly publicRoot: TerminalRoot;
}

/** Sanitized failure raised before a host path can cross the service boundary. */
export class TerminalRootAccessError extends Error {
    public readonly reason:
        | "directory-unavailable"
        | "invalid-location"
        | "root-unavailable";

    public constructor(reason: TerminalRootAccessError["reason"], cause?: unknown) {
        super(
            "Terminal starting location is unavailable",
            cause === undefined ? {} : { cause }
        );
        this.name = "TerminalRootAccessError";
        this.reason = reason;
    }
}

export interface TerminalRootRegistry {
    /** Resolves only the initial directory; the interactive shell is not filesystem-sandboxed. */
    readonly resolveDirectory: (
        location: TerminalLocation,
        signal?: AbortSignal
    ) => Promise<string>;
    readonly runtime: () => TerminalRuntime;
}

function isPathWithin(rootPath: string, candidatePath: string): boolean {
    const relative = path.relative(rootPath, candidatePath);
    return (
        relative === "" ||
        (!path.isAbsolute(relative) &&
            relative !== ".." &&
            !relative.startsWith(`..${path.sep}`))
    );
}

function throwIfAborted(signal: AbortSignal | undefined): void {
    if (signal?.aborted) signal.throwIfAborted();
}

async function resolveRootDefinition(
    definition: TerminalRootDefinition
): Promise<ResolvedTerminalRoot> {
    try {
        if (
            !path.isAbsolute(definition.absolutePath) ||
            path.normalize(definition.absolutePath) !== definition.absolutePath
        ) {
            throw new TypeError("Terminal root path is invalid");
        }
        const absolutePath = await realpath(definition.absolutePath);
        const metadata = await lstat(absolutePath);
        if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
            throw new TypeError("Terminal root is not a directory");
        }
        return Object.freeze({
            absolutePath,
            publicRoot: v.parse(terminalRootSchema, {
                defaultPath: definition.defaultPath ?? "/",
                id: definition.id,
                label: definition.label,
            }),
        });
    } catch (error) {
        throw new TerminalRootAccessError("root-unavailable", error);
    }
}

/**
 * Builds the reviewed registry used to choose a realpath-fenced starting directory.
 * This deliberately does not claim to contain navigation after the real shell starts.
 * @param definitions The reviewed terminal starting roots.
 * @returns A registry that resolves public locations to canonical directories.
 */
export async function createTerminalRootRegistry(
    definitions: readonly TerminalRootDefinition[]
): Promise<TerminalRootRegistry> {
    if (definitions.length === 0 || definitions.length > 8) {
        throw new TerminalRootAccessError("root-unavailable");
    }
    const roots = await Promise.all(
        definitions.map((definition) => resolveRootDefinition(definition))
    );
    roots.sort((left, right) => left.publicRoot.id.localeCompare(right.publicRoot.id));
    if (new Set(roots.map(({ publicRoot }) => publicRoot.id)).size !== roots.length) {
        throw new TerminalRootAccessError("root-unavailable");
    }
    const byId = new Map(roots.map((root) => [root.publicRoot.id, root]));
    const defaultRoot = roots[0];
    if (defaultRoot === undefined) throw new TerminalRootAccessError("root-unavailable");

    const runtime = v.parse(terminalRuntimeSchema, {
        clientMessageMaximumBytes: terminalClientMessageMaximumBytes,
        defaultLocation: {
            path: defaultRoot.publicRoot.defaultPath,
            rootId: defaultRoot.publicRoot.id,
        },
        idleTimeoutMs: terminalIdleTimeoutMs,
        mode: terminalRuntimeMode,
        outputReplayMaximumBytes: terminalOutputReplayMaximumBytes,
        reconnectGraceMs: terminalReconnectGraceMs,
        roots: roots.map(({ publicRoot }) => publicRoot),
        serverMessageMaximumBytes: terminalServerMessageMaximumBytes,
        sessionMaximumDurationMs: terminalSessionMaximumDurationMs,
        supportsInput: true,
        supportsPty: true,
        supportsResize: true,
        supportsSignals: ["SIGINT", "SIGTERM", "SIGHUP"],
        webSocketProtocol: terminalWebSocketProtocol,
    });

    return Object.freeze<TerminalRootRegistry>({
        async resolveDirectory(location, signal) {
            throwIfAborted(signal);
            const parsed = v.parse(terminalLocationSchema, location);
            const root = byId.get(parsed.rootId);
            if (root === undefined) {
                throw new TerminalRootAccessError("invalid-location");
            }
            const segments = parsed.path === "/" ? [] : parsed.path.slice(1).split("/");
            const candidate = path.join(root.absolutePath, ...segments);
            try {
                const canonical = await realpath(candidate);
                throwIfAborted(signal);
                const metadata = await lstat(canonical);
                if (
                    !metadata.isDirectory() ||
                    metadata.isSymbolicLink() ||
                    !isPathWithin(root.absolutePath, canonical)
                ) {
                    throw new TerminalRootAccessError("invalid-location");
                }
                return canonical;
            } catch (error) {
                if (error instanceof TerminalRootAccessError) throw error;
                throw new TerminalRootAccessError("directory-unavailable", error);
            }
        },
        runtime: () => runtime,
    });
}
