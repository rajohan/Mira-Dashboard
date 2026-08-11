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
        ).toEqual([
            "/agents",
            "/chat",
            "/files",
            "/jobs",
            "/login",
            "/logs",
            "/moltbook",
            "/reports",
            "/sessions",
            "/tasks",
            "/terminal",
        ]);
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
            "phase-3": 39,
            "phase-4": 15,
            "phase-5": 68,
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

    test("keeps the reviewed Sessions and Chat slice closed", async () => {
        const reviewed = await loadReviewedParityInventory();
        const sessionsAndChatEndpoints = reviewed.legacyEndpoints.endpoints.filter(
            ({ section }) => section === "Sessions And Chat"
        );

        expect(
            sessionsAndChatEndpoints.map(({ id, target }) => [
                id,
                target.kind === "reviewed-removal" ? target.kind : target.delivery,
                target.kind === "procedure" ? target.names : undefined,
            ])
        ).toEqual([
            ["DELETE /api/sessions/:id", "implemented", ["gatewaySessions.delete"]],
            ["GET /api/sessions/list", "implemented", ["gatewaySessions.list"]],
            ["GET /api/sessions/stats", "implemented", ["gatewaySessions.list"]],
            [
                "POST /api/sessions/:id/action",
                "implemented",
                ["gatewaySessions.compact", "gatewaySessions.reset"],
            ],
            ["WebSocket /ws", "implemented", ["events.stream"]],
        ]);
    });

    test("keeps the reviewed Phase 5 Logs slice closed", async () => {
        const reviewed = await loadReviewedParityInventory();
        const logsRoute = reviewed.frontend.routes.find(({ path }) => path === "/logs");
        const logMaintenanceEndpoints = reviewed.legacyEndpoints.endpoints.filter(
            ({ id }) =>
                id === "GET /api/ops/log-rotation/status" ||
                id === "POST /api/ops/log-rotation/dry-run" ||
                id === "POST /api/ops/log-rotation/run"
        );

        expect(logsRoute?.target.delivery).toBe("implemented");
        expect(logMaintenanceEndpoints.map(({ id }) => id)).toEqual([
            "GET /api/ops/log-rotation/status",
            "POST /api/ops/log-rotation/dry-run",
            "POST /api/ops/log-rotation/run",
        ]);
        expect(
            logMaintenanceEndpoints.map(({ target }) =>
                target.kind === "reviewed-removal" ? target.kind : target.delivery
            )
        ).toEqual(["implemented", "implemented", "implemented"]);
    });

    test("records the reviewed Phase 5 Files boundary accurately", async () => {
        const reviewed = await loadReviewedParityInventory();
        const filesRoute = reviewed.frontend.routes.find(({ path }) => path === "/files");
        const fileEndpoints = reviewed.legacyEndpoints.endpoints.filter(
            ({ id }) =>
                id === "GET /api/config-files" ||
                id === "GET /api/config-files/*" ||
                id === "GET /api/files" ||
                id === "GET /api/files/*" ||
                id === "PUT /api/config-files/*" ||
                id === "PUT /api/files/*"
        );
        const mediaEndpoint = reviewed.legacyEndpoints.endpoints.find(
            ({ id }) => id === "GET /api/media"
        );

        expect(filesRoute?.target.delivery).toBe("implemented");
        expect(
            fileEndpoints.map(({ id, target }) => {
                let targetIdentity: readonly string[] | string | undefined;
                if (target.kind === "procedure") {
                    targetIdentity = target.names;
                } else if (target.kind === "raw-http") {
                    targetIdentity = `${target.method} ${target.path}`;
                }
                return [
                    id,
                    target.kind === "reviewed-removal" ? target.kind : target.delivery,
                    target.kind,
                    targetIdentity,
                ];
            })
        ).toEqual([
            [
                "GET /api/config-files",
                "planned",
                "procedure",
                ["files.list", "files.listRoots"],
            ],
            [
                "GET /api/config-files/*",
                "planned",
                "raw-http",
                "GET /api/files/content/:ticketId",
            ],
            [
                "GET /api/files",
                "implemented",
                "procedure",
                ["files.list", "files.listRoots"],
            ],
            [
                "GET /api/files/*",
                "implemented",
                "raw-http",
                "GET /api/files/content/:ticketId",
            ],
            [
                "PUT /api/config-files/*",
                "implemented",
                "raw-http",
                "PUT /api/files/uploads/:ticketId",
            ],
            [
                "PUT /api/files/*",
                "implemented",
                "raw-http",
                "PUT /api/files/uploads/:ticketId",
            ],
        ]);
        expect(mediaEndpoint?.target).toEqual({
            delivery: "planned",
            kind: "raw-http",
            method: "GET",
            path: "/api/media/*",
            phase: "phase-5",
        });
    });

    test("keeps the reviewed Phase 5 Moltbook slice closed", async () => {
        const reviewed = await loadReviewedParityInventory();
        const moltbookRoute = reviewed.frontend.routes.find(
            ({ path }) => path === "/moltbook"
        );
        const endpoints = reviewed.legacyEndpoints.endpoints.filter(({ id }) =>
            [
                "GET /api/moltbook/feed",
                "GET /api/moltbook/home",
                "GET /api/moltbook/my-posts",
                "GET /api/moltbook/profile",
            ].includes(id)
        );

        expect(moltbookRoute?.target.delivery).toBe("implemented");
        expect(
            endpoints.map(({ id, target }) => [
                id,
                target.kind === "reviewed-removal" ? target.kind : target.delivery,
                target.kind === "procedure" ? target.names : undefined,
            ])
        ).toEqual([
            ["GET /api/moltbook/feed", "implemented", ["moltbook.feed"]],
            ["GET /api/moltbook/home", "implemented", ["moltbook.home"]],
            ["GET /api/moltbook/my-posts", "implemented", ["moltbook.listMyPosts"]],
            ["GET /api/moltbook/profile", "implemented", ["moltbook.profile"]],
        ]);
    });

    test("keeps the reviewed jobs and cron slice closed", async () => {
        const reviewed = await loadReviewedParityInventory();
        const jobsRoute = reviewed.frontend.routes.find(({ path }) => path === "/jobs");
        const jobsAndCronEndpoints = reviewed.legacyEndpoints.endpoints.filter(
            ({ section }) => section === "Jobs And Cron"
        );

        expect(jobsRoute?.target.delivery).toBe("implemented");
        expect(
            jobsAndCronEndpoints.map(({ id, target }) => [
                id,
                target.kind === "reviewed-removal" ? target.kind : target.delivery,
                target.kind === "procedure" ? target.names : undefined,
            ])
        ).toEqual([
            ["GET /api/cron/jobs", "implemented", ["openClawCron.list"]],
            ["GET /api/job-executions", "implemented", ["jobs.listRuns"]],
            ["GET /api/job-executions/:id", "implemented", ["jobs.getRun"]],
            ["GET /api/jobs", "implemented", ["schedules.list"]],
            ["GET /api/jobs/:id", "implemented", ["schedules.get"]],
            ["GET /api/jobs/:id/runs", "implemented", ["schedules.listRuns"]],
            [
                "PATCH /api/job-executions/claims",
                "implemented",
                ["jobs.setClaimingPaused"],
            ],
            ["PATCH /api/jobs/:id", "implemented", ["schedules.update"]],
            ["POST /api/cron/jobs/:id/delete", "implemented", ["openClawCron.delete"]],
            ["POST /api/cron/jobs/:id/run", "implemented", ["openClawCron.run"]],
            [
                "POST /api/cron/jobs/:id/toggle",
                "implemented",
                ["openClawCron.setEnabled"],
            ],
            ["POST /api/cron/jobs/:id/update", "implemented", ["openClawCron.update"]],
            ["POST /api/job-executions/:id/cancel", "implemented", ["jobs.cancelRun"]],
            ["POST /api/jobs/:id/run", "implemented", ["schedules.run"]],
        ]);
    });
});
