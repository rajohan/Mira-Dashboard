import { describe, expect, test } from "bun:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
    procedureContracts,
    rawHttpContracts,
} from "../../src/contracts/contractRegistry.ts";
import { loadLegacyBackendRouteIdentities } from "./legacyBackendRouteInventory.ts";
import {
    buildGreenfieldContractFixtureCandidate,
    buildParityFixtureCandidate,
} from "./parityFixtureCandidate.ts";
import { parseFrontendParityFixture } from "./parityInventorySchemas.ts";
import {
    assertGreenfieldRegistryMatchesReviewed,
    assertGreenfieldTargetAccounting,
    assertSourcesMatchReviewedParity,
    loadReviewedParityInventory,
} from "./reviewedParityInventory.ts";
import {
    loadSourceParityInventory,
    type SourceParityInventory,
} from "./sourceParityInventory.ts";

const repositoryRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../.."
);

function countByPhase(
    values: readonly { target: { kind?: string; phase?: string } }[]
): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const value of values) {
        if (value.target.kind === "reviewed-removal" || !value.target.phase) continue;
        counts[value.target.phase] = (counts[value.target.phase] ?? 0) + 1;
    }
    return counts;
}

describe("reviewed frontend parity inventory", () => {
    test("matches current route, navigation, lazy-module, and search sources exactly", async () => {
        const [reviewed, observed] = await Promise.all([
            loadReviewedParityInventory(),
            loadSourceParityInventory(repositoryRoot),
        ]);

        expect(() => assertSourcesMatchReviewedParity(observed, reviewed)).not.toThrow();
        expect(reviewed.frontend.routes).toHaveLength(16);
        expect(
            reviewed.frontend.routes.filter((route) => route.navigationPosition !== null)
        ).toHaveLength(15);
        expect(
            reviewed.frontend.routes
                .filter((route) => route.navigationPosition !== null)
                .toSorted(
                    (left, right) => left.navigationPosition! - right.navigationPosition!
                )
                .map((route) => route.navigationPosition)
        ).toEqual(Array.from({ length: 15 }, (_, index) => index));
        expect(
            reviewed.frontend.routes.every((route) => route.target.delivery === "planned")
        ).toBeTrue();
        expect(countByPhase(reviewed.frontend.routes)).toEqual({
            "phase-2": 1,
            "phase-3": 5,
            "phase-4": 2,
            "phase-5": 8,
        });
    });

    test("generates the same candidate while requiring explicit review for new routes", async () => {
        const [reviewed, observed] = await Promise.all([
            loadReviewedParityInventory(),
            loadSourceParityInventory(repositoryRoot),
        ]);
        expect(buildParityFixtureCandidate(observed, reviewed).frontend).toEqual(
            reviewed.frontend
        );

        const changedRoute: SourceParityInventory = structuredClone(observed);
        changedRoute.routes[0] = { ...changedRoute.routes[0]!, path: "/new-route" };
        expect(() => buildParityFixtureCandidate(changedRoute, reviewed)).toThrow(
            "Frontend route /new-route needs an explicit parity target review"
        );
    });

    test("uses strict fixture objects", async () => {
        const { frontend } = await loadReviewedParityInventory();
        expect(() =>
            parseFrontendParityFixture({ ...frontend, unreviewedField: true })
        ).toThrow();
    });
});

describe("reviewed legacy endpoint parity inventory", () => {
    test("accounts for every executable backend route and documented row exactly once", async () => {
        const [reviewed, observed, backendRoutes] = await Promise.all([
            loadReviewedParityInventory(),
            loadSourceParityInventory(repositoryRoot),
            loadLegacyBackendRouteIdentities(repositoryRoot),
        ]);

        expect(() => assertSourcesMatchReviewedParity(observed, reviewed)).not.toThrow();
        expect(
            reviewed.legacyEndpoints.endpoints.map(({ id, method, path: routePath }) => ({
                id,
                method,
                path: routePath,
            }))
        ).toEqual(backendRoutes);
        expect(backendRoutes.filter(({ method }) => method !== "WebSocket")).toHaveLength(
            156
        );
        expect(backendRoutes.filter(({ method }) => method === "WebSocket")).toEqual([
            { id: "WebSocket /ws", method: "WebSocket", path: "/ws" },
        ]);
        expect(reviewed.legacyEndpoints.endpoints).toHaveLength(157);
        expect(new Set(reviewed.legacyEndpoints.endpoints.map(({ id }) => id)).size).toBe(
            157
        );
        expect(countByPhase(reviewed.legacyEndpoints.endpoints)).toEqual({
            "phase-1": 7,
            "phase-2": 28,
            "phase-3": 45,
            "phase-4": 7,
            "phase-5": 70,
        });
        expect(
            reviewed.legacyEndpoints.endpoints.filter(
                ({ target }) =>
                    target.kind !== "reviewed-removal" &&
                    target.delivery === "implemented"
            )
        ).toHaveLength(29);
        expect(
            reviewed.legacyEndpoints.endpoints.filter(
                ({ target }) => target.kind === "reviewed-removal"
            )
        ).toHaveLength(0);
    });

    test("checks implemented mappings against the greenfield registries", async () => {
        const reviewed = await loadReviewedParityInventory();
        expect(() =>
            assertGreenfieldRegistryMatchesReviewed(
                reviewed,
                procedureContracts,
                rawHttpContracts
            )
        ).not.toThrow();
        expect(
            buildGreenfieldContractFixtureCandidate(procedureContracts, rawHttpContracts)
        ).toEqual(reviewed.greenfieldContracts);
        expect(reviewed.greenfieldContracts.procedures).toHaveLength(36);
        expect(reviewed.greenfieldContracts.rawHttp).toHaveLength(4);
        expect(() =>
            assertGreenfieldTargetAccounting(
                reviewed,
                procedureContracts,
                rawHttpContracts
            )
        ).not.toThrow();

        const missingContract = structuredClone(reviewed);
        const implementedProcedure = missingContract.legacyEndpoints.endpoints.find(
            ({ target }) =>
                target.kind === "procedure" && target.delivery === "implemented"
        );
        expect(implementedProcedure?.target.kind).toBe("procedure");
        if (implementedProcedure?.target.kind !== "procedure") {
            throw new Error("Test fixture has no implemented procedure target");
        }
        implementedProcedure.target.names = ["missing.procedure"];
        expect(() =>
            assertGreenfieldTargetAccounting(
                missingContract,
                procedureContracts,
                rawHttpContracts
            )
        ).toThrow("is not registered");
    });

    test("keeps unresolved Phase 2 browser behavior explicit instead of overclaiming", async () => {
        const reviewed = await loadReviewedParityInventory();
        expect(
            reviewed.legacyEndpoints.endpoints
                .filter(
                    ({ target }) =>
                        target.kind !== "reviewed-removal" &&
                        target.phase === "phase-2" &&
                        target.delivery === "planned"
                )
                .map(({ id }) => id)
        ).toEqual([
            "GET /api/audit-events",
            "POST /api/account/security/sessions/revoke-all",
            "POST /api/account/security/sessions/revoke-others",
        ]);
    });

    test("requires an explicit target before generating a candidate for a new endpoint", async () => {
        const [reviewed, observed] = await Promise.all([
            loadReviewedParityInventory(),
            loadSourceParityInventory(repositoryRoot),
        ]);
        expect(buildParityFixtureCandidate(observed, reviewed).legacyEndpoints).toEqual(
            reviewed.legacyEndpoints
        );

        const changedEndpoint: SourceParityInventory = structuredClone(observed);
        changedEndpoint.endpoints.push({
            id: "GET /api/unreviewed",
            method: "GET",
            path: "/api/unreviewed",
            purpose: "Unreviewed source drift.",
            section: "Unreviewed",
        });
        expect(() => buildParityFixtureCandidate(changedEndpoint, reviewed)).toThrow(
            "Legacy endpoint GET /api/unreviewed needs an explicit parity target review"
        );
    });
});
