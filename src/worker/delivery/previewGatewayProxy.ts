import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";

import type {
    PreviewGatewayProxyPort,
    PreviewGatewayRequest,
    PreviewGatewayResponse,
} from "../../shared/previewGatewayProtocol.ts";
import { PreviewHostError } from "./previewTypes.ts";

const capabilityBytes = 32;
const directoryOpenFlags =
    constants.O_RDONLY |
    constants.O_DIRECTORY |
    constants.O_NOFOLLOW |
    constants.O_NONBLOCK;

export type {
    PreviewGatewayProxyPort,
    PreviewGatewayRequest,
    PreviewGatewayResponse,
} from "../../shared/previewGatewayProtocol.ts";

export interface PreviewGatewayCapability {
    readonly socketPath: string;
    readonly token: string;
}

export interface PreviewGatewaySocketSpecification {
    readonly allowedOperations: readonly PreviewGatewayRequest["operation"][];
    readonly bodyMaximumBytes: number;
    readonly capability: string;
    readonly requestDeadlineMs: number;
    readonly socketMode: 0o600;
    readonly socketPath: string;
}

function fail(reason: PreviewHostError["reason"]): never {
    throw new PreviewHostError({ reason });
}

/**
 * Materializes one random narrow capability for a trusted Unix-socket broker.
 * @param input Private capability root owned by the preview host.
 * @returns In-memory capability and its private socket path.
 */
export async function createPreviewGatewayCapability(input: {
    readonly capabilityRoot: string;
}): Promise<PreviewGatewayCapability> {
    if (
        !path.isAbsolute(input.capabilityRoot) ||
        path.normalize(input.capabilityRoot) !== input.capabilityRoot
    ) {
        fail("path-unsafe");
    }
    const directory = await open(input.capabilityRoot, directoryOpenFlags).catch(() =>
        fail("path-unsafe")
    );
    try {
        const [held, named, canonical] = await Promise.all([
            directory.stat({ bigint: true }),
            lstat(input.capabilityRoot, { bigint: true }),
            realpath(`/proc/self/fd/${directory.fd}`),
        ]);
        if (
            typeof process.getuid !== "function" ||
            !held.isDirectory() ||
            held.isSymbolicLink() ||
            !named.isDirectory() ||
            named.isSymbolicLink() ||
            held.uid !== BigInt(process.getuid()) ||
            named.uid !== held.uid ||
            held.dev !== named.dev ||
            held.ino !== named.ino ||
            (held.mode & 0o7777n) !== 0o700n ||
            canonical !== input.capabilityRoot
        ) {
            fail("path-unsafe");
        }
    } finally {
        await directory.close();
    }
    const token = crypto
        .getRandomValues(new Uint8Array(capabilityBytes))
        .toBase64({ alphabet: "base64url", omitPadding: true });
    // The token remains worker memory only. PR code reaches a private Unix socket
    // already bound to this capability, so no bearer secret is mounted into it.
    return Object.freeze({
        socketPath: path.join(input.capabilityRoot, "gateway.sock"),
        token,
    });
}

/**
 * Returns the complete bounded contract for a trusted proxy implementation.
 * @param capability Exact in-memory capability to bind.
 * @returns Frozen broker socket specification.
 */
export function buildPreviewGatewaySocketSpecification(
    capability: PreviewGatewayCapability
): PreviewGatewaySocketSpecification {
    if (
        !path.isAbsolute(capability.socketPath) ||
        path.normalize(capability.socketPath) !== capability.socketPath ||
        !/^[A-Za-z0-9_-]{43}$/u.test(capability.token)
    ) {
        fail("invalid-request");
    }
    return Object.freeze({
        allowedOperations: Object.freeze<PreviewGatewayRequest["operation"][]>([
            "chat-history",
            "chat-send",
            "session-status",
        ]),
        bodyMaximumBytes: 64 * 1024,
        capability: capability.token,
        requestDeadlineMs: 10_000,
        socketMode: 0o600,
        socketPath: capability.socketPath,
    });
}

/**
 * Validates the untrusted preview request before delegating to the narrow port.
 * @param specification Exact broker contract.
 * @param port Narrow production Gateway proxy port.
 * @param request Untrusted preview request.
 * @param signal Optional cancellation signal.
 * @returns Bounded proxy response.
 */
export async function invokePreviewGateway(
    specification: PreviewGatewaySocketSpecification,
    port: PreviewGatewayProxyPort,
    request: PreviewGatewayRequest,
    signal?: AbortSignal
): Promise<PreviewGatewayResponse> {
    if (
        request.capability !== specification.capability ||
        !specification.allowedOperations.includes(request.operation) ||
        request.body.byteLength > specification.bodyMaximumBytes
    ) {
        fail("invalid-request");
    }
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), specification.requestDeadlineMs);
    const onAbort = () => abort.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
        const response = await port.invoke(request, abort.signal);
        if (response.body.byteLength > specification.bodyMaximumBytes) {
            fail("operation-failed");
        }
        return response;
    } catch (error) {
        if (error instanceof PreviewHostError) throw error;
        return fail("operation-failed");
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
    }
}
