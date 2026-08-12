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
            "/settings",
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
            "phase-1": 5,
            "phase-2": 28,
            "phase-3": 39,
            "phase-4": 15,
            "phase-5": 67,
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

    test("keeps full legacy heartbeat diagnostics planned beside schema v4", async () => {
        const reviewed = await loadReviewedParityInventory();
        const heartbeat = reviewed.legacyEndpoints.endpoints.find(
            ({ id }) => id === "GET /api/cache/heartbeat"
        );

        expect(heartbeat?.purpose).toContain("legacy schema v3 payload-bearing");
        expect(heartbeat?.purpose).toContain("schema v4");
        expect(heartbeat?.purpose).toContain("without loss");
        expect(heartbeat?.target).toEqual({
            delivery: "planned",
            kind: "procedure",
            names: ["cache.getHeartbeat"],
            phase: "phase-4",
        });
    });

    test("records the identity-free health diagnostics replacement precisely", async () => {
        const reviewed = await loadReviewedParityInventory();
        const diagnostics = reviewed.legacyEndpoints.endpoints.find(
            ({ id }) => id === "GET /api/health/diagnostics"
        );

        expect(diagnostics?.purpose).toContain("exact-release-worker");
        expect(diagnostics?.purpose).toContain("identity-free");
        expect(diagnostics?.purpose).toContain("GET /api/metrics");
        expect(diagnostics?.target).toEqual({
            delivery: "implemented",
            kind: "procedure",
            names: ["system.healthDiagnostics"],
            phase: "phase-1",
        });
    });

    test("keeps the wider legacy metrics capability planned explicitly", async () => {
        const reviewed = await loadReviewedParityInventory();
        const metrics = reviewed.legacyEndpoints.endpoints.find(
            ({ id }) => id === "GET /api/metrics"
        );

        expect(metrics?.purpose).toContain("application observability");
        expect(metrics?.purpose).toContain("HTTP counters");
        expect(metrics?.purpose).toContain("polling-snapshot");
        expect(metrics?.purpose).toContain("token projections");
        expect(metrics?.purpose).toContain("health diagnostics");
        expect(metrics?.target).toEqual({
            delivery: "planned",
            kind: "procedure",
            names: ["system.metrics"],
            phase: "phase-3",
        });
    });

    test("records the unused host-home Dashboard settings endpoints as reviewed removals", async () => {
        const reviewed = await loadReviewedParityInventory();
        const settingsEndpoints = reviewed.legacyEndpoints.endpoints.filter(
            ({ id }) => id === "GET /api/settings" || id === "PUT /api/settings"
        );

        expect(settingsEndpoints.map(({ id }) => id)).toEqual([
            "GET /api/settings",
            "PUT /api/settings",
        ]);
        expect(settingsEndpoints.map(({ target }) => target)).toEqual([
            {
                consumerEvidence: "no-current-consumers",
                kind: "reviewed-removal",
                reason: expect.stringContaining("host-home preference read"),
            },
            {
                consumerEvidence: "no-current-consumers",
                kind: "reviewed-removal",
                reason: expect.stringContaining("host-home preference write"),
            },
        ]);
    });

    test("records the purpose-built Service Actions and interactive PTY exec replacement", async () => {
        const reviewed = await loadReviewedParityInventory();
        const endpoints = reviewed.legacyEndpoints.endpoints.filter(
            ({ section }) => section === "Exec And Terminal"
        );

        expect(
            endpoints.map(({ id, target }) => {
                const identity =
                    target.kind === "procedure"
                        ? target.names
                        : target.kind === "raw-http"
                          ? `${target.method} ${target.path}`
                          : target.consumerEvidence;
                return [
                    id,
                    target.kind === "reviewed-removal"
                        ? target.kind
                        : target.delivery,
                    identity,
                ];
            })
        ).toEqual([
            [
                "GET /api/exec/:jobId",
                "implemented",
                [
                    "jobs.getRun",
                    "serviceActions.getStatus",
                    "terminal.getActiveSession",
                ],
            ],
            ["POST /api/exec", "reviewed-removal", "no-current-consumers"],
            [
                "POST /api/exec/:jobId/stop",
                "implemented",
                ["terminal.terminateSession"],
            ],
            [
                "POST /api/exec/start",
                "implemented",
                ["serviceActions.request", "terminal.prepareSession"],
            ],
            [
                "POST /api/terminal/cd",
                "implemented",
                "GET /api/terminal/sessions/:sessionId/socket",
            ],
            [
                "POST /api/terminal/complete",
                "implemented",
                "GET /api/terminal/sessions/:sessionId/socket",
            ],
        ]);
        expect(endpoints[1]?.target).toMatchObject({
            consumerEvidence: "no-current-consumers",
            kind: "reviewed-removal",
            reason: expect.stringContaining("synchronous generic command endpoint"),
        });
    });

    test("records the bounded OpenClaw settings and operations slice", async () => {
        const reviewed = await loadReviewedParityInventory();
        const settingsRoute = reviewed.frontend.routes.find(
            ({ path }) => path === "/settings"
        );
        const endpoints = reviewed.legacyEndpoints.endpoints.filter(({ id }) =>
            [
                "GET /api/config",
                "GET /api/skills",
                "POST /api/backup",
                "POST /api/restart",
                "POST /api/skills/:name",
                "PUT /api/config",
            ].includes(id)
        );

        expect(settingsRoute).toMatchObject({
            access: "session",
            searchNormalizer: "normalizeSettingsSearch",
            target: { delivery: "implemented", path: "/settings", phase: "phase-5" },
        });
        expect(
            endpoints.map(({ id, target }) => [
                id,
                target.kind === "reviewed-removal" ? target.kind : target.delivery,
                target.kind === "procedure" ? target.names : undefined,
            ])
        ).toEqual([
            ["GET /api/config", "implemented", ["openClawSettings.getConfiguration"]],
            ["GET /api/skills", "implemented", ["openClawSettings.listSkills"]],
            [
                "POST /api/backup",
                "implemented",
                ["openClawSettings.createConfigurationBackup"],
            ],
            ["POST /api/restart", "implemented", ["openClawSettings.restartGateway"]],
            [
                "POST /api/skills/:name",
                "implemented",
                ["openClawSettings.setSkillEnabled"],
            ],
            ["PUT /api/config", "implemented", ["openClawSettings.updateConfiguration"]],
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
                "implemented",
                "procedure",
                ["files.list", "files.listRoots"],
            ],
            [
                "GET /api/config-files/*",
                "implemented",
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
            delivery: "implemented",
            kind: "raw-http",
            method: "GET",
            path: "/api/chat/media/:attachmentId",
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
