import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, jest } from "bun:test";

import { database } from "../src/database.ts";
import * as processModule from "../src/lib/processes.ts";
import {
    type DockerUpdaterStepResult,
    isNonblockingRegistrationFailure,
    isSafeTagPatternMatch,
    isSafeTagRegexPattern,
    pollDockerUpdaterRegistries,
    registerDockerUpdaterScheduledJobs,
    registerDockerUpdaterServices,
    runDockerUpdaterService,
} from "../src/services/dockerUpdater.ts";

const cleanupCallbacks: Array<() => void> = [];

function rememberEnvironment(key: string): void {
    const originalValue = process.env[key];
    cleanupCallbacks.push(() => {
        if (originalValue === undefined) {
            delete process.env[key];
        } else {
            process.env[key] = originalValue;
        }
    });
}

function createTemporaryRoot(prefix: string): string {
    const root = mkdtempSync(path.join(tmpdir(), prefix));
    cleanupCallbacks.push(() => {
        rmSync(root, { force: true, recursive: true });
    });
    return root;
}

afterEach(() => {
    database
        .prepare(
            "DELETE FROM docker_update_events WHERE app_slug LIKE 'unit-%' OR managed_service_id NOT IN (SELECT id FROM docker_managed_services)"
        )
        .run();
    database
        .prepare("DELETE FROM docker_managed_services WHERE app_slug LIKE 'unit-%'")
        .run();
    database
        .prepare("DELETE FROM scheduled_job_runs WHERE job_id = 'docker.updater'")
        .run();
    database.prepare("DELETE FROM scheduled_jobs WHERE id = 'docker.updater'").run();
    while (cleanupCallbacks.length > 0) {
        cleanupCallbacks.pop()?.();
    }
});

function dockerUpdaterStep(
    overrides: Partial<DockerUpdaterStepResult>
): DockerUpdaterStepResult {
    return {
        step: "register-services",
        isOk: false,
        stdout: "",
        stderr: "",
        ...overrides,
    };
}

describe("Docker updater tag patterns", () => {
    it("matches the supported anchored numeric tag patterns without RegExp", () => {
        expect(isSafeTagPatternMatch(String.raw`^\d+\.\d+\.\d+$`, "1.2.3")).toBe(true);
        expect(isSafeTagPatternMatch(String.raw`^\d+\.\d+\.\d+$$`, "1.2.3")).toBe(true);
        expect(isSafeTagPatternMatch("^latest$$", "latest")).toBe(true);
        expect(
            isSafeTagPatternMatch(
                String.raw`^\d+\.\d+\-alpine\d+\.\d+$$`,
                "1.2-alpine3.20"
            )
        ).toBe(true);
        expect(isSafeTagPatternMatch(String.raw`^v\d+\.\d+\.\d+$$`, "v1.2.3")).toBe(true);
        expect(isSafeTagPatternMatch(String.raw`^[0-9]+\.[0-9]+$`, "1.2")).toBe(true);
        expect(
            isSafeTagPatternMatch(
                String.raw`^\d+\.\d+\.\d+-alpine\d+\.\d+$$`,
                "1.2.3-alpine3.20"
            )
        ).toBe(true);
        expect(isSafeTagPatternMatch(String.raw`^1\.\d+\.\d+$$`, "1.2.3")).toBe(true);
    });

    it("rejects unsupported or unsafe regex features", () => {
        expect(isSafeTagRegexPattern("^(a+)+$")).toBe(false);
        expect(isSafeTagRegexPattern("^v(1|2)$")).toBe(false);
        expect(isSafeTagRegexPattern(String.raw`\d+\.\d+`)).toBe(false);
        expect(isSafeTagRegexPattern(String.raw`^\d+[0-9]+$`)).toBe(false);
        expect(isSafeTagRegexPattern(String.raw`^[0-9]+\d+$`)).toBe(false);
        expect(isSafeTagRegexPattern(String.raw`^\d+1$`)).toBe(false);
        expect(isSafeTagRegexPattern("^[0-9]+1$")).toBe(false);
        expect(isSafeTagPatternMatch(String.raw`^\d+\.\d+\.\d+$$`, "1.2.x")).toBe(false);
        expect(isSafeTagPatternMatch(String.raw`^v\d+\.\d+\.\d+$$`, "1.2.3")).toBe(false);
        expect(isSafeTagPatternMatch(String.raw`^1\.\d+\.\d+$$`, "2.2.3")).toBe(false);
    });

    it("distinguishes blocking service registration failures from warning-only failures", () => {
        const warningOnlyFailure = dockerUpdaterStep({ stderr: "" });
        const nonblockingAppFailure = dockerUpdaterStep({
            stderr: JSON.stringify({
                failed: [{ appSlug: "comet", blocking: false }],
            }),
        });
        const blockingAppFailure = dockerUpdaterStep({
            stderr: JSON.stringify({
                failed: [{ appSlug: "postgres", blocking: true }],
            }),
        });
        const malformedRegistrationFailure = dockerUpdaterStep({
            stderr: '{"failed":',
        });
        const wrongStepFailure = dockerUpdaterStep({
            step: "poll-registries",
            stderr: "",
        });
        const successfulStep = dockerUpdaterStep({ isOk: true, stderr: "" });

        expect(isNonblockingRegistrationFailure(warningOnlyFailure)).toBe(true);
        expect(isNonblockingRegistrationFailure(nonblockingAppFailure)).toBe(true);
        expect(isNonblockingRegistrationFailure(blockingAppFailure)).toBe(false);
        expect(isNonblockingRegistrationFailure(malformedRegistrationFailure)).toBe(
            false
        );
        expect(isNonblockingRegistrationFailure(wrongStepFailure)).toBe(false);
        expect(isNonblockingRegistrationFailure(successfulStep)).toBe(false);
    });

    it("discovers managed Compose services and skips unsupported registries", async () => {
        rememberEnvironment("MIRA_DOCKER_APPS_ROOT");
        const appsRoot = createTemporaryRoot("mira-docker-updater-apps-");
        const appRoot = path.join(appsRoot, "unit-compose-app");
        mkdirSync(appRoot, { recursive: true });
        writeFileSync(
            path.join(appRoot, "compose.yaml"),
            [
                "services:",
                "  web:",
                "    image: example.com/unit/web:1.0.0",
                "    labels:",
                "      mira.updater.enabled: 'true'",
                "      mira.updater.autoUpdate: 'false'",
                "      mira.updater.track: tag",
                String.raw`      mira.updater.tagPattern: '^\d+\.\d+\.\d+$'`,
                "      mira.updater.tagPatternIsRegex: 'true'",
                "",
            ].join("\n")
        );
        process.env.MIRA_DOCKER_APPS_ROOT = appsRoot;

        const registered = await registerDockerUpdaterServices();
        expect(registered).toMatchObject({
            isOk: true,
            step: "register-services",
            stderr: "",
        });
        expect(JSON.parse(registered.stdout)).toMatchObject({
            summary: {
                composeFiles: 1,
                registeredServices: 1,
            },
        });
        const row = database
            .prepare(
                `SELECT id, app_slug, service_name, image_repo, current_tag, policy, pin_mode, tag_match_type, tag_match_pattern, enabled
                 FROM docker_managed_services
                 WHERE app_slug = 'unit-compose-app' AND service_name = 'web'`
            )
            .get() as {
            app_slug: string;
            current_tag: string;
            enabled: number;
            id: number;
            image_repo: string;
            pin_mode: string;
            policy: string;
            service_name: string;
            tag_match_pattern: string;
            tag_match_type: string;
        };
        expect(row).toMatchObject({
            app_slug: "unit-compose-app",
            current_tag: "1.0.0",
            enabled: 1,
            image_repo: "example.com/unit/web",
            pin_mode: "tag",
            policy: "notify",
            service_name: "web",
            tag_match_pattern: String.raw`^\d+\.\d+\.\d+$`,
            tag_match_type: "regex",
        });

        const polled = await pollDockerUpdaterRegistries(row.id);
        expect(polled).toMatchObject({ isOk: true, step: "poll", stderr: "" });
        expect(JSON.parse(polled.stdout)).toMatchObject({
            skipped: [
                {
                    reason: "Unsupported image registry: example.com",
                    service: "unit-compose-app/web",
                },
            ],
        });
        expect(
            database
                .prepare("SELECT last_status FROM docker_managed_services WHERE id = ?")
                .get(row.id)
        ).toEqual({ last_status: "unsupported_registry" });

        const steps = await runDockerUpdaterService(row.id);
        expect(steps).toContainEqual(
            expect.objectContaining({
                code: "UNSUPPORTED_REGISTRY",
                isOk: false,
                step: "manual-update:unit-compose-app/web",
            })
        );

        registerDockerUpdaterScheduledJobs();
        expect(
            database
                .prepare(
                    "SELECT enabled, time_of_day FROM scheduled_jobs WHERE id = 'docker.updater'"
                )
                .get()
        ).toEqual({ enabled: 1, time_of_day: "04:10" });
    });

    it("blocks global updater runs when service discovery cannot read the apps root", async () => {
        rememberEnvironment("MIRA_DOCKER_APPS_ROOT");
        const missingAppsRoot = path.join(
            createTemporaryRoot("mira-docker-updater-missing-root-"),
            "missing"
        );
        process.env.MIRA_DOCKER_APPS_ROOT = missingAppsRoot;
        const runProcessSpy = jest
            .spyOn(processModule, "runProcess")
            .mockResolvedValue({ code: 0, stderr: "", stdout: "" });
        cleanupCallbacks.push(() => runProcessSpy.mockRestore());

        const registered = await registerDockerUpdaterServices();
        expect(registered).toMatchObject({
            isOk: false,
            step: "register-services",
            stdout: "",
        });
        expect(JSON.parse(registered.stderr)).toMatchObject({
            failed: [
                {
                    appSlug: "*",
                    error: expect.stringContaining("Compose apps root not found"),
                },
            ],
            registered: 0,
        });

        await expect(runDockerUpdaterService()).resolves.toEqual([registered]);
        expect(runProcessSpy).not.toHaveBeenCalled();
    });

    it("applies a manual update to an isolated Compose file without invoking real Docker", async () => {
        rememberEnvironment("MIRA_DOCKER_APPS_ROOT");
        rememberEnvironment("MIRA_DOCKER_COMPOSE_WRAPPER");
        rememberEnvironment("MIRA_DOCKER_UPDATER_PLATFORM");
        const appsRoot = createTemporaryRoot("mira-docker-updater-apply-");
        const appRoot = path.join(appsRoot, "unit-apply-app");
        const composePath = path.join(appRoot, "compose.yaml");
        mkdirSync(appRoot, { recursive: true });
        writeFileSync(
            composePath,
            [
                "services:",
                "  web:",
                "    image: ghcr.io/unit/web:1.0.0",
                "    labels:",
                "      mira.updater.enabled: 'true'",
                "      mira.updater.autoUpdate: 'false'",
                "      mira.updater.track: tag",
                String.raw`      mira.updater.tagPattern: '^\d+\.\d+\.\d+$'`,
                "      mira.updater.tagPatternIsRegex: 'true'",
                "",
            ].join("\n")
        );
        process.env.MIRA_DOCKER_APPS_ROOT = appsRoot;
        process.env.MIRA_DOCKER_COMPOSE_WRAPPER = path.join(appsRoot, "compose-wrapper");
        process.env.MIRA_DOCKER_UPDATER_PLATFORM = "linux/amd64";
        const fetchSpy = jest.spyOn(globalThis, "fetch").mockImplementation((async (
            input: Request | string | URL
        ) => {
            const url = String(input);
            if (url.endsWith("/v2/unit/web/tags/list?n=1000")) {
                return Response.json({ tags: ["1.0.0", "1.0.1"] });
            }
            if (url.endsWith("/v2/unit/web/manifests/1.0.1")) {
                return Response.json({
                    manifests: [
                        {
                            digest: "sha256:newdigest",
                            platform: { architecture: "amd64", os: "linux" },
                        },
                    ],
                });
            }
            return new Response("not found", { status: 404 });
        }) as typeof fetch);
        cleanupCallbacks.push(() => fetchSpy.mockRestore());
        const runProcessSpy = jest
            .spyOn(processModule, "runProcess")
            .mockResolvedValue({ code: 0, stderr: "", stdout: "compose ok" });
        cleanupCallbacks.push(() => runProcessSpy.mockRestore());

        const registered = await registerDockerUpdaterServices();
        expect(registered.isOk).toBe(true);
        const service = database
            .prepare(
                `SELECT id
                 FROM docker_managed_services
                 WHERE app_slug = 'unit-apply-app' AND service_name = 'web'`
            )
            .get() as { id: number };

        const steps = await runDockerUpdaterService(service.id);
        expect(steps).toContainEqual(
            expect.objectContaining({
                isOk: true,
                step: "manual-update:unit-apply-app/web",
                stdout: "compose ok",
            })
        );
        expect(readFileSync(composePath, "utf8")).toContain(
            "image: ghcr.io/unit/web:1.0.1"
        );
        expect(
            database
                .prepare(
                    "SELECT current_tag, current_digest, last_status FROM docker_managed_services WHERE id = ?"
                )
                .get(service.id)
        ).toEqual({
            current_digest: "sha256:newdigest",
            current_tag: "1.0.1",
            last_status: "updated",
        });
        expect(
            database
                .prepare(
                    "SELECT event_type FROM docker_update_events WHERE managed_service_id = ? ORDER BY id"
                )
                .all(service.id)
        ).toEqual([
            { event_type: "update_available" },
            { event_type: "manual_update_succeeded" },
        ]);
        expect(runProcessSpy).toHaveBeenCalledWith(
            process.env.MIRA_DOCKER_COMPOSE_WRAPPER,
            expect.arrayContaining(["up", "-d", "--pull", "always", "web"]),
            expect.objectContaining({ cwd: appRoot })
        );
        expect(runProcessSpy).toHaveBeenCalledWith(
            "docker",
            ["image", "prune", "-f"],
            expect.objectContaining({ timeoutMs: 120_000 })
        );
    });

    it("reports manual update guard states without touching Docker", async () => {
        rememberEnvironment("MIRA_DOCKER_APPS_ROOT");
        rememberEnvironment("MIRA_DOCKER_UPDATER_SKIP_REGISTRY");
        const appsRoot = createTemporaryRoot("mira-docker-updater-guards-");
        const appRoot = path.join(appsRoot, "unit-guard-app");
        mkdirSync(appRoot, { recursive: true });
        writeFileSync(
            path.join(appRoot, "compose.yaml"),
            [
                "services:",
                "  web:",
                "    image: ghcr.io/unit/web:1.0.0",
                "    labels:",
                "      mira.updater.enabled: 'true'",
                "  worker:",
                "    image: ghcr.io/unit/worker:1.0.0",
                "    labels:",
                "      mira.updater.enabled: 'false'",
                "",
            ].join("\n")
        );
        process.env.MIRA_DOCKER_APPS_ROOT = appsRoot;
        process.env.MIRA_DOCKER_UPDATER_SKIP_REGISTRY = "1";
        const runProcessSpy = jest
            .spyOn(processModule, "runProcess")
            .mockResolvedValue({ code: 0, stderr: "", stdout: "" });
        cleanupCallbacks.push(() => runProcessSpy.mockRestore());

        const registered = await registerDockerUpdaterServices();
        expect(registered.isOk).toBe(true);
        const rows = database
            .prepare(
                `SELECT id, service_name, enabled
                 FROM docker_managed_services
                 WHERE app_slug = 'unit-guard-app'
                 ORDER BY service_name`
            )
            .all() as Array<{ enabled: number; id: number; service_name: string }>;
        expect(rows.map((row) => row.service_name)).toEqual(["web", "worker"]);

        await expect(runDockerUpdaterService(99_999_999)).resolves.toContainEqual(
            expect.objectContaining({
                code: "NOT_FOUND",
                isOk: false,
                step: "manual-update",
            })
        );

        await expect(
            runDockerUpdaterService(rows.find((row) => row.service_name === "worker")?.id)
        ).resolves.toContainEqual(
            expect.objectContaining({
                code: "DISABLED",
                isOk: false,
                step: "manual-update:unit-guard-app/worker",
            })
        );

        await expect(
            runDockerUpdaterService(rows.find((row) => row.service_name === "web")?.id)
        ).resolves.toContainEqual(
            expect.objectContaining({
                code: "CONFLICT",
                isOk: false,
                step: "manual-update-skipped:unit-guard-app/web",
                stdout: "No update available after registry poll",
            })
        );
        expect(runProcessSpy).not.toHaveBeenCalled();
    });
});
