import { procedureContracts } from "../contracts/contractRegistry.ts";
import type { ProcedureContract } from "../contracts/registry.ts";

/** Stable path mounted by the application tRPC Fetch adapter. */
export const trpcEndpoint = "/trpc";
/** Default raw body ceiling for non-authentication tRPC procedures. */
export const trpcRequestBodyMaximumBytes = 64 * 1024;
/** Raw body ceiling for task create and content-update procedures. */
export const taskContentRequestBodyMaximumBytes = 640 * 1024;
/** Raw body ceiling for task progress create and update procedures. */
export const taskProgressRequestBodyMaximumBytes = 128 * 1024;
/** Bun-level ceiling applied before the Fetch handler is invoked. */
export const serverRequestBodyMaximumBytes = taskContentRequestBodyMaximumBytes;
/** Raw body ceiling for authentication and account-security procedures. */
export const authenticationRequestBodyMaximumBytes = 16 * 1024;
/** Raw body ceiling for bounded WebAuthn authentication responses. */
export const webAuthnRequestBodyMaximumBytes = 32 * 1024;
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

function usesAuthenticationTransport(contract: ProcedureContract): boolean {
    return (
        contract.transport.handler === "authentication" ||
        usesAuthenticationRequestBody(contract)
    );
}

function usesAuthenticationRequestBody(contract: ProcedureContract): boolean {
    return (
        contract.transport.requestBody === "authentication" ||
        contract.transport.requestBody === "webauthn"
    );
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
        if (usesAuthenticationTransport(contract)) {
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
                !usesAuthenticationRequestBody(contract))
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

// Mirrors the Fetch adapter's single leading/trailing slash normalization pass.
function trimAdapterSlashes(path: string): string {
    const withoutLeadingSlash = path.startsWith("/") ? path.slice(1) : path;
    return withoutLeadingSlash.endsWith("/")
        ? withoutLeadingSlash.slice(0, -1)
        : withoutLeadingSlash;
}

function encodedAdapterProcedurePath(pathname: string): string {
    const normalizedPathname = trimAdapterSlashes(pathname);
    const normalizedEndpoint = trimAdapterSlashes(trpcEndpoint);
    return trimAdapterSlashes(normalizedPathname.slice(normalizedEndpoint.length));
}

// Decodes valid byte escapes without hiding a namespace behind another invalid escape.
function bestEffortDecodePercentEscapes(encodedPath: string): string {
    return encodedPath.replaceAll(/%([\da-f]{2})/giu, (_escape, hexadecimal: string) =>
        String.fromCodePoint(Number.parseInt(hexadecimal, 16))
    );
}

function encodedPathContainsAuthenticationNamespace(
    encodedProcedures: string,
    isBatchRequest: boolean
): boolean {
    const normalized = bestEffortDecodePercentEscapes(encodedProcedures).toLowerCase();
    const normalizedNamespaces = [...authenticationNamespaces].map((namespace) =>
        namespace.toLowerCase()
    );
    const procedures = isBatchRequest ? normalized.split(",") : [normalized];
    return procedures.some((procedure) =>
        normalizedNamespaces.some((namespace) => procedure.startsWith(`${namespace}.`))
    );
}

function effectivePolicy(input: {
    readonly containsAuthenticationProcedure: boolean;
    readonly containsForbiddenBatchProcedure: boolean;
    readonly containsLongLivedProcedure: boolean;
    readonly containsTaskContentProcedure: boolean;
    readonly containsTaskProgressProcedure: boolean;
    readonly containsWebAuthnProcedure: boolean;
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
    let requestBodyMaximumBytes = trpcRequestBodyMaximumBytes;
    if (input.containsTaskContentProcedure) {
        requestBodyMaximumBytes = taskContentRequestBodyMaximumBytes;
    }
    if (input.containsTaskProgressProcedure) {
        requestBodyMaximumBytes = taskProgressRequestBodyMaximumBytes;
    }
    if (input.containsAuthenticationProcedure) {
        requestBodyMaximumBytes = authenticationRequestBodyMaximumBytes;
    }
    if (input.containsWebAuthnProcedure) {
        requestBodyMaximumBytes = webAuthnRequestBodyMaximumBytes;
    }
    return Object.freeze({
        ...handlerPolicy,
        rejectsBatch: input.isBatchRequest && input.containsForbiddenBatchProcedure,
        requestBodyMaximumBytes,
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
    const encodedProcedures = encodedAdapterProcedurePath(url.pathname);
    const isBatchRequest = url.searchParams.get("batch") === "1";
    try {
        const decodedProcedures = decodeURIComponent(encodedProcedures);
        const procedures = isBatchRequest
            ? decodedProcedures.split(",")
            : [decodedProcedures];
        let containsAuthenticationProcedure = false;
        let containsForbiddenBatchProcedure = false;
        let containsLongLivedProcedure = false;
        let containsTaskContentProcedure = false;
        let containsTaskProgressProcedure = false;
        let containsWebAuthnProcedure = false;
        for (const procedure of procedures) {
            const contract = contractsByName.get(procedure);
            if (contract !== undefined) {
                containsAuthenticationProcedure ||=
                    contract.transport.handler === "authentication";
                containsForbiddenBatchProcedure ||=
                    contract.transport.batching === "forbidden";
                containsLongLivedProcedure ||=
                    contract.transport.handler === "long-lived";
                containsTaskContentProcedure ||=
                    contract.transport.requestBody === "task-content";
                containsTaskProgressProcedure ||=
                    contract.transport.requestBody === "task-progress";
                containsWebAuthnProcedure ||=
                    contract.transport.requestBody === "webauthn";
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
            containsTaskContentProcedure,
            containsTaskProgressProcedure,
            containsWebAuthnProcedure,
            isBatchRequest,
        });
    } catch {
        const containsAuthenticationProcedure =
            encodedPathContainsAuthenticationNamespace(encodedProcedures, isBatchRequest);
        return effectivePolicy({
            containsAuthenticationProcedure,
            containsForbiddenBatchProcedure: containsAuthenticationProcedure,
            containsLongLivedProcedure: false,
            containsTaskContentProcedure: false,
            containsTaskProgressProcedure: false,
            containsWebAuthnProcedure: false,
            isBatchRequest,
        });
    }
}
