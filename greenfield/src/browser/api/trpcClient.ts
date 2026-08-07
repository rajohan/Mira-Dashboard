import { createTRPCUntypedClient, httpLink, type TRPCRequestOptions } from "@trpc/client";
import superjson from "superjson";
import * as v from "valibot";

import type { RegisteredProcedureContract } from "../../contracts/contractRegistry.ts";
import type { ProcedureContract } from "../../contracts/registry.ts";

type ProcedureOfKind<TKind extends RegisteredProcedureContract["kind"]> = Extract<
    RegisteredProcedureContract,
    { readonly kind: TKind }
>;

/** Exact registered query name exposed to browser callers. */
export type DashboardQueryName = ProcedureOfKind<"query">["name"];

/** Exact registered mutation name exposed to browser callers. */
export type DashboardMutationName = ProcedureOfKind<"mutation">["name"];

type DashboardProcedureName = DashboardMutationName | DashboardQueryName;
type ContractForName<TName extends DashboardProcedureName> = Extract<
    RegisteredProcedureContract,
    { readonly name: TName }
>;

/** Validated input for one exact registered query or mutation. */
export type DashboardProcedureInput<TName extends DashboardProcedureName> = v.InferOutput<
    ContractForName<TName>["input"]
>;

/** Validated output for one exact registered query or mutation. */
export type DashboardProcedureOutput<TName extends DashboardProcedureName> =
    v.InferOutput<ContractForName<TName>["output"]>;

/** Minimal transport authority retained behind the browser contract boundary. */
export interface DashboardTrpcTransport {
    mutation(
        path: string,
        input?: unknown,
        options?: TRPCRequestOptions
    ): Promise<unknown>;
    query(path: string, input?: unknown, options?: TRPCRequestOptions): Promise<unknown>;
}

/** Browser-safe protocol failure without response or validation details. */
export class DashboardProtocolError extends Error {
    constructor() {
        super("Dashboard response did not match its contract");
        this.name = "DashboardProtocolError";
    }
}

/** Contract-validating browser client for registered non-streaming procedures. */
export interface DashboardTrpcClient {
    mutation<TName extends DashboardMutationName>(
        name: TName,
        input: DashboardProcedureInput<TName>,
        options?: TRPCRequestOptions
    ): Promise<DashboardProcedureOutput<TName>>;
    query<TName extends DashboardQueryName>(
        name: TName,
        input: DashboardProcedureInput<TName>,
        options?: TRPCRequestOptions
    ): Promise<DashboardProcedureOutput<TName>>;
}

async function procedureContractsFor(
    name: DashboardProcedureName
): Promise<readonly ProcedureContract[]> {
    const domain = name.slice(0, name.indexOf("."));
    switch (domain) {
        case "agents": {
            const module = await import("../../contracts/agents.ts");
            return module.agentProcedureContracts;
        }
        case "incidents": {
            const module = await import("../../contracts/incidents.ts");
            return module.incidentProcedureContracts;
        }
        case "notifications": {
            const module = await import("../../contracts/notifications.ts");
            return module.notificationProcedureContracts;
        }
        case "accountSecurity": {
            const module = await import("../../contracts/accountSecurity.ts");
            return module.accountSecurityProcedureContracts;
        }
        case "auth": {
            const module = await import("../../contracts/auth.ts");
            return module.authProcedureContracts;
        }
        case "reports": {
            const module = await import("../../contracts/reports.ts");
            return module.reportProcedureContracts;
        }
        case "automationSecurity": {
            const module = await import("../../contracts/automationSecurity.ts");
            return module.automationSecurityProcedureContracts;
        }
        case "securityAudit": {
            const module = await import("../../contracts/securityAudit.ts");
            return module.securityAuditProcedureContracts;
        }
        case "system": {
            const module = await import("../../contracts/system.ts");
            return module.systemProcedureContracts;
        }
        case "tasks": {
            const module = await import("../../contracts/tasks.ts");
            return module.taskProcedureContracts;
        }
        default: {
            throw new DashboardProtocolError();
        }
    }
}

async function contractFor(
    name: DashboardProcedureName,
    kind: "mutation" | "query"
): Promise<ProcedureContract> {
    const contracts = await procedureContractsFor(name);
    const contract = contracts.find((candidate) => candidate.name === name);
    if (contract === undefined || contract.kind !== kind) {
        throw new DashboardProtocolError();
    }
    return contract;
}

function parseContractValue<TValue>(schema: v.GenericSchema, value: unknown): TValue {
    const result = v.safeParse(schema, value);
    if (!result.success) throw new DashboardProtocolError();
    return result.output as TValue;
}

/**
 * Creates the same-origin, non-batching tRPC transport used by the browser.
 * @param url Same-origin tRPC mount.
 * @returns One untyped transport kept behind validated procedure contracts.
 */
export function createDashboardTrpcTransport(url = "/trpc"): DashboardTrpcTransport {
    return createTRPCUntypedClient({
        links: [
            httpLink({
                fetch(input, init) {
                    return globalThis.fetch(input, {
                        ...init,
                        cache: "no-store",
                        credentials: "same-origin",
                    });
                },
                transformer: superjson,
                url,
            }),
        ],
    });
}

/**
 * Creates a browser client that validates both request and response values against
 * the same Valibot contracts used by the server and generated documentation.
 * @param transport Injected tRPC transport for the application or an isolated test.
 * @returns Typed query and mutation operations.
 */
export function createDashboardTrpcClient(
    transport: DashboardTrpcTransport = createDashboardTrpcTransport()
): DashboardTrpcClient {
    return {
        async mutation(name, input, options) {
            const contract = await contractFor(name, "mutation");
            const parsedInput = parseContractValue<DashboardProcedureInput<typeof name>>(
                contract.input,
                input
            );
            const output = await transport.mutation(name, parsedInput, options);
            return parseContractValue<DashboardProcedureOutput<typeof name>>(
                contract.output,
                output
            );
        },
        async query(name, input, options) {
            const contract = await contractFor(name, "query");
            const parsedInput = parseContractValue<DashboardProcedureInput<typeof name>>(
                contract.input,
                input
            );
            const output = await transport.query(name, parsedInput, options);
            return parseContractValue<DashboardProcedureOutput<typeof name>>(
                contract.output,
                output
            );
        },
    };
}
