import type * as v from "valibot";

/** Schema type accepted by the contract documentation generator. */
export type ContractSchema = v.GenericSchema;

/** Authentication requirement shown in generated contract documentation. */
export type ContractAccess =
    | { kind: "public" }
    | { capabilities: readonly string[]; kind: "authenticated" };

/** Metadata for one controlled tRPC procedure. */
export interface ProcedureContract {
    access: ContractAccess;
    domain: string;
    errors: readonly string[];
    input: ContractSchema;
    inputSchemaId: string;
    kind: "mutation" | "query" | "subscription";
    name: string;
    output: ContractSchema;
    outputSchemaId: string;
    summary: string;
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
