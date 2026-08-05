import type * as v from "valibot";

/** Schema type accepted by the contract documentation generator. */
export type ContractSchema = v.GenericSchema;

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
    requestBody: "authentication" | "default";
}

/** Metadata for one controlled tRPC procedure. */
export interface ProcedureContract {
    access: ContractAccess;
    domain: string;
    errorReasons?: readonly ContractAuthenticationErrorReason[];
    errors: readonly string[];
    input: ContractSchema;
    inputSchemaId: string;
    kind: "mutation" | "query" | "subscription";
    name: string;
    output: ContractSchema;
    outputSchemaId: string;
    summary: string;
    transport: ProcedureTransportContract;
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
