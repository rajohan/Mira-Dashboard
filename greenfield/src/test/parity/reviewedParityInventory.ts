import path from "node:path";
import { fileURLToPath } from "node:url";

import { readBoundedUtf8RegularFile } from "../../../scripts/files/boundedFile.ts";
import {
    projectGreenfieldContractIdentities,
    type ProcedureContractIdentity,
    type RawHttpContractIdentity,
} from "./parityFixtureCandidate.ts";
import {
    parseFrontendParityFixture,
    parseGreenfieldContractParityFixture,
    parseLegacyEndpointParityFixture,
    type FrontendParityFixture,
    type GreenfieldContractParityFixture,
    type LegacyEndpointParityFixture,
} from "./parityInventorySchemas.ts";

const fixtureDirectory = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "fixtures"
);
const maximumFixtureBytes = 256 * 1024;

export interface ReviewedParityInventory {
    frontend: FrontendParityFixture;
    greenfieldContracts: GreenfieldContractParityFixture;
    legacyEndpoints: LegacyEndpointParityFixture;
}

function compareStrings(left: string, right: string): number {
    if (left < right) return -1;
    if (left > right) return 1;
    return 0;
}

function withCanonicalObjectKeyOrder(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value.map((nested) => withCanonicalObjectKeyOrder(nested));
    }
    if (typeof value !== "object" || value === null) return value;
    return Object.fromEntries(
        Object.entries(value)
            .toSorted(([left], [right]) => compareStrings(left, right))
            .map(([key, nested]) => [key, withCanonicalObjectKeyOrder(nested)])
    );
}

function canonicalJson(value: unknown): string {
    return `${JSON.stringify(withCanonicalObjectKeyOrder(value), undefined, 2)}\n`;
}

async function loadJsonFixture(fileName: string): Promise<unknown> {
    const fixturePath = path.join(fixtureDirectory, fileName);
    const fixture = await readBoundedUtf8RegularFile(
        fixturePath,
        fixtureDirectory,
        maximumFixtureBytes,
        `Parity fixture ${fileName} has invalid file state`,
        `Parity fixture ${fileName} is not valid UTF-8`
    );
    try {
        return JSON.parse(fixture.text) as unknown;
    } catch {
        throw new Error(`Parity fixture ${fileName} is not valid JSON`);
    }
}

/**
 * Loads and strictly validates the committed parity inventory fixtures.
 * @returns Validated reviewed parity inventory.
 */
export async function loadReviewedParityInventory(): Promise<ReviewedParityInventory> {
    const [frontend, greenfieldContracts, legacyEndpoints] = await Promise.all([
        loadJsonFixture("frontend-routes.json"),
        loadJsonFixture("greenfield-contracts.json"),
        loadJsonFixture("legacy-endpoints.json"),
    ]);
    return {
        frontend: parseFrontendParityFixture(frontend),
        greenfieldContracts: parseGreenfieldContractParityFixture(greenfieldContracts),
        legacyEndpoints: parseLegacyEndpointParityFixture(legacyEndpoints),
    };
}

function contractKey(method: string, routePath: string): string {
    return `${method} ${routePath}`;
}

/** Fails when the live greenfield contract registry differs from the reviewed identity set. */
export function assertGreenfieldRegistryMatchesReviewed(
    reviewed: ReviewedParityInventory,
    procedureContracts: readonly ProcedureContractIdentity[],
    rawHttpContracts: readonly RawHttpContractIdentity[]
): void {
    const observed = projectGreenfieldContractIdentities(
        procedureContracts,
        rawHttpContracts
    );
    const expected = {
        procedures: reviewed.greenfieldContracts.procedures,
        rawHttp: reviewed.greenfieldContracts.rawHttp,
    };
    if (canonicalJson(observed) !== canonicalJson(expected)) {
        throw new Error("Greenfield contract registry differs from reviewed fixtures");
    }
}

/** Verifies that every implemented server target exists in the live registries. */
export function assertGreenfieldTargetAccounting(
    reviewed: ReviewedParityInventory,
    procedureContracts: readonly ProcedureContractIdentity[],
    rawHttpContracts: readonly RawHttpContractIdentity[]
): void {
    const procedureNames = new Set(procedureContracts.map((contract) => contract.name));
    const rawHttpNames = new Set(
        rawHttpContracts.map((contract) => contractKey(contract.method, contract.path))
    );
    for (const endpoint of reviewed.legacyEndpoints.endpoints) {
        const { target } = endpoint;
        if (target.kind === "reviewed-removal") continue;
        if (target.kind === "procedure" && target.delivery === "implemented") {
            for (const name of target.names) {
                if (!procedureNames.has(name)) {
                    throw new Error(
                        `Implemented target ${name} for ${endpoint.id} is not registered`
                    );
                }
            }
        }
        if (target.kind === "raw-http" && target.delivery === "implemented") {
            const targetKey = contractKey(target.method, target.path);
            if (!rawHttpNames.has(targetKey)) {
                throw new Error(
                    `Implemented target ${targetKey} for ${endpoint.id} is not registered`
                );
            }
        }
    }
}

/** Verifies that every implemented browser target exists in the live route registry. */
export function assertGreenfieldFrontendTargetAccounting(
    reviewed: ReviewedParityInventory,
    routePaths: readonly string[]
): void {
    const registeredPaths = new Set(routePaths);
    for (const route of reviewed.frontend.routes) {
        if (
            route.target.delivery === "implemented" &&
            !registeredPaths.has(route.target.path)
        ) {
            throw new Error(
                `Implemented browser target ${route.target.path} is not registered`
            );
        }
    }
}
