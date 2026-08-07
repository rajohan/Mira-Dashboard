import { describe, expect, test } from "bun:test";

import { dashboardRoutePaths } from "../../browser/lib/dashboardRoutes.ts";
import {
    procedureContracts,
    rawHttpContracts,
} from "../../contracts/contractRegistry.ts";
import { buildGreenfieldContractFixtureCandidate } from "./parityFixtureCandidate.ts";
import {
    parseFrontendParityFixture,
    reviewedLegacyEndpointRowCount,
    type FrontendRouteInventory,
    type LegacyEndpointInventory,
} from "./parityInventorySchemas.ts";
import {
    assertGreenfieldRegistryMatchesReviewed,
    assertGreenfieldFrontendTargetAccounting,
    assertGreenfieldTargetAccounting,
    loadReviewedParityInventory,
} from "./reviewedParityInventory.ts";

function countByPhase(
    values: readonly (
        | Pick<FrontendRouteInventory, "target">
        | Pick<LegacyEndpointInventory, "target">
    )[]
): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const value of values) {
        if ("kind" in value.target && value.target.kind === "reviewed-removal") continue;
        counts[value.target.phase] = (counts[value.target.phase] ?? 0) + 1;
    }
    return counts;
}

describe("reviewed pre-cutover parity inventory", () => {
    test("keeps the reviewed browser-route inventory complete", async () => {
        const { frontend } = await loadReviewedParityInventory();

        expect(frontend.routes).toHaveLength(16);
        expect(
            frontend.routes.filter((route) => route.navigationPosition !== null)
        ).toHaveLength(15);
        expect(
            frontend.routes
                .filter((route) => route.navigationPosition !== null)
                .toSorted(
                    (left, right) => left.navigationPosition! - right.navigationPosition!
                )
                .map((route) => route.navigationPosition)
        ).toEqual(Array.from({ length: 15 }, (_, index) => index));
        expect(
            frontend.routes
                .filter((route) => route.target.delivery === "implemented")
                .map(({ path }) => path)
        ).toEqual(["/agents", "/login", "/reports", "/tasks"]);
        expect(countByPhase(frontend.routes)).toEqual({
            "phase-2": 1,
            "phase-3": 5,
            "phase-4": 2,
            "phase-5": 8,
        });
    });

    test("validates strict reviewed fixture objects without reading the old app", async () => {
        const { frontend, legacyEndpoints } = await loadReviewedParityInventory();

        expect(() =>
            parseFrontendParityFixture({ ...frontend, unreviewedField: true })
        ).toThrow();
        expect(legacyEndpoints.endpoints).toHaveLength(reviewedLegacyEndpointRowCount);
        expect(new Set(legacyEndpoints.endpoints.map(({ id }) => id)).size).toBe(
            reviewedLegacyEndpointRowCount
        );
        expect(countByPhase(legacyEndpoints.endpoints)).toEqual({
            "phase-1": 7,
            "phase-2": 28,
            "phase-3": 45,
            "phase-4": 7,
            "phase-5": 70,
        });
    });

    test("checks implemented mappings against only the greenfield registries", async () => {
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
        expect(() =>
            assertGreenfieldTargetAccounting(
                reviewed,
                procedureContracts,
                rawHttpContracts
            )
        ).not.toThrow();
        expect(() =>
            assertGreenfieldFrontendTargetAccounting(reviewed, dashboardRoutePaths)
        ).not.toThrow();

        const missingContract = structuredClone(reviewed);
        const implementedProcedure = missingContract.legacyEndpoints.endpoints.find(
            ({ target }) =>
                target.kind === "procedure" && target.delivery === "implemented"
        );
        if (implementedProcedure?.target.kind !== "procedure") {
            throw new Error("Reviewed fixture has no implemented procedure target");
        }
        implementedProcedure.target.names = ["missing.procedure"];
        expect(() =>
            assertGreenfieldTargetAccounting(
                missingContract,
                procedureContracts,
                rawHttpContracts
            )
        ).toThrow("is not registered");

        const missingRoute = structuredClone(reviewed);
        const implementedRoute = missingRoute.frontend.routes.find(
            ({ target }) => target.delivery === "implemented"
        );
        if (implementedRoute === undefined) {
            throw new Error("Reviewed fixture has no implemented browser target");
        }
        implementedRoute.target.path = "/missing";
        expect(() =>
            assertGreenfieldFrontendTargetAccounting(missingRoute, dashboardRoutePaths)
        ).toThrow("is not registered");
    });

    test("keeps the Phase 2 server endpoint inventory closed", async () => {
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
        ).toEqual([]);
    });
});
