import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
    parseFrontendParityFixture,
    parseGreenfieldContractParityFixture,
    parseLegacyEndpointParityFixture,
    type FrontendParityFixture,
    type GreenfieldContractParityFixture,
    type LegacyEndpointParityFixture,
} from "./parityInventorySchemas.ts";
import type { SourceParityInventory } from "./sourceParityInventory.ts";

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

interface ProcedureContractIdentity {
    kind: "mutation" | "query" | "subscription";
    name: string;
}

interface RawHttpContractIdentity {
    method: string;
    path: string;
}

function canonicalJson(value: unknown): string {
    return `${JSON.stringify(value, undefined, 2)}\n`;
}

function compareStrings(left: string, right: string): number {
    if (left < right) return -1;
    if (left > right) return 1;
    return 0;
}

async function loadJsonFixture(fileName: string): Promise<unknown> {
    const fixturePath = path.join(fixtureDirectory, fileName);
    const fixtureStat = await stat(fixturePath);
    if (
        !fixtureStat.isFile() ||
        fixtureStat.size <= 0 ||
        fixtureStat.size > maximumFixtureBytes
    ) {
        throw new Error(`Parity fixture ${fileName} has an invalid size`);
    }
    const serialized = await readFile(fixturePath, "utf8");
    try {
        return JSON.parse(serialized) as unknown;
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

function reviewedSourceProjection(
    reviewed: ReviewedParityInventory
): SourceParityInventory {
    return {
        endpoints: reviewed.legacyEndpoints.endpoints.map(
            ({ id, method, path: endpointPath, purpose, section }) => ({
                id,
                method,
                path: endpointPath,
                purpose,
                section,
            })
        ),
        routes: reviewed.frontend.routes.map(
            ({
                access,
                moduleKey,
                navigationLabel,
                navigationPosition,
                pageModule,
                path: routePath,
                searchNormalizer,
                sourceRouteName,
            }) => ({
                access,
                moduleKey,
                navigationLabel,
                navigationPosition,
                pageModule,
                path: routePath,
                searchNormalizer,
                sourceRouteName,
            })
        ),
    };
}

/** Fails when current route, navigation, module, or endpoint sources drift from review. */
export function assertSourcesMatchReviewedParity(
    observed: SourceParityInventory,
    reviewed: ReviewedParityInventory
): void {
    if (canonicalJson(observed) !== canonicalJson(reviewedSourceProjection(reviewed))) {
        throw new Error(
            "Current-production parity sources differ from reviewed fixtures"
        );
    }
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
    const observed = {
        procedures: procedureContracts
            .map(({ kind, name }) => ({ kind, name }))
            .toSorted((left, right) => compareStrings(left.name, right.name)),
        rawHttp: rawHttpContracts
            .map(({ method, path: routePath }) => ({
                id: contractKey(method, routePath),
                method,
                path: routePath,
            }))
            .toSorted((left, right) => compareStrings(left.id, right.id)),
    };
    const expected = {
        procedures: reviewed.greenfieldContracts.procedures,
        rawHttp: reviewed.greenfieldContracts.rawHttp,
    };
    if (canonicalJson(observed) !== canonicalJson(expected)) {
        throw new Error("Greenfield contract registry differs from reviewed fixtures");
    }
}

/**
 * Verifies that implemented targets exist and that later-phase work is never marked implemented.
 */
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
        if (
            target.delivery === "implemented" &&
            (target.phase === "phase-3" ||
                target.phase === "phase-4" ||
                target.phase === "phase-5" ||
                target.phase === "phase-6")
        ) {
            throw new Error(
                `Later-phase target for ${endpoint.id} cannot be marked implemented`
            );
        }
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
