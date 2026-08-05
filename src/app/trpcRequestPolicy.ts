import { procedureContracts } from "../contracts/contractRegistry.ts";
import type { ProcedureContract } from "../contracts/registry.ts";

/** Stable path mounted by the application tRPC Fetch adapter. */
export const trpcEndpoint = "/trpc";
/** Bun-level ceiling applied before the Fetch handler is invoked. */
export const serverRequestBodyMaximumBytes = 64 * 1024;
/** Default raw body ceiling for non-authentication tRPC procedures. */
export const trpcRequestBodyMaximumBytes = serverRequestBodyMaximumBytes;
/** Raw body ceiling for authentication and account-security procedures. */
export const authenticationRequestBodyMaximumBytes = 16 * 1024;
/** Maximum procedure count accepted by the tRPC adapter in one request. */
export const trpcMaximumBatchSize = 8;
/** Idle budget for bounded authentication cryptography and upstream verification. */
export const authenticationHandlerIdleTimeoutSeconds = 120;

/** Effective HTTP policy selected before context creation or input parsing. */
export interface TrpcRequestPolicy {
    readonly handlerIdleTimeoutSeconds?: number;
    readonly rejectsBatch: boolean;
    readonly requestBodyMaximumBytes: number;
}

function procedureNamespace(name: string): string | undefined {
    const separator = name.indexOf(".");
    return separator <= 0 ? undefined : name.slice(0, separator);
}

function buildProcedureContractIndex(contracts: readonly ProcedureContract[]): {
    readonly authenticationNamespaces: ReadonlySet<string>;
    readonly contractsByName: ReadonlyMap<string, ProcedureContract>;
} {
    const contractsByName = new Map<string, ProcedureContract>();
    const authenticationNamespaces = new Set<string>();
    for (const contract of contracts) {
        if (contractsByName.has(contract.name)) {
            throw new Error(`Duplicate tRPC procedure contract: ${contract.name}`);
        }
        contractsByName.set(contract.name, contract);
        if (
            contract.transport.handler === "authentication" ||
            contract.transport.requestBody === "authentication"
        ) {
            const namespace = procedureNamespace(contract.name);
            if (namespace === undefined) {
                throw new Error(
                    `Authentication procedure contract has no namespace: ${contract.name}`
                );
            }
            authenticationNamespaces.add(namespace);
        }
    }
    for (const contract of contracts) {
        const namespace = procedureNamespace(contract.name);
        if (
            namespace !== undefined &&
            authenticationNamespaces.has(namespace) &&
            (contract.transport.handler !== "authentication" ||
                contract.transport.requestBody !== "authentication")
        ) {
            throw new Error(
                `Authentication procedure namespace has inconsistent transport policy: ${namespace}`
            );
        }
    }
    return { authenticationNamespaces, contractsByName };
}

const { authenticationNamespaces, contractsByName } =
    buildProcedureContractIndex(procedureContracts);

function encodedPathContainsAuthenticationNamespace(encodedProcedures: string): boolean {
    const normalized = encodedProcedures
        .replaceAll(/%2c/giu, ",")
        .replaceAll(/%2e/giu, ".")
        .toLowerCase();
    const normalizedNamespaces = [...authenticationNamespaces].map((namespace) =>
        namespace.toLowerCase()
    );
    return normalized
        .split(",")
        .some((procedure) =>
            normalizedNamespaces.some((namespace) =>
                procedure.replace(/\/+$/u, "").startsWith(`${namespace}.`)
            )
        );
}

function effectivePolicy(input: {
    readonly containsAuthenticationProcedure: boolean;
    readonly containsForbiddenBatchProcedure: boolean;
    readonly containsLongLivedProcedure: boolean;
    readonly isBatchRequest: boolean;
}): TrpcRequestPolicy {
    let handlerIdleTimeoutSeconds: number | undefined;
    if (input.containsLongLivedProcedure) {
        handlerIdleTimeoutSeconds = 0;
    } else if (input.containsAuthenticationProcedure) {
        handlerIdleTimeoutSeconds = authenticationHandlerIdleTimeoutSeconds;
    }
    const handlerPolicy =
        handlerIdleTimeoutSeconds === undefined ? {} : { handlerIdleTimeoutSeconds };
    return Object.freeze({
        ...handlerPolicy,
        rejectsBatch: input.isBatchRequest && input.containsForbiddenBatchProcedure,
        requestBodyMaximumBytes: input.containsAuthenticationProcedure
            ? authenticationRequestBodyMaximumBytes
            : trpcRequestBodyMaximumBytes,
    });
}

/**
 * Returns whether a pathname belongs to the exact tRPC mount.
 * @param pathname Raw request pathname.
 * @returns Whether the application tRPC handler owns the path.
 */
export function isTrpcRequestPath(pathname: string): boolean {
    return pathname === trpcEndpoint || pathname.startsWith(`${trpcEndpoint}/`);
}

/**
 * Resolves strict body, batching, and idle policies from registered procedure metadata.
 * Unknown names under an authentication namespace inherit its strict profile.
 * @param url Parsed request URL containing the procedure selection.
 * @returns Effective pre-context request policy.
 */
export function readTrpcRequestPolicy(url: URL): TrpcRequestPolicy {
    const encodedProcedures = url.pathname.slice(`${trpcEndpoint}/`.length);
    const isBatchRequest = url.searchParams.get("batch") === "1";
    try {
        const procedures = decodeURIComponent(encodedProcedures)
            .split(",")
            .map((procedure) => procedure.replace(/\/+$/u, ""));
        let containsAuthenticationProcedure = false;
        let containsForbiddenBatchProcedure = false;
        let containsLongLivedProcedure = false;
        for (const procedure of procedures) {
            const contract = contractsByName.get(procedure);
            if (contract !== undefined) {
                containsAuthenticationProcedure ||=
                    contract.transport.handler === "authentication";
                containsForbiddenBatchProcedure ||=
                    contract.transport.batching === "forbidden";
                containsLongLivedProcedure ||=
                    contract.transport.handler === "long-lived";
                continue;
            }
            const namespace = procedureNamespace(procedure);
            if (namespace !== undefined && authenticationNamespaces.has(namespace)) {
                containsAuthenticationProcedure = true;
                containsForbiddenBatchProcedure = true;
            }
        }
        return effectivePolicy({
            containsAuthenticationProcedure,
            containsForbiddenBatchProcedure,
            containsLongLivedProcedure,
            isBatchRequest,
        });
    } catch {
        const containsAuthenticationProcedure =
            encodedPathContainsAuthenticationNamespace(encodedProcedures);
        return effectivePolicy({
            containsAuthenticationProcedure,
            containsForbiddenBatchProcedure: containsAuthenticationProcedure,
            containsLongLivedProcedure: false,
            isBatchRequest,
        });
    }
}
