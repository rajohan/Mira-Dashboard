import {
    parseFrontendParityFixture,
    parseGreenfieldContractParityFixture,
    parseLegacyEndpointParityFixture,
    type FrontendParityFixture,
    type GreenfieldContractParityFixture,
    type LegacyEndpointParityFixture,
} from "./parityInventorySchemas.ts";
import type { ReviewedParityInventory } from "./reviewedParityInventory.ts";
import type { SourceParityInventory } from "./sourceParityInventory.ts";

export interface ParityFixtureCandidate {
    frontend: FrontendParityFixture;
    legacyEndpoints: LegacyEndpointParityFixture;
}

interface ProcedureContractCandidate {
    kind: "mutation" | "query" | "subscription";
    name: string;
}

interface RawHttpContractCandidate {
    method: "DELETE" | "GET" | "HEAD" | "PATCH" | "POST" | "PUT";
    path: string;
}

function compareStrings(left: string, right: string): number {
    if (left < right) return -1;
    if (left > right) return 1;
    return 0;
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
    return parseGreenfieldContractParityFixture({
        contentPolicy: {
            containsHostConfiguration: false,
            containsRuntimeState: false,
            containsSecrets: false,
            sourceBacked: true,
        },
        procedures: procedureContracts
            .map(({ kind, name }) => ({ kind, name }))
            .toSorted((left, right) => compareStrings(left.name, right.name)),
        rawHttp: rawHttpContracts
            .map(({ method, path }) => ({ id: `${method} ${path}`, method, path }))
            .toSorted((left, right) => compareStrings(left.id, right.id)),
        schemaVersion: 1,
        source: "src/contracts/contractRegistry.ts",
    });
}

/**
 * Builds a source-refreshed candidate while preserving only explicitly reviewed target mappings.
 * New route paths or endpoint ids fail instead of receiving an inferred target.
 * @param observed Current semantic source inventory.
 * @param reviewed Committed reviewed inventory and target mappings.
 * @returns Source-refreshed fixture candidate.
 */
export function buildParityFixtureCandidate(
    observed: SourceParityInventory,
    reviewed: ReviewedParityInventory
): ParityFixtureCandidate {
    const reviewedRoutes = new Map(
        reviewed.frontend.routes.map((route) => [route.path, route] as const)
    );
    const reviewedEndpoints = new Map(
        reviewed.legacyEndpoints.endpoints.map(
            (endpoint) => [endpoint.id, endpoint] as const
        )
    );
    const frontend = parseFrontendParityFixture({
        ...reviewed.frontend,
        routes: observed.routes.map((route) => {
            const target = reviewedRoutes.get(route.path);
            if (!target) {
                throw new Error(
                    `Frontend route ${route.path} needs an explicit parity target review`
                );
            }
            return {
                ...route,
                featureOwner: target.featureOwner,
                target: target.target,
            };
        }),
    });
    const legacyEndpoints = parseLegacyEndpointParityFixture({
        ...reviewed.legacyEndpoints,
        endpoints: observed.endpoints.map((endpoint) => {
            const target = reviewedEndpoints.get(endpoint.id)?.target;
            if (!target) {
                throw new Error(
                    `Legacy endpoint ${endpoint.id} needs an explicit parity target review`
                );
            }
            return { ...endpoint, target };
        }),
    });
    return {
        frontend,
        legacyEndpoints,
    };
}
