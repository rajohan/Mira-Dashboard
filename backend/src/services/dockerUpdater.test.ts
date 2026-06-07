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
    platform: linux/arm64
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
                db.prepare(
                    `INSERT INTO docker_managed_services (
                        app_slug, service_name, compose_path, image_repo,
                        compose_image_ref, compose_image_field, current_tag,
                        current_digest, policy, pin_mode, tag_match_type,
                        tag_match_pattern, enabled, metadata_json
                    ) VALUES (
                        'stale-app', 'old', ?, 'busybox', 'busybox:1',
                        'services.old.image', '1', NULL, 'notify', 'tag',
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
        assert.equal(
            rows.some((row) => row.app_slug === "stale-app"),
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
                    .get() as {
                    id: number;
                    latest_tag: string | null;
                    latest_digest: string | null;
                };
                assert.equal(badRegistry.latest_tag, null);
                assert.equal(badRegistry.latest_digest, null);
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
    platform: linux/amd64
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
                assert.equal(updater.__testing.getDockerAppsRoot(), appsRoot);
                const services = updater.__testing.servicesFromCompose(
                    path.join(appDir, "compose.yaml")
                );
                assert.equal(services.ok, true);
                assert.equal(services.services[0].imageRepo, "postgres");
                assert.equal(services.services[0].currentTag, "latest");
                assert.equal(services.services[1].pinMode, "digest");
                assert.equal(services.services[1].metadata.platform, "linux/amd64");
                const steps = await updater.runDockerUpdaterService(123);
                assert.equal(steps.length, 2);
                assert.equal(steps.at(-1)?.stderr, "Docker updater service not found");
            }
        );
    });

    it("resolves the default apps root at call time", async () => {
        const firstRoot = path.join(tempDir, "apps-a");
        const secondRoot = path.join(tempDir, "apps-b");
        const firstApp = path.join(firstRoot, "first");
        const secondApp = path.join(secondRoot, "second");
        await mkdir(firstApp, { recursive: true });
        await mkdir(secondApp, { recursive: true });
        await writeFile(path.join(firstApp, "compose.yaml"), "services: {}\n", "utf8");
        await writeFile(path.join(secondApp, "compose.yaml"), "services: {}\n", "utf8");
        const updater = await import(`./dockerUpdater.js?dynamic-root=${Date.now()}`);

        await withEnv({ MIRA_DOCKER_APPS_ROOT: firstRoot }, async () => {
            assert.deepEqual(updater.__testing.listComposeFiles(), [
                path.join(firstApp, "compose.yaml"),
            ]);
        });
        await withEnv({ MIRA_DOCKER_APPS_ROOT: secondRoot }, async () => {
            assert.deepEqual(updater.__testing.listComposeFiles(), [
                path.join(secondApp, "compose.yaml"),
            ]);
        });
    });

    it("fails registration after malformed compose files without pruning existing rows", async () => {
        const appsRoot = path.join(tempDir, "apps");
        const goodDir = path.join(appsRoot, "good");
        const badDir = path.join(appsRoot, "bad");
        await mkdir(goodDir, { recursive: true });
        await mkdir(badDir, { recursive: true });
        await writeFile(
            path.join(goodDir, "compose.yaml"),
            "services:\n  web:\n    image: nginx\n",
            "utf8"
        );
        await writeFile(path.join(badDir, "compose.yaml"), "services:\n  [", "utf8");
        db.prepare(
            `INSERT INTO docker_managed_services (
                app_slug, service_name, compose_path, image_repo, compose_image_ref,
                compose_image_field, current_tag, current_digest, policy, pin_mode,
                tag_match_type, tag_match_pattern, enabled, metadata_json
            ) VALUES (
                'bad', 'kept', ?, 'busybox', 'busybox:1',
                'services.kept.image', '1', NULL, 'notify', 'tag',
                'exact', '1', 1, '{}'
            )`
        ).run(path.join(badDir, "compose.yaml"));
        db.prepare(
            `INSERT INTO docker_managed_services (
                app_slug, service_name, compose_path, image_repo, compose_image_ref,
                compose_image_field, current_tag, current_digest, policy, pin_mode,
                tag_match_type, tag_match_pattern, enabled, metadata_json
            ) VALUES (
                'removed', 'old', ?, 'busybox', 'busybox:1',
                'services.old.image', '1', NULL, 'notify', 'tag',
                'exact', '1', 1, '{}'
            )`
        ).run(path.join(appsRoot, "removed", "compose.yaml"));

        await withEnv({ MIRA_DOCKER_APPS_ROOT: appsRoot }, async () => {
            const updater = await import(`./dockerUpdater.js?bad-compose=${Date.now()}`);
            const result = await updater.registerDockerUpdaterServices();
            assert.equal(result.ok, false);
            assert.equal(result.step, "register-services");
            assert.match(result.stderr, /bad/u);
            const run = await updater.runDockerUpdaterService();
            assert.deepEqual(
                (run as StepResult[]).map((step) => step.step),
                ["register-services"]
            );
        });

        const web = db
            .prepare(
                "SELECT current_tag, tag_match_pattern FROM docker_managed_services WHERE service_name = 'web'"
            )
            .get() as { current_tag: string; tag_match_pattern: string } | undefined;
        assert.equal(web, undefined);
        assert.equal(
            (
                db
                    .prepare(
                        "SELECT COUNT(*) AS count FROM docker_managed_services WHERE app_slug = 'bad'"
                    )
                    .get() as { count: number }
            ).count,
            1
        );
        assert.equal(
            (
                db
                    .prepare(
                        "SELECT COUNT(*) AS count FROM docker_managed_services WHERE app_slug = 'removed'"
                    )
                    .get() as { count: number }
            ).count,
            1
        );
    });

    it("sets the current tag when applying digest-pinned tag updates", async () => {
        const appsRoot = path.join(tempDir, "apps");
        const appDir = path.join(appsRoot, "digest-apply");
        const binDir = path.join(tempDir, "bin");
        await mkdir(appDir, { recursive: true });
        await mkdir(binDir);
        const composePath = path.join(appDir, "compose.yaml");
        await writeFile(
            composePath,
            "services:\n  web:\n    image: repo/app:1@sha256:old\n",
            "utf8"
        );
        await writeExecutable(
            path.join(binDir, "docker"),
            "#!/usr/bin/env node\nprocess.exit(0);\n"
        );
        process.env.PATH = `${binDir}${path.delimiter}${originalPath || ""}`;
        const updater = await import(`./dockerUpdater.js?digest-apply=${Date.now()}`);
        const service = {
            id: 1,
            app_slug: "digest-apply",
            service_name: "web",
            compose_path: composePath,
            image_repo: "repo/app",
            compose_image_ref: "repo/app:1@sha256:old",
            compose_image_field: "services.web.image",
            current_tag: "1",
            current_digest: "sha256:old",
            latest_tag: "2",
            latest_digest: "sha256:new",
            policy: "manual",
            pin_mode: "digest",
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

        const result = await updater.__testing.applyServiceUpdate(service, "manual");

        assert.equal(result.ok, true);
        assert.match(await readFile(composePath, "utf8"), /repo\/app:2@sha256:new/u);
        const row = db
            .prepare(
                `SELECT current_tag, current_digest
                 FROM docker_managed_services WHERE id = ?`
            )
            .get(service.id) as {
            current_digest: string | null;
            current_tag: string | null;
        };
        assert.equal(row.current_tag, "2");
        assert.equal(row.current_digest, "sha256:new");
    });

    it("can apply an update from the passed service when the locked DB row is gone", async () => {
        const appDir = path.join(tempDir, "missing-row-apply");
        const binDir = path.join(tempDir, "bin");
        await mkdir(appDir, { recursive: true });
        await mkdir(binDir);
        const composePath = path.join(appDir, "compose.yaml");
        await writeFile(
            composePath,
            "services:\n  web:\n    image: repo/app:1\n",
            "utf8"
        );
        await writeExecutable(
            path.join(binDir, "docker"),
            "#!/usr/bin/env node\nprocess.exit(0);\n"
        );
        process.env.PATH = `${binDir}${path.delimiter}${originalPath || ""}`;
        const updater = await import(`./dockerUpdater.js?missing-row=${Date.now()}`);
        const service = {
            id: 999,
            app_slug: "missing-row-apply",
            service_name: "web",
            compose_path: composePath,
            image_repo: "repo/app",
            compose_image_ref: "repo/app:1",
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

        const result = await updater.__testing.applyServiceUpdate(service, "manual");

        assert.equal(result.ok, true);
        assert.match(await readFile(composePath, "utf8"), /repo\/app:2/u);
    });

    it("accepts arm64 v8 registry variants for linux/arm64 services", async () => {
        const updater = await import(`./dockerUpdater.js?platform-v8=${Date.now()}`);

        assert.equal(
            updater.__testing.imageMatchesPlatform(
                { architecture: "arm64", os: "linux", variant: "v8" },
                "linux/arm64"
            ),
            true
        );
        assert.equal(
            updater.__testing.imageMatchesPlatform(
                { architecture: "amd64", os: "linux", variant: "v8" },
                "linux/amd64"
            ),
            false
        );
    });

    it("serializes concurrent compose updates for services in the same file", async () => {
        const appDir = path.join(tempDir, "locked-apply");
        const binDir = path.join(tempDir, "bin");
        const seenPath = path.join(tempDir, "seen.txt");
        await mkdir(appDir, { recursive: true });
        await mkdir(binDir);
        const composePath = path.join(appDir, "compose.yaml");
        await writeFile(
            composePath,
            [
                "services:",
                "  web:",
                "    image: repo/app:1",
                "  worker:",
                "    image: repo/worker:1",
                "",
            ].join("\n"),
            "utf8"
        );
        await writeExecutable(
            path.join(binDir, "docker"),
            String.raw`#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const composePath = args[args.indexOf("-f") + 1];
const images = [...fs.readFileSync(composePath, "utf8").matchAll(/image:\s*(.+)/g)]
  .map((match) => match[1].trim())
  .join(",");
fs.appendFileSync(process.env.SEEN_COMPOSE_IMAGES, images + "\n");
setTimeout(() => process.exit(0), 30);
`
        );
        process.env.PATH = `${binDir}${path.delimiter}${originalPath || ""}`;
        const updater = await import(`./dockerUpdater.js?locked-apply=${Date.now()}`);
        const baseService = {
            id: 1,
            app_slug: "locked-apply",
            service_name: "web",
            compose_path: composePath,
            image_repo: "repo/app",
            compose_image_ref: "repo/app:1",
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
        const workerService = {
            ...baseService,
            id: 2,
            service_name: "worker",
            image_repo: "repo/worker",
            compose_image_ref: "repo/worker:1",
            compose_image_field: "services.worker.image",
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
        ).run(baseService);
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
        ).run(workerService);

        await withEnv({ SEEN_COMPOSE_IMAGES: seenPath }, async () => {
            const first = updater.__testing.applyServiceUpdate(baseService, "manual");
            db.prepare(
                "UPDATE docker_managed_services SET latest_tag = '3' WHERE id = ?"
            ).run(workerService.id);
            const second = updater.__testing.applyServiceUpdate(workerService, "manual");
            const results = await Promise.all([first, second]);

            assert.deepEqual(
                results.map((result) => result.ok),
                [true, true]
            );
        });

        assert.equal(
            await readFile(seenPath, "utf8"),
            "repo/app:2,repo/worker:1\nrepo/app:2,repo/worker:3\n"
        );
        const composeText = await readFile(composePath, "utf8");
        assert.match(composeText, /repo\/app:2/u);
        assert.match(composeText, /repo\/worker:3/u);
    });

    it("removes stale services after an empty successful compose scan", async () => {
        const appsRoot = path.join(tempDir, "empty-apps");
        await mkdir(appsRoot);
        db.prepare(
            `INSERT INTO docker_managed_services (
                app_slug, service_name, compose_path, image_repo, compose_image_ref,
                compose_image_field, current_tag, current_digest, policy, pin_mode,
                tag_match_type, tag_match_pattern, enabled, metadata_json,
                last_checked_at, last_status
            ) VALUES (
                'removed-empty-app', 'web', '/removed/compose.yaml', 'nginx',
                'nginx:1', 'services.web.image', '1', NULL, 'notify', 'tag',
                'exact', '1', 1, '{}', '2026-06-06T00:00:00.000Z', 'registered'
            )`
        ).run();

        await withEnv({ MIRA_DOCKER_APPS_ROOT: appsRoot }, async () => {
            const updater = await import(`./dockerUpdater.js?empty-root=${Date.now()}`);
            const result = await updater.registerDockerUpdaterServices();

            assert.equal(result.ok, true);
            assert.equal(serviceRows().length, 0);
        });
    });

    it("preserves registered services when the compose apps root is unavailable", async () => {
        db.prepare(
            `INSERT INTO docker_managed_services (
                app_slug, service_name, compose_path, image_repo, compose_image_ref,
                compose_image_field, current_tag, current_digest, policy, pin_mode,
                tag_match_type, tag_match_pattern, enabled, metadata_json,
                last_checked_at, last_status
            ) VALUES (
                'missing-root-app', 'web', '/missing/compose.yaml', 'nginx',
                'nginx:1', 'services.web.image', '1', NULL, 'notify', 'tag',
                'exact', '1', 1, '{}', '2026-06-06T00:00:00.000Z', 'registered'
            )`
        ).run();

        await withEnv(
            { MIRA_DOCKER_APPS_ROOT: path.join(tempDir, "missing-apps") },
            async () => {
                const updater = await import(
                    `./dockerUpdater.js?missing-root=${Date.now()}`
                );
                const result = await updater.registerDockerUpdaterServices();

                assert.equal(result.ok, false);
                assert.match(result.stderr, /Compose apps root not found/u);
                assert.equal(serviceRows().length, 1);
                const run = await updater.runDockerUpdaterService();
                assert.deepEqual(run, [result]);
            }
        );
    });

    it("preserves registered services when compose discovery throws", async () => {
        const appsRoot = path.join(tempDir, "unreadable-apps");
        await mkdir(appsRoot);
        db.prepare(
            `INSERT INTO docker_managed_services (
                app_slug, service_name, compose_path, image_repo, compose_image_ref,
                compose_image_field, current_tag, current_digest, policy, pin_mode,
                tag_match_type, tag_match_pattern, enabled, metadata_json,
                last_checked_at, last_status
            ) VALUES (
                'unreadable-root-app', 'web', '/unreadable/compose.yaml', 'nginx',
                'nginx:1', 'services.web.image', '1', NULL, 'notify', 'tag',
                'exact', '1', 1, '{}', '2026-06-06T00:00:00.000Z', 'registered'
            )`
        ).run();

        await withEnv({ MIRA_DOCKER_APPS_ROOT: appsRoot }, async () => {
            const updater = await import(
                `./dockerUpdater.js?unreadable-root=${Date.now()}`
            );
            const readDirMock = mock.method(fs, "readdirSync", () => {
                throw new Error("apps root unreadable");
            });
            try {
                const result = await updater.registerDockerUpdaterServices();

                assert.equal(result.ok, false);
                assert.match(result.stderr, /apps root unreadable/u);
                assert.equal(serviceRows().length, 1);
            } finally {
                readDirMock.mock.restore();
            }
        });
    });

    it("skips unsupported registries and applies refreshed manual targets", async () => {
        const appsRoot = path.join(tempDir, "apps");
        const appDir = path.join(appsRoot, "manual");
        const binDir = path.join(tempDir, "bin");
        await mkdir(appDir, { recursive: true });
        await mkdir(binDir);
        const composePath = path.join(appDir, "compose.yaml");
        await writeFile(
            composePath,
            `services:
  web:
    image: nginx:1
    labels:
      mira.updater.enabled: "true"
      mira.updater.tagPattern: "^[0-9]+$"
  external:
    image: lscr.io/linuxserver/swag:latest
    labels:
      mira.updater.enabled: "true"
`,
            "utf8"
        );
        await writeExecutable(
            path.join(binDir, "docker"),
            "#!/usr/bin/env node\nprocess.exit(0);\n"
        );
        process.env.PATH = `${binDir}${path.delimiter}${originalPath || ""}`;
        const fetchUrls: string[] = [];
        globalThis.fetch = (async (input: string | URL | Request) => {
            const url = typeof input === "string" ? input : input.toString();
            fetchUrls.push(url);
            return {
                ok: true,
                headers: new Headers(),
                json: async () =>
                    url.endsWith("/tags/3")
                        ? { images: [{ architecture: "arm64", digest: "sha256:new" }] }
                        : { results: [{ name: "1" }, { name: "2" }, { name: "3" }] },
            } as Response;
        }) as typeof fetch;

        await withEnv({ MIRA_DOCKER_APPS_ROOT: appsRoot }, async () => {
            const updater = await import(`./dockerUpdater.js?manual=${Date.now()}`);
            await updater.registerDockerUpdaterServices();
            const service = db
                .prepare(
                    "SELECT id FROM docker_managed_services WHERE service_name = 'web'"
                )
                .get() as { id: number };
            const steps = await updater.runDockerUpdaterService(service.id);
            assert.equal(steps.at(-1)?.ok, true);
        });

        assert.match(await readFile(composePath, "utf8"), /image: nginx:3/u);
        assert.equal(
            fetchUrls.some((url) => url.includes("linuxserver")),
            false
        );
        assert.equal(
            fetchUrls.some((url) => url.includes("linuxserver")),
            false
        );

        await withEnv({ MIRA_DOCKER_APPS_ROOT: appsRoot }, async () => {
            const updater = await import(
                `./dockerUpdater.js?manual-fallback=${Date.now()}`
            );
            await updater.registerDockerUpdaterServices();
            const service = db
                .prepare(
                    "SELECT id FROM docker_managed_services WHERE service_name = 'web'"
                )
                .get() as { id: number };
            let deleted = false;
            globalThis.fetch = (async () => {
                if (!deleted) {
                    deleted = true;
                    db.prepare(
                        "DELETE FROM docker_update_events WHERE managed_service_id = ?"
                    ).run(service.id);
                    db.prepare("DELETE FROM docker_managed_services WHERE id = ?").run(
                        service.id
                    );
                }
                return {
                    ok: true,
                    headers: new Headers(),
                    json: async () => ({ results: [{ name: "3" }] }),
                } as Response;
            }) as typeof fetch;
            const missingAfterPoll = await updater.runDockerUpdaterService(service.id);
            assert.equal(
                missingAfterPoll.at(-1)?.stderr,
                "Docker updater service not found after registry poll"
            );

            await updater.registerDockerUpdaterServices();
            const toggledService = db
                .prepare(
                    "SELECT id FROM docker_managed_services WHERE service_name = 'web'"
                )
                .get() as { id: number };
            let toggled = false;
            globalThis.fetch = (async () => {
                if (!toggled) {
                    toggled = true;
                    db.prepare(
                        "UPDATE docker_managed_services SET enabled = 0 WHERE id = ?"
                    ).run(toggledService.id);
                }
                return {
                    ok: true,
                    headers: new Headers(),
                    json: async () => ({ results: [{ name: "3" }] }),
                } as Response;
            }) as typeof fetch;
            const disabledAfterPoll = await updater.runDockerUpdaterService(
                toggledService.id
            );
            assert.equal(
                disabledAfterPoll.at(-1)?.stderr,
                "Docker updater service not found after registry poll"
            );
        });
    });

    it("does not block a manual update on unrelated registry failures", async () => {
        const appsRoot = path.join(tempDir, "apps");
        const appDir = path.join(appsRoot, "manual-scope");
        const binDir = path.join(tempDir, "bin");
        await mkdir(appDir, { recursive: true });
        await mkdir(binDir);
        const composePath = path.join(appDir, "compose.yaml");
        await writeFile(
            composePath,
            `services:
  target:
    image: nginx:1
    labels:
      mira.updater.tagPattern: "^[0-9]+$"
  broken:
    image: busybox:1
`,
            "utf8"
        );
        await writeExecutable(
            path.join(binDir, "docker"),
            "#!/usr/bin/env node\nprocess.exit(0);\n"
        );
        process.env.PATH = `${binDir}${path.delimiter}${originalPath || ""}`;
        globalThis.fetch = (async (input: string | URL | Request) => {
            const url = typeof input === "string" ? input : input.toString();
            if (url.includes("busybox")) {
                return {
                    ok: false,
                    status: 500,
                    headers: new Headers(),
                    json: async () => ({}),
                } as Response;
            }
            return {
                ok: true,
                headers: new Headers(),
                json: async () =>
                    url.endsWith("/tags/2")
                        ? { images: [{ architecture: "arm64", digest: "sha256:new" }] }
                        : { results: [{ name: "1" }, { name: "2" }] },
            } as Response;
        }) as typeof fetch;

        await withEnv({ MIRA_DOCKER_APPS_ROOT: appsRoot }, async () => {
            const updater = await import(`./dockerUpdater.js?manual-scope=${Date.now()}`);
            await updater.registerDockerUpdaterServices();
            const service = db
                .prepare(
                    "SELECT id FROM docker_managed_services WHERE service_name = 'target'"
                )
                .get() as { id: number };
            const steps = await updater.runDockerUpdaterService(service.id);
            assert.equal(
                (steps as StepResult[]).every((step) => step.ok),
                true
            );
        });

        assert.match(await readFile(composePath, "utf8"), /image: nginx:2/u);
    });

    it("skips manual apply when a fresh poll finds no tag update", async () => {
        const appsRoot = path.join(tempDir, "apps");
        const appDir = path.join(appsRoot, "manual-current");
        const binDir = path.join(tempDir, "bin");
        await mkdir(appDir, { recursive: true });
        await mkdir(binDir);
        const composePath = path.join(appDir, "compose.yaml");
        await writeFile(
            composePath,
            `services:
  target:
    image: nginx:1
    labels:
      mira.updater.tagPattern: "^[0-9]+$"
`,
            "utf8"
        );
        await writeExecutable(
            path.join(binDir, "docker"),
            "#!/usr/bin/env node\nprocess.stdout.write('unexpected apply\\n');\n"
        );
        process.env.PATH = `${binDir}${path.delimiter}${originalPath || ""}`;
        globalThis.fetch = (async (input: string | URL | Request) => {
            const url = typeof input === "string" ? input : input.toString();
            return {
                ok: true,
                headers: new Headers(),
                json: async () =>
                    url.endsWith("/tags/1")
                        ? { digest: "sha256:same-tag" }
                        : { results: [{ name: "1" }] },
            } as Response;
        }) as typeof fetch;

        await withEnv({ MIRA_DOCKER_APPS_ROOT: appsRoot }, async () => {
            const updater = await import(
                `./dockerUpdater.js?manual-current=${Date.now()}`
            );
            await updater.registerDockerUpdaterServices();
            const service = db
                .prepare(
                    "SELECT id FROM docker_managed_services WHERE service_name = 'target'"
                )
                .get() as { id: number };
            db.prepare(
                `UPDATE docker_managed_services
                 SET latest_tag = '2', latest_digest = 'sha256:stale',
                     last_status = 'update_available'
                 WHERE id = ?`
            ).run(service.id);

            const steps = (await updater.runDockerUpdaterService(
                service.id
            )) as StepResult[];
            assert.deepEqual(
                steps.map((step) => step.step),
                ["register", "poll", "manual-update-skipped:manual-current/target"]
            );
            const row = db
                .prepare(
                    `SELECT last_status, latest_tag, latest_digest, current_tag
                     FROM docker_managed_services WHERE id = ?`
                )
                .get(service.id) as {
                current_tag: string | null;
                last_status: string | null;
                latest_digest: string | null;
                latest_tag: string | null;
            };
            assert.equal(row.current_tag, "1");
            assert.equal(row.latest_tag, "1");
            assert.equal(row.latest_digest, "sha256:same-tag");
            assert.equal(row.last_status, "current");
        });

        assert.match(await readFile(composePath, "utf8"), /image: nginx:1/u);
    });

    it("covers updater helper fallback branches directly", async () => {
        const updater = await import(`./dockerUpdater.js?helpers=${Date.now()}`);
        assert.equal(
            updater.__testing.imageRegistry("lscr.io/linuxserver/swag"),
            "lscr.io"
        );
        assert.equal(updater.__testing.imageRegistry("nginx"), "docker.io");
        assert.equal(updater.__testing.imageRegistry(""), "docker.io");
        assert.equal(
            updater.__testing.imageRegistry("index.docker.io/library/redis"),
            "docker.io"
        );
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
        assert.equal(updater.__testing.parseBearerChallenge(null), null);
        assert.equal(updater.__testing.parseBearerChallenge("Basic realm=ghcr"), null);
        assert.equal(
            updater.__testing.parseBearerChallenge('Bearer service="ghcr.io"'),
            null
        );
        assert.deepEqual(
            updater.__testing.parseBearerChallenge(
                'Bearer realm="https://ghcr.io/token",service="ghcr.io"'
            ),
            { realm: "https://ghcr.io/token", service: "ghcr.io" }
        );
        assert.equal(
            updater.__testing.stripRegistry("docker.io/library/redis"),
            "library/redis"
        );
        assert.equal(
            updater.__testing.stripRegistry("index.docker.io/library/redis"),
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
        await withEnv(
            {
                MIRA_DOCKER_BIN: "/tmp/mira-docker",
                MIRA_DOCKER_ROOT: path.join(tempDir, "docker-root-without-wrapper"),
            },
            async () => {
                assert.deepEqual(
                    updater.__testing.getComposeCommand("/srv/app/compose.yaml", "web"),
                    {
                        file: "/tmp/mira-docker",
                        args: [
                            "compose",
                            "-f",
                            "/srv/app/compose.yaml",
                            "up",
                            "-d",
                            "web",
                        ],
                    }
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
                current_tag: "1",
                latest_tag: "1",
                current_digest: "sha256:old",
                latest_digest: "sha256:new",
            }),
            false
        );
        assert.equal(
            updater.__testing.hasUpdate({
                ...baseService,
                pin_mode: "digest",
                latest_digest: "sha256:new",
            }),
            true
        );
        assert.equal(
            updater.__testing.hasUpdate({
                ...baseService,
                pin_mode: "digest",
                current_digest: null,
                latest_digest: "sha256:new",
            }),
            true
        );
        assert.equal(
            updater.__testing.buildTargetImageRef({
                ...baseService,
                pin_mode: "digest",
            }),
            "repo/app:2@sha256:new"
        );
        assert.equal(
            updater.__testing.buildTargetImageRef({
                ...baseService,
                latest_tag: null,
                pin_mode: "digest",
            }),
            "repo/app:1@sha256:new"
        );
        assert.equal(
            updater.__testing.buildTargetImageRef({
                ...baseService,
                compose_image_ref: "repo/app",
                latest_tag: null,
                pin_mode: "digest",
            }),
            "repo/app@sha256:new"
        );
        assert.equal(
            updater.__testing.buildTargetImageRef({
                ...baseService,
                compose_image_ref: "repo/app",
                pin_mode: "digest",
            }),
            "repo/app:2@sha256:new"
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
        assert.deepEqual(updater.__testing.servicesFromCompose(emptyCompose), {
            appSlug: path.basename(tempDir),
            ok: true,
            services: [],
        });
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

        globalThis.fetch = (async () =>
            ({
                ok: false,
                status: 401,
                headers: new Headers(),
                json: async () => ({}),
            }) as Response) as typeof fetch;
        await assert.rejects(
            () =>
                updater.__testing.fetchRegistryJson(
                    "https://ghcr.io/v2/owner/app/tags/list"
                ),
            /HTTP 401/u
        );

        globalThis.fetch = (async (input: string | URL | Request) => {
            const url = typeof input === "string" ? input : input.toString();
            if (url.startsWith("https://ghcr.io/token")) {
                return {
                    ok: false,
                    status: 503,
                    headers: new Headers(),
                    json: async () => ({}),
                } as Response;
            }
            return {
                ok: false,
                status: 401,
                headers: new Headers({
                    "www-authenticate":
                        'Bearer realm="https://ghcr.io/token",service="ghcr.io"',
                }),
                json: async () => ({}),
            } as Response;
        }) as typeof fetch;
        await assert.rejects(
            () =>
                updater.__testing.fetchRegistryJson(
                    "https://ghcr.io/v2/owner/app/tags/list"
                ),
            /HTTP 401/u
        );

        globalThis.fetch = (async (input: string | URL | Request) => {
            const url = typeof input === "string" ? input : input.toString();
            if (url.startsWith("https://ghcr.io/token")) {
                return {
                    ok: true,
                    headers: new Headers(),
                    json: async () => ({ access_token: 123 }),
                } as Response;
            }
            return {
                ok: false,
                status: 401,
                headers: new Headers({
                    "www-authenticate":
                        'Bearer realm="https://ghcr.io/token",service="ghcr.io"',
                }),
                json: async () => ({}),
            } as Response;
        }) as typeof fetch;
        await assert.rejects(
            () =>
                updater.__testing.fetchRegistryJson(
                    "https://ghcr.io/v2/owner/app/tags/list"
                ),
            /HTTP 401/u
        );

        globalThis.fetch = (async (input: string | URL | Request) => {
            const url = typeof input === "string" ? input : input.toString();
            if (url.endsWith("/tags?page_size=100")) {
                return {
                    ok: true,
                    headers: new Headers(),
                    json: async () => ({
                        results: [{}, { name: "1" }, { name: "2" }],
                        next: "https://hub.docker.com/v2/repositories/library/nginx/tags?page=2",
                    }),
                } as Response;
            }
            if (url.endsWith("/tags?page=2")) {
                return {
                    ok: true,
                    headers: new Headers(),
                    json: async () => ({
                        results: [{ name: "3" }],
                        next: null,
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
                metadata_json: JSON.stringify({ platform: "linux/arm64/v8" }),
            }),
            {
                latestTag: "3",
                latestDigest: "sha256:v8",
            }
        );

        globalThis.fetch = (async (input: string | URL | Request) => {
            const url = typeof input === "string" ? input : input.toString();
            if (url.includes("/tags?page_size=100")) {
                return {
                    ok: true,
                    headers: new Headers(),
                    json: async () => ({
                        results: [{ name: "3" }],
                        next: null,
                    }),
                } as Response;
            }
            return {
                ok: true,
                headers: new Headers(),
                json: async () => ({
                    images: [
                        { architecture: "arm64", variant: "v8", digest: "sha256:v8" },
                        { os: "linux", architecture: "amd64", digest: "sha256:amd64" },
                    ],
                }),
            } as Response;
        }) as typeof fetch;
        assert.deepEqual(
            await updater.__testing.lookupDockerHub({
                ...baseService,
                tag_match_type: "regex",
                tag_match_pattern: String.raw`^\d$`,
                metadata_json: JSON.stringify({ platform: "linux/amd64" }),
            }),
            {
                latestTag: "3",
                latestDigest: "sha256:amd64",
            }
        );
        process.env.MIRA_DOCKER_UPDATER_PLATFORM = "linux/amd64";
        assert.deepEqual(
            await updater.__testing.lookupDockerHub({
                ...baseService,
                tag_match_type: "regex",
                tag_match_pattern: String.raw`^\d$`,
                metadata_json: "{bad json",
            }),
            {
                latestTag: "3",
                latestDigest: "sha256:amd64",
            }
        );
        delete process.env.MIRA_DOCKER_UPDATER_PLATFORM;
        const archDescriptor = Object.getOwnPropertyDescriptor(process, "arch");
        Object.defineProperty(process, "arch", {
            configurable: true,
            enumerable: true,
            value: "x64",
        });
        try {
            assert.deepEqual(
                await updater.__testing.lookupDockerHub({
                    ...baseService,
                    tag_match_type: "regex",
                    tag_match_pattern: String.raw`^\d$`,
                    metadata_json: undefined,
                }),
                {
                    latestTag: "3",
                    latestDigest: "sha256:amd64",
                }
            );
        } finally {
            if (archDescriptor) {
                Object.defineProperty(process, "arch", archDescriptor);
            }
        }
        Object.defineProperty(process, "arch", {
            configurable: true,
            enumerable: true,
            value: "arm64",
        });
        try {
            assert.deepEqual(
                await updater.__testing.lookupDockerHub({
                    ...baseService,
                    tag_match_type: "regex",
                    tag_match_pattern: String.raw`^\d$`,
                    metadata_json: undefined,
                }),
                {
                    latestTag: "3",
                    latestDigest: "sha256:v8",
                }
            );
        } finally {
            if (archDescriptor) {
                Object.defineProperty(process, "arch", archDescriptor);
            }
        }
        process.env.MIRA_DOCKER_UPDATER_PLATFORM = "linux/amd64";
        assert.deepEqual(
            await updater.__testing.lookupDockerHub({
                ...baseService,
                tag_match_type: "regex",
                tag_match_pattern: String.raw`^\d$`,
                metadata_json: undefined,
            }),
            {
                latestTag: "3",
                latestDigest: "sha256:amd64",
            }
        );
        delete process.env.MIRA_DOCKER_UPDATER_PLATFORM;
        assert.equal(updater.__testing.parseNextLink(null), null);
        assert.equal(
            updater.__testing.parseNextLink(
                '<https://ghcr.io/v2/owner/app/tags/list?n=100>; rel="next"'
            ),
            "https://ghcr.io/v2/owner/app/tags/list?n=100"
        );
        assert.equal(
            updater.__testing.parseNextLink(
                '<https://ghcr.io/v2/owner/app/tags/list?n=100>; rel="last"'
            ),
            null
        );
        assert.equal(
            updater.__testing.parseNextLink(
                'https://ghcr.io/v2/owner/app/tags/list?n=100; rel="next"'
            ),
            null
        );

        globalThis.fetch = (async (input: string | URL | Request) => {
            const url = typeof input === "string" ? input : input.toString();
            if (url.endsWith("/tags/list")) {
                return {
                    ok: true,
                    headers: new Headers({
                        link: '<https://ghcr.io/v2/owner/app/tags/list?n=100&last=1.0.0>; rel="next"',
                    }),
                    json: async () => ({ tags: ["1.0.0", "dev"] }),
                } as Response;
            }
            if (url.includes("/tags/list?n=100&last=1.0.0")) {
                return {
                    ok: true,
                    headers: new Headers(),
                    json: async () => ({ tags: ["2.0.0"] }),
                } as Response;
            }
            return {
                ok: true,
                headers: new Headers({ "docker-content-digest": "sha256:ghcr-2" }),
                json: async () => ({}),
            } as Response;
        }) as typeof fetch;
        assert.deepEqual(
            await updater.__testing.lookupGhcr({
                ...baseService,
                image_repo: "ghcr.io/owner/app",
                current_tag: "1.0.0",
                tag_match_type: "regex",
                tag_match_pattern: String.raw`^\d+\.\d+\.\d+$`,
            }),
            {
                latestTag: "2.0.0",
                latestDigest: "sha256:ghcr-2",
            }
        );

        const authFetchUrls: string[] = [];
        globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
            const url = typeof input === "string" ? input : input.toString();
            authFetchUrls.push(url);
            const authorization = new Headers(init?.headers).get("authorization");
            if (url.endsWith("/tags/list") && !authorization) {
                return {
                    ok: false,
                    status: 401,
                    headers: new Headers({
                        "www-authenticate":
                            'Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:owner/app:pull"',
                    }),
                    json: async () => ({}),
                } as Response;
            }
            if (url.startsWith("https://ghcr.io/token")) {
                return {
                    ok: true,
                    headers: new Headers(),
                    json: async () => ({ token: "registry-token" }),
                } as Response;
            }
            return {
                ok: true,
                headers: new Headers({ "docker-content-digest": "sha256:authed" }),
                json: async () =>
                    url.endsWith("/tags/list") ? { tags: ["1", "2"] } : {},
            } as Response;
        }) as typeof fetch;
        assert.deepEqual(
            await updater.__testing.lookupGhcr({
                ...baseService,
                image_repo: "ghcr.io/owner/app",
                tag_match_type: "regex",
                tag_match_pattern: String.raw`^\d$`,
            }),
            { latestTag: "2", latestDigest: "sha256:authed" }
        );
        assert.ok(authFetchUrls.some((url) => url.startsWith("https://ghcr.io/token")));

        globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
            const url = typeof input === "string" ? input : input.toString();
            if (url.startsWith("https://ghcr.io/token")) {
                return {
                    ok: true,
                    headers: new Headers(),
                    json: async () => ({ access_token: "registry-access-token" }),
                } as Response;
            }
            const authorization = new Headers(init?.headers).get("authorization");
            if (!authorization) {
                return {
                    ok: false,
                    status: 401,
                    headers: new Headers({
                        "www-authenticate":
                            'Bearer realm="https://ghcr.io/token",service="ghcr.io"',
                    }),
                    json: async () => ({}),
                } as Response;
            }
            return {
                ok: true,
                headers: new Headers(),
                json: async () => ({ tags: ["1"] }),
            } as Response;
        }) as typeof fetch;
        assert.deepEqual(
            await updater.__testing.fetchRegistryJson(
                "https://ghcr.io/v2/owner/app/tags/list"
            ),
            { tags: ["1"] }
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
        let dockerHubCall = 0;
        globalThis.fetch = (async () => {
            dockerHubCall += 1;
            return {
                ok: true,
                headers: new Headers(),
                json: async () =>
                    dockerHubCall === 1
                        ? { results: [{ name: "2" }] }
                        : { images: [], digest: null },
            } as Response;
        }) as typeof fetch;
        assert.deepEqual(
            await updater.__testing.lookupDockerHub({
                ...baseService,
                current_digest: null,
                tag_match_type: "regex",
                tag_match_pattern: String.raw`^\d$`,
            }),
            { latestTag: "2", latestDigest: null }
        );
        assert.deepEqual(
            await updater.__testing.lookupLatest({
                ...baseService,
                image_repo: "lscr.io/linuxserver/swag",
            }),
            { latestTag: "1", latestDigest: "sha256:old" }
        );
        assert.deepEqual(
            await updater.__testing.lookupLatest({
                ...baseService,
                image_repo: "lscr.io/linuxserver/swag",
                latest_tag: null,
                latest_digest: null,
            }),
            { latestTag: "1", latestDigest: "sha256:old" }
        );

        const acceptHeaders: string[] = [];
        globalThis.fetch = (async (_input, init) => {
            acceptHeaders.push(String((init?.headers as Record<string, string>).Accept));
            return {
                ok: true,
                headers: new Headers(),
                json: async () => ({}),
            } as Response;
        }) as typeof fetch;
        assert.deepEqual(await updater.__testing.lookupGhcr(baseService), {
            latestTag: "1",
            latestDigest: "sha256:new",
        });
        assert.ok(
            acceptHeaders.some((header) =>
                header.includes("application/vnd.docker.distribution.manifest.v2+json")
            )
        );
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

    it("re-applies the restored compose file after compose update failure", async () => {
        const appDir = path.join(tempDir, "rollback-reapply");
        const binDir = path.join(tempDir, "bin");
        await mkdir(appDir, { recursive: true });
        await mkdir(binDir);
        const composePath = path.join(appDir, "compose.yaml");
        const callLogPath = path.join(tempDir, "compose-calls.log");
        const originalCompose = "services:\n  web:\n    image: nginx:1\n";
        await writeFile(composePath, originalCompose, "utf8");
        await writeExecutable(
            path.join(binDir, "docker"),
            String.raw`#!/usr/bin/env node
const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(callLogPath)}, "compose\n");
if (fs.readFileSync(${JSON.stringify(callLogPath)}, "utf8").split("\n").filter(Boolean).length === 1) {
  process.stderr.write("compose failed\n");
  process.exit(12);
}
process.exit(0);
`
        );
        process.env.PATH = `${binDir}${path.delimiter}${originalPath || ""}`;
        const updater = await import(`./dockerUpdater.js?rollback-reapply=${Date.now()}`);
        const service = {
            id: 1,
            app_slug: "rollback-reapply",
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

        const result = await updater.__testing.applyServiceUpdate(service, "manual");

        assert.equal(result.ok, false);
        assert.match(result.stderr, /compose failed/u);
        assert.equal(await readFile(composePath, "utf8"), originalCompose);
        assert.equal(await readFile(callLogPath, "utf8"), "compose\ncompose\n");
    });

    it("restores the compose file when writing the updated file fails", async () => {
        const appDir = path.join(tempDir, "write-failure");
        await mkdir(appDir, { recursive: true });
        const composePath = path.join(appDir, "compose.yaml");
        const originalCompose = ["services:", "  web:", "    image: repo/app:1", ""].join(
            "\n"
        );
        await writeFile(composePath, originalCompose, "utf8");
        const updater = await import(`./dockerUpdater.js?write-failure=${Date.now()}`);
        const service = {
            id: 1,
            app_slug: "write-failure",
            service_name: "web",
            compose_path: composePath,
            image_repo: "repo/app",
            compose_image_ref: "repo/app:1",
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
                if (writeCount === 1) {
                    originalWriteFileSync(composePath, "partial", "utf8");
                    throw new Error("disk full");
                }
                return originalWriteFileSync(...args);
            }
        );

        const result = await updater.__testing.applyServiceUpdate(service, "manual");

        assert.equal(result.ok, false);
        assert.match(result.stderr, /disk full/u);
        assert.equal(await readFile(composePath, "utf8"), originalCompose);
    });
});
