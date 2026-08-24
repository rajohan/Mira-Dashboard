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

/** Authentication requirement shown in generated contract documentation. */
export type ContractAccess =
    | { kind: "public" }
    | { kind: "pending-login" }
    | {
          kind: "recent-auth";
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
    errorReasons?: readonly ContractAuthenticationErrorReason[];
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
    contracts: readonly Pick<ProcedureContract, "errors" | "name">[]
): void {
    const names = contracts.map(({ name }) => name);
    if (new Set(names).size !== names.length) {
        throw new TypeError("Procedure contract names must be unique");
    }
    const registered = new Set<string>(contractErrorCodes);
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
    }
}

/** Response-body contract for one raw HTTP operation. */
export type RawHttpResponseContract =
    | { kind: "none" }
    | { kind: "schema"; schema: ContractSchema; schemaId: string };

/** Metadata for one raw HTTP operation. */
export interface RawHttpContract {
    access: ContractAccess;
    method: "GET" | "HEAD" | "POST";
    path: string;
    response: RawHttpResponseContract;
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
