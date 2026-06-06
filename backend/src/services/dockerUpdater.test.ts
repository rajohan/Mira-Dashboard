import assert from "node:assert/strict";
import fs from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it, mock } from "node:test";

import { db } from "../db.js";
import { withEnv } from "../testUtils/env.js";

const originalFetch = globalThis.fetch;
type StepResult = { step: string; ok: boolean; stdout: string; stderr: string };

async function writeExecutable(filePath: string, script: string) {
    await writeFile(filePath, script, "utf8");
    await chmod(filePath, 0o755);
}

function serviceRows() {
    return db
        .prepare("SELECT * FROM docker_managed_services ORDER BY app_slug, service_name")
        .all() as Array<{
        id: number;
        app_slug: string;
        service_name: string;
        image_repo: string;
        current_tag: string | null;
        current_digest: string | null;
        latest_tag: string | null;
        latest_digest: string | null;
        policy: string;
        pin_mode: string;
        tag_match_type: string;
        tag_match_pattern: string | null;
        enabled: number;
        last_status: string | null;
    }>;
}

describe("docker updater service", { concurrency: false }, () => {
    let tempDir: string;
    let originalPath: string | undefined;

    beforeEach(async () => {
        tempDir = await mkdtemp(path.join(os.tmpdir(), "mira-docker-updater-"));
        originalPath = process.env.PATH;
        db.exec(
            "DELETE FROM docker_update_events; DELETE FROM docker_managed_services; DELETE FROM notifications;"
        );
    });

    afterEach(async () => {
        mock.restoreAll();
        globalThis.fetch = originalFetch;
        process.env.PATH = originalPath;
        db.exec(
            "DELETE FROM docker_update_events; DELETE FROM docker_managed_services; DELETE FROM notifications;"
        );
        await rm(tempDir, { recursive: true, force: true });
    });

    it("discovers compose services, polls registries, and applies auto updates", async () => {
        const appsRoot = path.join(tempDir, "apps");
        const appDir = path.join(appsRoot, "demo");
        const binDir = path.join(tempDir, "bin");
        await mkdir(appDir, { recursive: true });
        await mkdir(binDir);
        const composePath = path.join(appDir, "compose.yaml");
        await writeFile(
            composePath,
            String.raw`services:
  web:
    image: nginx:1.2.0
    labels:
      mira.updater.enabled: "true"
      mira.updater.autoUpdate: "true"
      mira.updater.tagPattern: "^1\\.2\\.[0-9]+$"
    container_name: demo-web
  worker:
    image: ghcr.io/owner/app:stable@sha256:old
    labels:
      - mira.updater.track=digest
      - mira.updater.autoUpdate=false
  disabled:
    image: redis:7
    labels:
      - mira.updater.enabled=false
  noimage:
    labels:
      anything=true
`,
            "utf8"
        );
        await writeExecutable(
            path.join(binDir, "docker"),
            String.raw`#!/usr/bin/env node
const fs = require("node:fs");
fs.appendFileSync(process.env.MIRA_DOCKER_CALLS, process.argv.slice(2).join(" ") + "\n");
process.stdout.write("updated\n");
`
        );
        process.env.PATH = `${binDir}${path.delimiter}${originalPath || ""}`;
        const dockerCalls = path.join(tempDir, "docker-calls.log");
        await writeFile(dockerCalls, "", "utf8");

        const fetchUrls: string[] = [];
        globalThis.fetch = (async (input: string | URL | Request) => {
            const url = typeof input === "string" ? input : input.toString();
            fetchUrls.push(url);
            if (url.includes("hub.docker.com") && url.includes("/tags/1.2.1")) {
                return {
                    ok: true,
                    headers: new Headers(),
                    json: async () => ({
                        images: [
                            { architecture: "amd64", digest: "sha256:amd" },
                            {
                                architecture: "arm64",
                                variant: null,
                                digest: "sha256:new",
                            },
                        ],
                    }),
                } as Response;
            }
            if (url.includes("hub.docker.com")) {
                return {
                    ok: true,
                    headers: new Headers(),
                    json: async () => ({
                        results: [
                            { name: "1.1.9" },
                            { name: "1.2.0" },
                            { name: "1.2.1" },
                            { name: "2.0.0" },
                        ],
                    }),
                } as Response;
            }
            return {
                ok: true,
                headers: new Headers({ "docker-content-digest": "sha256:ghcr-new" }),
                json: async () => ({}),
            } as Response;
        }) as typeof fetch;

        await withEnv(
            {
                MIRA_DOCKER_APPS_ROOT: appsRoot,
                MIRA_DOCKER_CALLS: dockerCalls,
            },
            async () => {
                const { runDockerUpdaterService } = await import(
                    `./dockerUpdater.js?auto=${Date.now()}`
                );
                db.prepare(
                    `INSERT INTO docker_managed_services (
                        app_slug, service_name, compose_path, image_repo,
                        compose_image_ref, compose_image_field, current_tag,
                        current_digest, policy, pin_mode, tag_match_type,
                        tag_match_pattern, enabled, metadata_json
                    ) VALUES (
                        'demo', 'removed', ?, 'busybox', 'busybox:1',
                        'services.removed.image', '1', NULL, 'notify', 'tag',
                        'exact', '1', 1, '{}'
                    )`
                ).run(composePath);
                const steps = (await runDockerUpdaterService()) as StepResult[];
                assert.equal(
                    steps.every((step) => step.ok),
                    true
                );
                assert.deepEqual(
                    steps.map((step) => step.step),
                    ["register", "poll", "auto-update:demo/web"]
                );
            }
        );

        const rows = serviceRows();
        assert.deepEqual(
            rows.map((row) => [row.service_name, row.enabled, row.pin_mode]),
            [
                ["disabled", 0, "tag"],
                ["web", 1, "tag"],
                ["worker", 1, "digest"],
            ]
        );
        const web = rows.find((row) => row.service_name === "web");
        assert.equal(web?.current_tag, "1.2.1");
        assert.equal(web?.latest_digest, "sha256:new");
        assert.equal(web?.last_status, "updated");
        assert.equal(
            rows.some((row) => row.service_name === "removed"),
            false
        );
        assert.ok(
            fetchUrls.some((url) => url.includes("repositories/library/nginx/tags"))
        );
        assert.ok(
            fetchUrls.some((url) => url.includes("ghcr.io/v2/owner/app/manifests/stable"))
        );
        assert.match(await readFile(composePath, "utf8"), /nginx:1\.2\.1/u);
        assert.match(await readFile(dockerCalls, "utf8"), /compose -f .* up -d web/u);
        const notificationCount = db
            .prepare("SELECT COUNT(*) AS count FROM notifications")
            .get() as { count: number };
        assert.equal(notificationCount.count, 2);
    });

    it("records registry and apply failures and reports missing manual services", async () => {
        const appsRoot = path.join(tempDir, "apps");
        const appDir = path.join(appsRoot, "broken");
        const binDir = path.join(tempDir, "bin");
        await mkdir(appDir, { recursive: true });
        await mkdir(binDir);
        const composePath = path.join(appDir, "compose.yaml");
        await writeFile(
            composePath,
            `services:
  bad-registry:
    image: busybox:1
  missing-field:
    image: alpine:3
    labels:
      mira.updater.autoUpdate: "true"
`,
            "utf8"
        );
        await writeExecutable(
            path.join(binDir, "docker"),
            "#!/usr/bin/env node\nprocess.exit(12);\n"
        );
        process.env.PATH = `${binDir}${path.delimiter}${originalPath || ""}`;
        globalThis.fetch = (async (input: string | URL | Request) => {
            const url = typeof input === "string" ? input : input.toString();
            return {
                ok: !url.includes("busybox"),
                status: 500,
                headers: new Headers(),
                json: async () => ({ results: [{ name: "3" }] }),
            } as Response;
        }) as typeof fetch;

        await withEnv(
            {
                MIRA_DOCKER_APPS_ROOT: appsRoot,
            },
            async () => {
                const { __testing, runDockerUpdaterService } = await import(
                    `./dockerUpdater.js?failure=${Date.now()}`
                );
                const firstRun = await runDockerUpdaterService();
                assert.equal(firstRun[1]?.ok, false);
                assert.match(firstRun[1]?.stderr ?? "", /bad-registry/u);
                const badRegistry = db
                    .prepare(
                        "SELECT * FROM docker_managed_services WHERE service_name = 'bad-registry'"
                    )
                    .get() as { id: number };
                const manualPollFailure = await runDockerUpdaterService(badRegistry.id);
                assert.deepEqual(
                    (manualPollFailure as StepResult[]).map((step) => [
                        step.step,
                        step.ok,
                    ]),
                    [
                        ["register", true],
                        ["poll", false],
                    ]
                );

                db.prepare(
                    `UPDATE docker_managed_services
                     SET latest_tag = '4', compose_image_field = NULL
                     WHERE service_name = 'missing-field'`
                ).run();
                const service = db
                    .prepare(
                        "SELECT * FROM docker_managed_services WHERE service_name = 'missing-field'"
                    )
                    .get();
                assert.ok(service);
                const manual = await __testing.applyServiceUpdate(service, "manual");
                assert.equal(manual.ok, false);
                assert.match(manual.stderr, /missing compose image field/u);

                const missing = await runDockerUpdaterService(99_999);
                assert.equal(missing.at(-1)?.stderr, "Docker updater service not found");
            }
        );
    });

    it("supports skipped registry checks and compose helper edge cases", async () => {
        const appsRoot = path.join(tempDir, "apps");
        const appDir = path.join(appsRoot, "helpers");
        await mkdir(appDir, { recursive: true });
        await writeFile(
            path.join(appDir, "compose.yaml"),
            `services:
  plain:
    image: postgres
    labels:
      - mira.updater.tagPattern=latest
      - mira.updater.track=tag
  digest:
    image: repo/app@sha256:old
    labels:
      mira.updater.autoUpdate: "yes"
`,
            "utf8"
        );

        await withEnv(
            {
                MIRA_DOCKER_APPS_ROOT: appsRoot,
                MIRA_DOCKER_UPDATER_SKIP_REGISTRY: "1",
            },
            async () => {
                const updater = await import(`./dockerUpdater.js?skip=${Date.now()}`);
                assert.deepEqual(updater.__testing.listComposeFiles(), [
                    path.join(appDir, "compose.yaml"),
                ]);
                const services = updater.__testing.servicesFromCompose(
                    path.join(appDir, "compose.yaml")
                );
                assert.equal(services[0].imageRepo, "postgres");
                assert.equal(services[0].currentTag, null);
                assert.equal(services[1].pinMode, "digest");
                const steps = await updater.runDockerUpdaterService(123);
                assert.equal(steps.length, 2);
                assert.equal(steps.at(-1)?.stderr, "Docker updater service not found");
            }
        );
    });

    it("covers updater helper fallback branches directly", async () => {
        const updater = await import(`./dockerUpdater.js?helpers=${Date.now()}`);
        assert.deepEqual([...updater.__testing.normalizeLabels(null)], []);
        assert.deepEqual(
            [...updater.__testing.normalizeLabels(["flag"])],
            [["flag", ""]]
        );
        assert.deepEqual(
            [...updater.__testing.normalizeLabels({ a: null })],
            [["a", ""]]
        );
        assert.equal(updater.__testing.normalizeDockerHubRepo("owner/app"), "owner/app");
        assert.equal(updater.__testing.normalizeDockerHubRepo("redis"), "library/redis");
        assert.equal(
            updater.__testing.stripRegistry("docker.io/library/redis"),
            "library/redis"
        );
        assert.equal(updater.__testing.stripRegistry("ghcr.io/owner/app"), "owner/app");
        await withEnv(
            {
                MIRA_DOCKER_COMPOSE_WRAPPER: "/tmp/mira-compose-wrapper",
            },
            async () => {
                assert.deepEqual(
                    updater.__testing.getComposeCommand("/srv/app/compose.yaml", "web"),
                    {
                        file: "/tmp/mira-compose-wrapper",
                        args: ["-f", "/srv/app/compose.yaml", "up", "-d", "web"],
                    }
                );
            }
        );
        const dockerRoot = path.join(tempDir, "docker-root");
        const wrapperPath = path.join(dockerRoot, "bin", "docker-compose-doppler");
        await mkdir(path.dirname(wrapperPath), { recursive: true });
        await writeFile(wrapperPath, "#!/bin/sh\n", "utf8");
        await withEnv(
            {
                MIRA_DOCKER_ROOT: dockerRoot,
            },
            async () => {
                assert.equal(
                    updater.__testing.getComposeCommand(
                        path.join(dockerRoot, "apps/app/compose.yaml"),
                        "web"
                    ).file,
                    wrapperPath
                );
            }
        );
        assert.equal(
            updater.__testing.isSafeTagRegexPattern(String.raw`^1\.2\.[0-9]+$`),
            true
        );
        assert.equal(updater.__testing.isSafeTagRegexPattern("(a+)+$"), false);
        assert.equal(updater.__testing.isSafeTagRegexPattern("a".repeat(129)), false);

        const baseService = {
            app_slug: "app",
            service_name: "svc",
            image_repo: "repo/app",
            compose_image_ref: "repo/app:1",
            current_tag: "1",
            current_digest: "sha256:old",
            latest_tag: "2",
            latest_digest: "sha256:new",
            pin_mode: "tag",
            tag_match_pattern: null,
            tag_match_type: "exact",
        };
        assert.equal(updater.__testing.tagMatches(baseService, "1"), true);
        assert.equal(
            updater.__testing.tagMatches(
                { ...baseService, tag_match_type: "regex", tag_match_pattern: "[" },
                "2"
            ),
            false
        );
        assert.equal(
            updater.__testing.tagMatches(
                {
                    ...baseService,
                    current_tag: "1",
                    tag_match_type: "regex",
                    tag_match_pattern: "(a+)+$",
                },
                "1"
            ),
            true
        );
        assert.equal(
            updater.__testing.tagMatches(
                { ...baseService, tag_match_type: "exact", tag_match_pattern: "stable" },
                "stable"
            ),
            true
        );
        assert.equal(updater.__testing.hasUpdate(baseService), true);
        assert.equal(
            updater.__testing.hasUpdate({
                ...baseService,
                pin_mode: "digest",
                latest_digest: "sha256:new",
            }),
            true
        );
        assert.equal(
            updater.__testing.buildTargetImageRef({
                ...baseService,
                pin_mode: "digest",
            }),
            "repo/app:1@sha256:new"
        );
        assert.equal(
            updater.__testing.buildTargetImageRef({
                ...baseService,
                compose_image_ref: "repo/app",
                pin_mode: "digest",
            }),
            "repo/app@sha256:new"
        );
        assert.equal(
            updater.__testing.buildTargetImageRef({
                ...baseService,
                compose_image_ref: null,
                latest_tag: null,
                current_tag: null,
            }),
            "repo/app:latest"
        );
        assert.deepEqual(
            updater.__testing.listComposeFiles(path.join(tempDir, "missing")),
            []
        );
        const emptyCompose = path.join(tempDir, "empty-compose.yaml");
        await writeFile(emptyCompose, "name: empty\n", "utf8");
        assert.deepEqual(updater.__testing.servicesFromCompose(emptyCompose), []);
        const nestedTarget = { services: { app: "bad" } };
        updater.__testing.setNestedValue(
            nestedTarget,
            "services.app.image",
            "repo/app:2"
        );
        assert.deepEqual(nestedTarget, { services: { app: { image: "repo/app:2" } } });
        updater.__testing.setNestedValue(
            nestedTarget,
            "services.app.image",
            "repo/app:3"
        );
        assert.deepEqual(nestedTarget, { services: { app: { image: "repo/app:3" } } });
        const dottedTarget = { services: {} };
        updater.__testing.setNestedValue(
            dottedTarget,
            "services.api.worker.image",
            "repo/dotted:1"
        );
        assert.deepEqual(dottedTarget, {
            services: { "api.worker": { image: "repo/dotted:1" } },
        });
        assert.equal(updater.__testing.caughtMessage("plain failure"), "plain failure");
        assert.equal(
            updater.__testing.caughtMessage(new Error("typed failure")),
            "typed failure"
        );
        globalThis.fetch = (async () =>
            ({
                ok: true,
                headers: new Headers({ "docker-content-digest": "sha256:new" }),
                json: async () => ({}),
            }) as Response) as typeof fetch;
        assert.deepEqual(
            await updater.__testing.lookupGhcr({
                ...baseService,
                image_repo: "ghcr.io/owner/app",
                current_tag: null,
                tag_match_pattern: null,
            }),
            { latestTag: "2", latestDigest: "sha256:new" }
        );
        globalThis.fetch = (async () =>
            ({
                ok: true,
                headers: new Headers(),
                json: async () => ({}),
            }) as Response) as typeof fetch;
        assert.deepEqual(
            await updater.__testing.lookupGhcr({
                ...baseService,
                image_repo: "ghcr.io/owner/app",
                latest_digest: null,
            }),
            { latestTag: "1", latestDigest: null }
        );

        globalThis.fetch = (async () =>
            ({
                ok: false,
                status: 503,
                headers: new Headers(),
                json: async () => ({}),
            }) as Response) as typeof fetch;
        await assert.rejects(
            () =>
                updater.__testing.lookupGhcr({
                    ...baseService,
                    image_repo: "ghcr.io/owner/app",
                }),
            /HTTP 503/u
        );
        await assert.rejects(
            () => updater.__testing.lookupDockerHub(baseService),
            /HTTP 503/u
        );
        globalThis.fetch = (async () => {
            throw Object.assign(new Error("aborted"), { name: "AbortError" });
        }) as typeof fetch;
        await assert.rejects(
            () =>
                updater.__testing.lookupGhcr({
                    ...baseService,
                    image_repo: "ghcr.io/owner/app",
                }),
            /Request timeout/u
        );
        await assert.rejects(
            () => updater.__testing.fetchJson("https://hub.docker.com/timeout"),
            /Request timeout/u
        );
        globalThis.fetch = (async () => {
            throw new Error("network down");
        }) as typeof fetch;
        await assert.rejects(
            () =>
                updater.__testing.lookupGhcr({
                    ...baseService,
                    image_repo: "ghcr.io/owner/app",
                }),
            /network down/u
        );

        globalThis.fetch = (async (input: string | URL | Request) => {
            const url = typeof input === "string" ? input : input.toString();
            if (url.endsWith("/tags?page_size=100")) {
                return {
                    ok: true,
                    headers: new Headers(),
                    json: async () => ({
                        results: [{}, { name: "1" }, { name: "2" }],
                    }),
                } as Response;
            }
            return {
                ok: true,
                headers: new Headers(),
                json: async () => ({
                    images: [
                        { architecture: "arm64", variant: "v7", digest: "sha256:v7" },
                        { architecture: "arm64", variant: "v8", digest: "sha256:v8" },
                    ],
                }),
            } as Response;
        }) as typeof fetch;
        assert.deepEqual(
            await updater.__testing.lookupDockerHub({
                ...baseService,
                tag_match_type: "regex",
                tag_match_pattern: String.raw`^\d$`,
            }),
            {
                latestTag: "2",
                latestDigest: "sha256:v8",
            }
        );

        globalThis.fetch = (async () =>
            ({
                ok: true,
                headers: new Headers(),
                json: async () => ({ results: "bad" }),
            }) as Response) as typeof fetch;
        assert.deepEqual(
            await updater.__testing.lookupDockerHub({
                ...baseService,
                current_tag: null,
            }),
            { latestTag: null, latestDigest: "sha256:old" }
        );

        globalThis.fetch = (async () =>
            ({
                ok: true,
                headers: new Headers(),
                json: async () => ({}),
            }) as Response) as typeof fetch;
        assert.deepEqual(await updater.__testing.lookupGhcr(baseService), {
            latestTag: "1",
            latestDigest: "sha256:new",
        });
        globalThis.fetch = (async () =>
            ({
                ok: true,
                headers: new Headers(),
                json: async () => ({ digest: "sha256:body" }),
            }) as Response) as typeof fetch;
        assert.deepEqual(await updater.__testing.lookupGhcr(baseService), {
            latestTag: "1",
            latestDigest: "sha256:body",
        });

        db.prepare(
            `INSERT INTO docker_managed_services (
                app_slug, service_name, compose_path, image_repo,
                compose_image_ref, compose_image_field, current_tag, current_digest,
                policy, pin_mode, tag_match_type, tag_match_pattern, enabled,
                metadata_json
            ) VALUES (
                'fallbacks', 'nulls', '/tmp/compose.yaml', 'repo/app',
                'repo/app', 'services.nulls.image', NULL, NULL, 'notify', 'tag',
                'exact', NULL, 1, '{}'
            )`
        ).run();
        await withEnv({ MIRA_DOCKER_UPDATER_SKIP_REGISTRY: "1" }, async () => {
            const result = await updater.pollDockerUpdaterRegistries();
            assert.equal(result.ok, true);
        });
        const nullFallback = db
            .prepare(
                "SELECT latest_tag, latest_digest FROM docker_managed_services WHERE service_name = 'nulls'"
            )
            .get() as { latest_tag: string | null; latest_digest: string | null };
        assert.equal(nullFallback.latest_tag, null);
        assert.equal(nullFallback.latest_digest, null);
    });

    it("rolls back service registration transaction failures", async () => {
        const appsRoot = path.join(tempDir, "apps");
        const appDir = path.join(appsRoot, "rollback-register");
        await mkdir(appDir, { recursive: true });
        await writeFile(
            path.join(appDir, "compose.yaml"),
            "services:\n  web:\n    image: nginx:1\n",
            "utf8"
        );
        await withEnv({ MIRA_DOCKER_APPS_ROOT: appsRoot }, async () => {
            const updater = await import(
                `./dockerUpdater.js?register-rollback=${Date.now()}`
            );
            const originalExec = db.exec.bind(db);
            const calls: string[] = [];
            const execMock = mock.method(db, "exec", (sql: string) => {
                calls.push(sql);
                if (sql === "COMMIT") {
                    throw new Error("commit failed");
                }
                return originalExec(sql);
            });
            try {
                await assert.rejects(
                    () => updater.registerDockerUpdaterServices(),
                    /commit failed/u
                );
                assert.deepEqual(
                    calls.filter((sql) => sql === "ROLLBACK"),
                    ["ROLLBACK"]
                );
            } finally {
                execMock.mock.restore();
            }
        });
    });

    it("keeps original docker compose errors when rollback fails", async () => {
        const appsRoot = path.join(tempDir, "apps");
        const appDir = path.join(appsRoot, "rollback");
        const binDir = path.join(tempDir, "bin");
        await mkdir(appDir, { recursive: true });
        await mkdir(binDir);
        const composePath = path.join(appDir, "compose.yaml");
        await writeFile(
            composePath,
            `services:
  web:
    image: nginx:1
`,
            "utf8"
        );
        await writeExecutable(
            path.join(binDir, "docker"),
            "#!/usr/bin/env node\nprocess.stderr.write('compose failed\\n'); process.exit(12);\n"
        );
        process.env.PATH = `${binDir}${path.delimiter}${originalPath || ""}`;
        const updater = await import(`./dockerUpdater.js?rollback=${Date.now()}`);
        const service = {
            id: 1,
            app_slug: "rollback",
            service_name: "web",
            compose_path: composePath,
            image_repo: "nginx",
            compose_image_ref: "nginx:1",
            compose_image_field: "services.web.image",
            current_tag: "1",
            current_digest: null,
            latest_tag: "2",
            latest_digest: null,
            policy: "manual",
            pin_mode: "tag",
            tag_match_type: "exact",
            tag_match_pattern: null,
            enabled: 1,
        };
        db.prepare(
            `INSERT INTO docker_managed_services (
                id, app_slug, service_name, compose_path, image_repo,
                compose_image_ref, compose_image_field, current_tag, current_digest,
                latest_tag, latest_digest, policy, pin_mode, tag_match_type,
                tag_match_pattern, enabled, metadata_json
            ) VALUES (
                @id, @app_slug, @service_name, @compose_path, @image_repo,
                @compose_image_ref, @compose_image_field, @current_tag, @current_digest,
                @latest_tag, @latest_digest, @policy, @pin_mode, @tag_match_type,
                @tag_match_pattern, @enabled, '{}'
            )`
        ).run(service);
        const originalWriteFileSync = fs.writeFileSync.bind(fs);
        let writeCount = 0;
        mock.method(
            fs,
            "writeFileSync",
            (...args: Parameters<typeof fs.writeFileSync>) => {
                writeCount += 1;
                if (writeCount === 2) {
                    throw new Error("rollback denied");
                }
                return originalWriteFileSync(...args);
            }
        );

        const result = await updater.__testing.applyServiceUpdate(service, "manual");

        assert.equal(result.ok, false);
        assert.match(result.stderr, /compose failed/u);
    });
});
