import {
    parseGreenfieldContractParityFixture,
    type GreenfieldContractParityFixture,
} from "./parityInventorySchemas.ts";

export interface ProcedureContractCandidate {
    kind: "mutation" | "query" | "subscription";
    name: string;
}

export type ProcedureContractIdentity = ProcedureContractCandidate;

export interface RawHttpContractCandidate {
    method: "DELETE" | "GET" | "HEAD" | "PATCH" | "POST" | "PUT";
    path: string;
}

export interface RawHttpContractIdentity {
    method: string;
    path: string;
}

function compareStrings(left: string, right: string): number {
    if (left < right) return -1;
    if (left > right) return 1;
    return 0;
}

/**
 * Projects live registry entries into their deterministic reviewed identity shape.
 * @param procedureContracts Live procedure registry entries.
 * @param rawHttpContracts Live raw HTTP registry entries.
 * @returns Sorted procedure and raw HTTP identities.
 */
export function projectGreenfieldContractIdentities<TMethod extends string>(
    procedureContracts: readonly ProcedureContractIdentity[],
    rawHttpContracts: readonly { readonly method: TMethod; readonly path: string }[]
): {
    readonly procedures: readonly ProcedureContractIdentity[];
    readonly rawHttp: readonly {
        readonly id: string;
        readonly method: TMethod;
        readonly path: string;
    }[];
} {
    return {
        procedures: procedureContracts
            .map(({ kind, name }) => ({ kind, name }))
            .toSorted((left, right) => compareStrings(left.name, right.name)),
        rawHttp: rawHttpContracts
            .map(({ method, path }) => ({ id: `${method} ${path}`, method, path }))
            .toSorted((left, right) => compareStrings(left.id, right.id)),
    };
}

/**
 * Builds a deterministic greenfield registry identity candidate.
 * @param procedureContracts Live procedure registry entries.
 * @param rawHttpContracts Live raw HTTP registry entries.
 * @returns Strict registry identity fixture candidate.
 */
export function buildGreenfieldContractFixtureCandidate(
    procedureContracts: readonly ProcedureContractCandidate[],
    rawHttpContracts: readonly RawHttpContractCandidate[]
): GreenfieldContractParityFixture {
    const identities = projectGreenfieldContractIdentities(
        procedureContracts,
        rawHttpContracts
    );
    return parseGreenfieldContractParityFixture({
        contentPolicy: {
            containsHostConfiguration: false,
            containsRuntimeState: false,
            containsSecrets: false,
            sourceBacked: true,
        },
        ...identities,
        schemaVersion: 1,
        source: "src/contracts/contractRegistry.ts",
    });
}
