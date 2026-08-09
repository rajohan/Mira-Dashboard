import type * as v from "valibot";

/** Schema type accepted by the contract documentation generator. */
export type ContractSchema = v.GenericSchema;

/** Exhaustive expected tRPC codes that procedures may intentionally expose. */
export const contractErrorCodes = [
    "BAD_REQUEST",
    "CONFLICT",
    "FORBIDDEN",
    "NOT_FOUND",
    "PRECONDITION_FAILED",
    "SERVICE_UNAVAILABLE",
    "TOO_MANY_REQUESTS",
    "UNAUTHORIZED",
] as const;

export type ContractErrorCode = (typeof contractErrorCodes)[number];

/** Stable client-action reasons attached to authentication policy errors. */
export const contractAuthenticationErrorReasons = [
    "mfa_enrollment_required",
    "step_up_required",
] as const;

export type ContractAuthenticationErrorReason =
    (typeof contractAuthenticationErrorReasons)[number];

/** Stable client-action reasons for externally dispatched operation uncertainty. */
export const contractOperationErrorReasons = ["operation_outcome_unknown"] as const;

export type ContractOperationErrorReason = (typeof contractOperationErrorReasons)[number];

/** Stable allowlisted client-action reason exposed by one expected procedure error. */
export type ContractErrorReason =
    | ContractAuthenticationErrorReason
    | ContractOperationErrorReason;

/** Authentication requirement shown in generated contract documentation. */
export type ContractAccess =
    | { kind: "public" }
    | { kind: "pending-login" }
    | {
          capabilities?: readonly string[];
          kind: "recent-auth";
          principalKinds?: readonly ("automation" | "session")[];
          whenMfaDisabled: "deny" | "password" | "session";
          whenMfaEnabled: "mfa";
      }
    | {
          capabilities: readonly string[];
          capabilityPolicy: "all" | "per-topic";
          kind: "authenticated";
          principalKinds?: readonly ("automation" | "session")[];
      };

/** Runtime HTTP policy attached to one controlled tRPC procedure. */
export interface ProcedureTransportContract {
    /** Whether the application boundary delegates batching or rejects it first. */
    batching: "adapter-default" | "forbidden";
    /** Bun idle-timeout profile used while the procedure is active. */
    handler: "authentication" | "default" | "long-lived";
    /** Raw request-body budget selected before authentication and parsing. */
    requestBody:
        | "authentication"
        | "chat-send"
        | "default"
        | "monitoring"
        | "task-content"
        | "task-progress"
        | "webauthn";
}

/** Metadata for one controlled tRPC procedure. */
export interface ProcedureContract {
    access: ContractAccess;
    domain: string;
    errorReasons?: readonly ContractErrorReason[];
    errors: readonly ContractErrorCode[];
    input: ContractSchema;
    inputSchemaId: string;
    kind: "mutation" | "query" | "subscription";
    name: string;
    output: ContractSchema;
    outputSchemaId: string;
    summary: string;
    transport: ProcedureTransportContract;
}

/**
 * Fails closed for duplicate procedure names or error metadata that is
 * unregistered, duplicated, or unstable.
 * @param contracts Procedure names and their declared expected error codes.
 */
export function assertProcedureContractErrors(
    contracts: readonly Pick<ProcedureContract, "errorReasons" | "errors" | "name">[]
): void {
    const names = contracts.map(({ name }) => name);
    if (new Set(names).size !== names.length) {
        throw new TypeError("Procedure contract names must be unique");
    }
    const registered = new Set<string>(contractErrorCodes);
    const registeredReasons = new Set<string>([
        ...contractAuthenticationErrorReasons,
        ...contractOperationErrorReasons,
    ]);
    for (const contract of contracts) {
        const errors = [...contract.errors];
        if (
            errors.some((error) => !registered.has(error)) ||
            new Set(errors).size !== errors.length ||
            errors.join("\n") !== errors.toSorted().join("\n")
        ) {
            throw new TypeError(
                `Procedure contract errors are invalid for ${contract.name}`
            );
        }
        const reasons = [...(contract.errorReasons ?? [])];
        if (
            reasons.some((reason) => !registeredReasons.has(reason)) ||
            new Set(reasons).size !== reasons.length ||
            reasons.join("\n") !== reasons.toSorted().join("\n")
        ) {
            throw new TypeError(
                `Procedure contract error reasons are invalid for ${contract.name}`
            );
        }
    }
}

/** Request/response entity contract for one raw HTTP operation. */
export type RawHttpBodyContract =
    | { kind: "none" }
    | {
          clientMaximumMessageBytes: number;
          kind: "websocket";
          protocol: string;
          serverMaximumMessageBytes: number;
      }
    | {
          contentTypes: readonly string[];
          kind: "binary";
          maximumBytes: number;
          transfer: "buffered" | "streamed";
      }
    | {
          contentTypes: readonly string[];
          kind: "schema";
          schema: ContractSchema;
          schemaId: string;
      };

/** Strict query-string metadata for one raw HTTP operation. */
export interface RawHttpQueryContract {
    additionalParameters: "forbidden";
    parameters: readonly {
        name: string;
        required: boolean;
        values: readonly string[];
    }[];
}

/** Metadata for one raw HTTP operation. */
export interface RawHttpContract {
    access: ContractAccess;
    method: "GET" | "HEAD" | "POST" | "PUT";
    path: string;
    query?: RawHttpQueryContract;
    rangeRequests: "none" | "single-byte-range";
    requestBody: RawHttpBodyContract;
    response: RawHttpBodyContract;
    statusCodes: readonly number[];
    summary: string;
}

/** Metadata for one resumable realtime topic. */
export interface RealtimeEventContract {
    payload: ContractSchema;
    payloadSchemaId: string;
    retention: string;
    snapshotProcedure: string;
    summary: string;
    topic: string;
}
