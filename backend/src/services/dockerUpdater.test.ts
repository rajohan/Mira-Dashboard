import assert from "node:assert/strict";
import fs from "node:fs";
import {
    chmod,
    mkdir,
    mkdtemp,
    readFile,
    rm,
    stat,
    symlink,
    writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, afterEach, before, beforeEach, describe, it, mock } from "node:test";

import { withEnv } from "../testUtils/env.js";

const originalDbPath = process.env.MIRA_DASHBOARD_DB_PATH;
let dbDir: string;
let dbHandle: (typeof import("../db.js"))["db"];

type StepResult = {
    code?: string;
    ok: boolean;
    stderr: string;
    stdout: string;
    step: string;
};

async function writeExecutable(filePath: string, script: string) {
    const normalizedScript = script.startsWith("#!/usr/bin/env node")
        ? `#!${process.execPath}${script.slice("#!/usr/bin/env node".length)}`
        : script;
    await writeFile(filePath, normalizedScript, "utf8");
    await chmod(filePath, 0o755);
}

function mockFetch(implementation: typeof fetch): void {
    mock.method(globalThis, "fetch", implementation);
}

function serviceRows() {
    return dbHandle
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

    before(async () => {
        dbDir = await mkdtemp(path.join(os.tmpdir(), "mira-docker-updater-db-"));
        process.env.MIRA_DASHBOARD_DB_PATH = path.join(dbDir, "test.db");
        ({ db: dbHandle } = await import("../db.js"));
    });

    after(async () => {
        dbHandle.close();
        if (originalDbPath === undefined) {
            delete process.env.MIRA_DASHBOARD_DB_PATH;
        } else {
            process.env.MIRA_DASHBOARD_DB_PATH = originalDbPath;
        }
        await rm(dbDir, { recursive: true, force: true });
    });

    beforeEach(async () => {
        tempDir = await mkdtemp(path.join(os.tmpdir(), "mira-docker-updater-"));
        originalPath = process.env.PATH;
        dbHandle.exec(
            "DELETE FROM scheduled_job_runs; DELETE FROM scheduled_jobs; DELETE FROM docker_update_events; DELETE FROM docker_managed_services; DELETE FROM notifications;"
        );
    });

    afterEach(async () => {
        mock.restoreAll();
        if (originalPath === undefined) {
            delete process.env.PATH;
        } else {
            process.env.PATH = originalPath;
        }
        dbHandle.exec(
            "DELETE FROM scheduled_job_runs; DELETE FROM scheduled_jobs; DELETE FROM docker_update_events; DELETE FROM docker_managed_services; DELETE FROM notifications;"
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
      mira.updater.tagPatternIsRegex: "true"
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
        mockFetch(async (input: string | URL | Request) => {
            const url = typeof input === "string" ? input : input.toString();
            fetchUrls.push(url);
            if (url.includes("/manifests/1.2.1")) {
                return {
                    ok: true,
                    headers: new Headers(),
                    json: async () => ({
                        manifests: [
                            {
                                digest: "sha256:amd",
                                platform: { architecture: "amd64" },
                            },
                            {
                                digest: "sha256:new",
                                platform: { architecture: "arm64", variant: null },
                            },
                        ],
                    }),
                } as Response;
            }
            if (url.includes("/tags/list?n=1000")) {
                return {
                    ok: true,
                    headers: new Headers(),
                    json: async () => ({
                        tags: ["1.1.9", "1.2.0", "1.2.1", "2.0.0"],
                    }),
                } as Response;
            }
            return {
                ok: true,
                headers: new Headers({ "docker-content-digest": "sha256:ghcr-new" }),
                json: async () => ({}),
            } as Response;
        });

        await withEnv(
            {
                MIRA_DOCKER_APPS_ROOT: appsRoot,
                MIRA_DOCKER_CALLS: dockerCalls,
            },
            async () => {
                const { runDockerUpdaterService } = await import(
                    `./dockerUpdater.js?auto=${Date.now()}`
                );
                dbHandle
                    .prepare(
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
                    )
                    .run(composePath);
                dbHandle
                    .prepare(
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
                    )
                    .run(composePath);
                const steps = (await runDockerUpdaterService()) as StepResult[];
                assert.equal(
                    steps.every((step) => step.ok),
                    true
                );
                assert.deepEqual(
                    steps.map((step) => step.step),
                    ["register-services", "poll", "auto-update:demo/web"]
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
            fetchUrls.some((url) =>
                url.includes("registry-1.docker.io/v2/library/nginx/tags/list?n=1000")
            )
        );
        assert.ok(
            fetchUrls.some((url) => url.includes("ghcr.io/v2/owner/app/manifests/stable"))
        );
        assert.match(await readFile(composePath, "utf8"), /nginx:1\.2\.1/u);
        const dockerCallLog = await readFile(dockerCalls, "utf8");
        assert.match(dockerCallLog, /compose -f .* up -d --pull always web/u);
        assert.match(dockerCallLog, /image prune -f/u);
        const notificationCount = dbHandle
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
  disabled:
    image: alpine:3
    labels:
      mira.updater.enabled: "false"
`,
            "utf8"
        );
        await writeExecutable(
            path.join(binDir, "docker"),
            "#!/usr/bin/env node\nprocess.exit(12);\n"
        );
        process.env.PATH = `${binDir}${path.delimiter}${originalPath || ""}`;
        mockFetch(async (input: string | URL | Request) => {
            const url = typeof input === "string" ? input : input.toString();
            return {
                ok: !url.includes("busybox"),
                status: 500,
                headers: new Headers(),
                json: async () => ({ tags: ["3"] }),
            } as Response;
        });

        await withEnv(
            {
                MIRA_DOCKER_APPS_ROOT: appsRoot,
            },
            async () => {
                const { __testing, runDockerUpdaterService } = await import(
                    `./dockerUpdater.js?failure=${Date.now()}`
                );
                const firstRun = await runDockerUpdaterService();
                assert.equal(firstRun[1]?.ok, true);
                assert.match(firstRun[1]?.stderr ?? "", /bad-registry/u);
                const badRegistry = dbHandle
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
                        ["register-services", true],
                        ["poll", false],
                    ]
                );

                dbHandle
                    .prepare(
                        `UPDATE docker_managed_services
                         SET latest_tag = '4',
                             latest_digest = NULL,
                             last_status = 'update_available'
                         WHERE service_name = 'missing-field'`
                    )
                    .run();
                const fullPollFailure = (await runDockerUpdaterService()) as StepResult[];
                assert.deepEqual(
                    fullPollFailure.map((step) => [step.step, step.ok]),
                    [
                        ["register-services", true],
                        ["poll", true],
                    ]
                );

                dbHandle
                    .prepare(
                        `UPDATE docker_managed_services
	                     SET latest_tag = '4', compose_image_field = NULL
	                     WHERE service_name = 'missing-field'`
                    )
                    .run();
                const service = dbHandle
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

                const disabledService = dbHandle
                    .prepare(
                        "SELECT id FROM docker_managed_services WHERE service_name = 'disabled'"
                    )
                    .get() as { id: number };
                const disabled = await runDockerUpdaterService(disabledService.id);
                assert.equal(disabled.at(-1)?.code, "DISABLED");
                assert.equal(
                    disabled.at(-1)?.stderr,
                    "Docker updater service not found or disabled"
                );
            }
        );
    });

    it("supports skipped registry checks and compose helper edge cases", async () => {
        const appsRoot = path.join(tempDir, "apps");
        const appDir = path.join(appsRoot, "helpers");
        await mkdir(appDir, { recursive: true });
        await mkdir(path.join(appsRoot, "empty"), { recursive: true });
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
  safeRegex:
    image: repo/safe:v1
    labels:
      mira.updater.tagPattern: "^v[0-9]+$$"
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
                assert.equal(services.services[2].tagMatchType, "regex");
                assert.equal(services.services[2].tagMatchPattern, "^v[0-9]+$");
                const exactCompose = path.join(tempDir, "exact-pattern.yaml");
                await writeFile(
                    exactCompose,
                    `services:
  exact:
    image: repo/exact:stable
    labels:
      mira.updater.tagPattern: latest
      mira.updater.tagPatternIsRegex: "false"
`,
                    "utf8"
                );
                const exactServices = updater.__testing.servicesFromCompose(exactCompose);
                assert.equal(exactServices.ok, true);
                assert.equal(exactServices.services[0].tagMatchType, "exact");
                assert.equal(exactServices.services[0].tagMatchPattern, "latest");
                const invalidRegexCompose = path.join(tempDir, "invalid-regex.yaml");
                await writeFile(
                    invalidRegexCompose,
                    `services:
  invalidRegex:
    image: repo/invalid:stable
    labels:
      mira.updater.tagPattern: "["
      mira.updater.tagPatternIsRegex: "true"
`,
                    "utf8"
                );
                const invalidRegex =
                    updater.__testing.servicesFromCompose(invalidRegexCompose);
                assert.equal(invalidRegex.ok, false);
                assert.match(invalidRegex.error ?? "", /Invalid tag pattern regex/u);
                const mixedCompose = path.join(tempDir, "mixed-invalid.yaml");
                await writeFile(
                    mixedCompose,
                    `services:
  valid:
    image: repo/valid:1
  invalidRegex:
    image: repo/invalid:stable
    labels:
      mira.updater.tagPattern: "["
      mira.updater.tagPatternIsRegex: "true"
  invalidImage:
    image:
      nested: value
  scalarService: disabled
`,
                    "utf8"
                );
                const mixed = updater.__testing.servicesFromCompose(mixedCompose);
                assert.equal(mixed.ok, false);
                assert.match(mixed.error ?? "", /Invalid tag pattern regex/u);
                assert.match(mixed.error ?? "", /image as a string/u);
                assert.deepEqual(
                    mixed.services.map(
                        (service: { serviceName: string }) => service.serviceName
                    ),
                    ["valid"]
                );
                const partialAppDir = path.join(appsRoot, "partial");
                await mkdir(partialAppDir, { recursive: true });
                await writeFile(
                    path.join(partialAppDir, "compose.yaml"),
                    `services:
  valid:
    image: repo/valid:1
  invalidRegex:
    image: repo/invalid:stable
    labels:
      mira.updater.tagPattern: "["
      mira.updater.tagPatternIsRegex: "true"
`,
                    "utf8"
                );
                const partialRegister = await updater.registerDockerUpdaterServices();
                assert.equal(partialRegister.ok, false);
                assert.deepEqual(
                    serviceRows()
                        .filter((service) => service.app_slug === "partial")
                        .map((service) => service.service_name),
                    ["valid"]
                );
                assert.equal(
                    updater.__testing.shouldBlockManualUpdateForDiscoveryFailure(
                        partialRegister,
                        "partial"
                    ),
                    false
                );
                const unsafeRegexCompose = path.join(tempDir, "unsafe-regex.yaml");
                await writeFile(
                    unsafeRegexCompose,
                    `services:
  unsafeRegex:
    image: repo/unsafe:stable
    labels:
      mira.updater.tagPattern: "(a+)+$"
      mira.updater.tagPatternIsRegex: "true"
`,
                    "utf8"
                );
                const unsafeRegex =
                    updater.__testing.servicesFromCompose(unsafeRegexCompose);
                assert.equal(unsafeRegex.ok, false);
                assert.match(unsafeRegex.error ?? "", /Unsafe tag pattern regex/u);
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

    it("reports malformed compose files while registering successful discoveries", async () => {
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
        dbHandle
            .prepare(
                `INSERT INTO docker_managed_services (
                app_slug, service_name, compose_path, image_repo, compose_image_ref,
                compose_image_field, current_tag, current_digest, policy, pin_mode,
                tag_match_type, tag_match_pattern, enabled, metadata_json
            ) VALUES (
                'bad', 'kept', ?, 'busybox', 'busybox:1',
                'services.kept.image', '1', NULL, 'notify', 'tag',
                'exact', '1', 1, '{}'
            )`
            )
            .run(path.join(badDir, "compose.yaml"));
        dbHandle
            .prepare(
                `INSERT INTO docker_managed_services (
                app_slug, service_name, compose_path, image_repo, compose_image_ref,
                compose_image_field, current_tag, current_digest, policy, pin_mode,
                tag_match_type, tag_match_pattern, enabled, metadata_json
            ) VALUES (
                'removed', 'old', ?, 'busybox', 'busybox:1',
                'services.old.image', '1', NULL, 'notify', 'tag',
                'exact', '1', 1, '{}'
            )`
            )
            .run(path.join(appsRoot, "removed", "compose.yaml"));

        await withEnv({ MIRA_DOCKER_APPS_ROOT: appsRoot }, async () => {
            const updater = await import(`./dockerUpdater.js?bad-compose=${Date.now()}`);
            const result = await updater.registerDockerUpdaterServices();
            assert.equal(result.ok, false);
            assert.equal(result.step, "register-services");
            assert.match(result.stderr, /bad/u);
        });

        const web = dbHandle
            .prepare(
                "SELECT current_tag, tag_match_pattern FROM docker_managed_services WHERE service_name = 'web'"
            )
            .get() as
            | undefined
            | { current_tag: string | null; tag_match_pattern: string };
        assert.equal(web?.current_tag, "latest");
        assert.equal(web?.tag_match_pattern, "latest");
        assert.equal(
            (
                dbHandle
                    .prepare(
                        "SELECT COUNT(*) AS count FROM docker_managed_services WHERE app_slug = 'bad'"
                    )
                    .get() as { count: number }
            ).count,
            1
        );
        assert.equal(
            (
                dbHandle
                    .prepare(
                        "SELECT COUNT(*) AS count FROM docker_managed_services WHERE app_slug = 'removed'"
                    )
                    .get() as { count: number }
            ).count,
            0
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
            String.raw`#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.join(" ") === "image prune -f") {
  process.stderr.write("prune failed\n");
  process.exit(12);
}
process.exit(0);
`
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
        dbHandle
            .prepare(
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
            )
            .run(service);

        const result = await updater.__testing.applyServiceUpdate(service, "manual");

        assert.equal(result.ok, true);
        assert.match(await readFile(composePath, "utf8"), /repo\/app:2@sha256:new/u);
        const row = dbHandle
            .prepare(
                `SELECT current_tag, current_digest, tag_match_pattern
                 FROM docker_managed_services WHERE id = ?`
            )
            .get(service.id) as {
            current_digest: string | null;
            current_tag: string | null;
            tag_match_pattern: string | null;
        };
        assert.equal(row.current_tag, "2");
        assert.equal(row.current_digest, "sha256:new");
        assert.equal(row.tag_match_pattern, "2");
    });

    it("does not apply an update when the locked DB row is gone", async () => {
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

        assert.equal(result.ok, false);
        assert.match(result.stderr, /not found or disabled/u);
        assert.match(await readFile(composePath, "utf8"), /repo\/app:1/u);
    });

    it("does not apply an update when the locked DB row is already current", async () => {
        const updater = await import(`./dockerUpdater.js?current=${Date.now()}`);
        const service = {
            id: 710,
            app_slug: "current",
            service_name: "web",
            compose_path: path.join(tempDir, "current", "compose.yaml"),
            image_repo: "repo/app",
            compose_image_ref: "repo/app:1",
            compose_image_field: "services.web.image",
            current_tag: "1",
            current_digest: null,
            latest_tag: "1",
            latest_digest: null,
            policy: "manual",
            pin_mode: "tag",
            tag_match_type: "exact",
            tag_match_pattern: "1",
            enabled: 1,
        };
        dbHandle
            .prepare(
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
            )
            .run(service);

        assert.deepEqual(await updater.__testing.applyServiceUpdate(service, "manual"), {
            step: "manual-update:current/web",
            ok: false,
            code: "CONFLICT",
            stdout: "",
            stderr: "No update available",
        });
    });

    it("does not apply an update when the locked DB row is disabled", async () => {
        const updater = await import(`./dockerUpdater.js?disabled=${Date.now()}`);
        const service = {
            id: 711,
            app_slug: "disabled",
            service_name: "web",
            compose_path: path.join(tempDir, "disabled", "compose.yaml"),
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
            tag_match_pattern: "2",
            enabled: 0,
        };
        dbHandle
            .prepare(
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
            )
            .run(service);

        const result = await updater.__testing.applyServiceUpdate(
            { ...service, enabled: 1 },
            "manual"
        );
        assert.equal(result.ok, false);
        assert.equal(result.code, "DISABLED");
        assert.match(result.stderr, /not found or disabled/u);
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

    it("applies updates through the parent compose project when present", async () => {
        const rootDir = path.join(tempDir, "parent-compose-apply");
        const appDir = path.join(rootDir, "apps", "web");
        const binDir = path.join(tempDir, "parent-compose-bin");
        const argsPath = path.join(tempDir, "parent-compose-args.json");
        await mkdir(appDir, { recursive: true });
        await mkdir(binDir);
        const projectComposePath = path.join(rootDir, "compose.yaml");
        const projectOverridePath = path.join(rootDir, "compose.override.yaml");
        const composePath = path.join(appDir, "compose.yaml");
        await writeFile(
            projectComposePath,
            "include:\n- apps/web/compose.yaml\n",
            "utf8"
        );
        await writeFile(
            projectOverridePath,
            [
                "services:",
                "  web:",
                "    image: repo/app:override",
                "    environment:",
                "      REQUIRED_VALUE: keep-me",
                "",
            ].join("\n"),
            "utf8"
        );
        await writeFile(
            composePath,
            [
                "services:",
                "  web:",
                "    image: repo/app:1",
                "    depends_on:",
                "      db:",
                "        condition: service_started",
                "",
            ].join("\n"),
            "utf8"
        );
        await writeExecutable(
            path.join(binDir, "docker"),
            `#!/usr/bin/env node
const fs = require("node:fs");
fs.writeFileSync(process.env.SEEN_COMPOSE_ARGS, JSON.stringify({
  argv: process.argv.slice(2),
  cwd: process.cwd(),
}));
`
        );
        process.env.PATH = `${binDir}${path.delimiter}${originalPath || ""}`;
        const updater = await import(`./dockerUpdater.js?parent-compose=${Date.now()}`);
        const service = {
            id: 712,
            app_slug: "web",
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
        dbHandle
            .prepare(
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
            )
            .run(service);
        const originalUnlinkSync = fs.unlinkSync.bind(fs);
        mock.method(fs, "unlinkSync", (filePath: fs.PathLike) => {
            if (String(filePath).includes("compose.override.yaml.rollback-")) {
                throw new Error("cleanup denied");
            }
            return originalUnlinkSync(filePath);
        });

        await withEnv({ SEEN_COMPOSE_ARGS: argsPath }, async () => {
            const result = await updater.__testing.applyServiceUpdate(service, "manual");

            assert.equal(result.ok, true);
        });

        assert.match(await readFile(composePath, "utf8"), /repo\/app:2/u);
        assert.deepEqual(JSON.parse(await readFile(argsPath, "utf8")), {
            argv: [
                "compose",
                "-f",
                projectComposePath,
                "-f",
                projectOverridePath,
                "up",
                "-d",
                "--pull",
                "always",
                "web",
            ],
            cwd: rootDir,
        });
        assert.match(await readFile(projectOverridePath, "utf8"), /repo\/app:2/u);
        assert.match(await readFile(projectOverridePath, "utf8"), /REQUIRED_VALUE/u);
    });

    it("restores parent compose overrides when aggregate updates fail", async () => {
        const rootDir = path.join(tempDir, "parent-compose-rollback");
        const appDir = path.join(rootDir, "apps", "web");
        const binDir = path.join(tempDir, "parent-compose-rollback-bin");
        await mkdir(appDir, { recursive: true });
        await mkdir(binDir);
        const projectComposePath = path.join(rootDir, "compose.yaml");
        const projectOverridePath = path.join(rootDir, "compose.override.yaml");
        const composePath = path.join(appDir, "compose.yaml");
        const originalOverride = [
            "services:",
            "  web:",
            "    image: repo/app:override",
            "    environment:",
            "      REQUIRED_VALUE: keep-me",
            "",
        ].join("\n");
        await writeFile(
            projectComposePath,
            "include:\n- apps/web/compose.yaml\n",
            "utf8"
        );
        await writeFile(projectOverridePath, originalOverride, "utf8");
        await writeFile(
            composePath,
            "services:\n  web:\n    image: repo/app:1\n",
            "utf8"
        );
        await writeExecutable(
            path.join(binDir, "docker"),
            "#!/usr/bin/env node\nprocess.stderr.write('compose failed\\n'); process.exit(12);\n"
        );
        process.env.PATH = `${binDir}${path.delimiter}${originalPath || ""}`;
        const updater = await import(
            `./dockerUpdater.js?parent-compose-rollback=${Date.now()}`
        );
        const service = {
            id: 713,
            app_slug: "web-rollback",
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
        dbHandle
            .prepare(
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
            )
            .run(service);

        const result = await updater.__testing.applyServiceUpdate(service, "manual");

        assert.equal(result.ok, false);
        assert.match(result.stderr, /compose failed/u);
        assert.equal(await readFile(projectOverridePath, "utf8"), originalOverride);
        assert.match(await readFile(composePath, "utf8"), /repo\/app:1/u);
    });

    it("keeps compose failures when parent override rollback fails", async () => {
        const rootDir = path.join(tempDir, "parent-compose-override-rollback-fails");
        const appDir = path.join(rootDir, "apps", "web");
        const binDir = path.join(tempDir, "parent-compose-override-rollback-bin");
        await mkdir(appDir, { recursive: true });
        await mkdir(binDir);
        const projectComposePath = path.join(rootDir, "compose.yaml");
        const projectOverridePath = path.join(rootDir, "compose.override.yaml");
        const composePath = path.join(appDir, "compose.yaml");
        await writeFile(
            projectComposePath,
            "include:\n- apps/web/compose.yaml\n",
            "utf8"
        );
        await writeFile(
            projectOverridePath,
            "services:\n  web:\n    image: repo/app:override\n",
            "utf8"
        );
        await writeFile(
            composePath,
            "services:\n  web:\n    image: repo/app:1\n",
            "utf8"
        );
        await writeExecutable(
            path.join(binDir, "docker"),
            "#!/usr/bin/env node\nprocess.stderr.write('compose failed\\n'); process.exit(12);\n"
        );
        process.env.PATH = `${binDir}${path.delimiter}${originalPath || ""}`;
        const updater = await import(
            `./dockerUpdater.js?parent-compose-override-rollback-fails=${Date.now()}`
        );
        const service = {
            id: 715,
            app_slug: "web-override-rollback-fails",
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
        dbHandle
            .prepare(
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
            )
            .run(service);
        const originalRenameSync = fs.renameSync.bind(fs);
        mock.method(fs, "renameSync", (...args: Parameters<typeof fs.renameSync>) => {
            if (
                String(args[0]).includes("compose.override.yaml.rollback-") &&
                args[1] === projectOverridePath
            ) {
                throw new Error("override rollback denied");
            }
            return originalRenameSync(...args);
        });

        const result = await updater.__testing.applyServiceUpdate(service, "manual");

        assert.equal(result.ok, false);
        assert.match(result.stderr, /compose failed/u);
    });

    it("ignores malformed override images while applying parent compose updates", async () => {
        const rootDir = path.join(tempDir, "parent-compose-malformed-override");
        const appDir = path.join(rootDir, "apps", "web");
        const binDir = path.join(tempDir, "parent-compose-malformed-bin");
        await mkdir(appDir, { recursive: true });
        await mkdir(binDir);
        const projectComposePath = path.join(rootDir, "compose.yaml");
        const projectOverridePath = path.join(rootDir, "compose.override.yaml");
        const composePath = path.join(appDir, "compose.yaml");
        await writeFile(
            projectComposePath,
            "include:\n- apps/web/compose.yaml\n",
            "utf8"
        );
        await writeFile(projectOverridePath, "services:\n  web: [\n", "utf8");
        await writeFile(
            composePath,
            "services:\n  web:\n    image: repo/app:1\n",
            "utf8"
        );
        await writeExecutable(path.join(binDir, "docker"), "#!/usr/bin/env node\n");
        process.env.PATH = `${binDir}${path.delimiter}${originalPath || ""}`;
        const updater = await import(
            `./dockerUpdater.js?parent-compose-malformed=${Date.now()}`
        );
        const service = {
            id: 714,
            app_slug: "web-malformed",
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
        dbHandle
            .prepare(
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
            )
            .run(service);

        const result = await updater.__testing.applyServiceUpdate(service, "manual");

        assert.equal(result.ok, true);
        assert.match(await readFile(composePath, "utf8"), /repo\/app:2/u);
        assert.equal(
            await readFile(projectOverridePath, "utf8"),
            "services:\n  web: [\n"
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
        dbHandle
            .prepare(
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
            )
            .run(baseService);
        dbHandle
            .prepare(
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
            )
            .run(workerService);

        await withEnv({ SEEN_COMPOSE_IMAGES: seenPath }, async () => {
            const first = updater.__testing.applyServiceUpdate(baseService, "manual");
            dbHandle
                .prepare(
                    "UPDATE docker_managed_services SET latest_tag = '3' WHERE id = ?"
                )
                .run(workerService.id);
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

    it("serializes concurrent compose updates for child files in the same parent project", async () => {
        const rootDir = path.join(tempDir, "locked-parent-apply");
        const appsDir = path.join(rootDir, "apps");
        const binDir = path.join(tempDir, "bin-parent-lock");
        const activePath = path.join(tempDir, "parent-compose-active.lock");
        await mkdir(path.join(appsDir, "web"), { recursive: true });
        await mkdir(path.join(appsDir, "worker"), { recursive: true });
        await mkdir(binDir);
        const projectComposePath = path.join(rootDir, "compose.yaml");
        const webComposePath = path.join(appsDir, "web", "compose.yaml");
        const workerComposePath = path.join(appsDir, "worker", "compose.yaml");
        await writeFile(
            projectComposePath,
            "include:\n- apps/web/compose.yaml\n- apps/worker/compose.yaml\n",
            "utf8"
        );
        await writeFile(
            webComposePath,
            "services:\n  web:\n    image: repo/app:1\n",
            "utf8"
        );
        await writeFile(
            workerComposePath,
            "services:\n  worker:\n    image: repo/worker:1\n",
            "utf8"
        );
        await writeExecutable(
            path.join(binDir, "docker"),
            `#!/usr/bin/env node
const fs = require("node:fs");
if (fs.existsSync(process.env.ACTIVE_PARENT_COMPOSE)) {
  process.exit(12);
}
fs.writeFileSync(process.env.ACTIVE_PARENT_COMPOSE, "active");
setTimeout(() => {
  fs.rmSync(process.env.ACTIVE_PARENT_COMPOSE, { force: true });
  process.exit(0);
}, 80);
`
        );
        process.env.PATH = `${binDir}${path.delimiter}${originalPath || ""}`;
        const updater = await import(
            `./dockerUpdater.js?locked-parent-apply=${Date.now()}`
        );
        const webService = {
            id: 81,
            app_slug: "locked-parent-web",
            service_name: "web",
            compose_path: webComposePath,
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
            ...webService,
            id: 82,
            app_slug: "locked-parent-worker",
            service_name: "worker",
            compose_path: workerComposePath,
            image_repo: "repo/worker",
            compose_image_ref: "repo/worker:1",
            compose_image_field: "services.worker.image",
        };
        const insertService = dbHandle.prepare(
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
        );
        insertService.run(webService);
        insertService.run(workerService);

        await withEnv({ ACTIVE_PARENT_COMPOSE: activePath }, async () => {
            const results = await Promise.all([
                updater.__testing.applyServiceUpdate(webService, "manual"),
                updater.__testing.applyServiceUpdate(workerService, "manual"),
            ]);

            assert.deepEqual(
                results.map((result) => result.ok),
                [true, true]
            );
        });
        assert.match(await readFile(webComposePath, "utf8"), /repo\/app:2/u);
        assert.match(await readFile(workerComposePath, "utf8"), /repo\/worker:2/u);
    });

    it("removes stale services after an empty successful compose scan", async () => {
        const appsRoot = path.join(tempDir, "empty-apps");
        await mkdir(appsRoot);
        dbHandle
            .prepare(
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
            )
            .run();

        await withEnv({ MIRA_DOCKER_APPS_ROOT: appsRoot }, async () => {
            const updater = await import(`./dockerUpdater.js?empty-root=${Date.now()}`);
            const result = await updater.registerDockerUpdaterServices();

            assert.equal(result.ok, true);
            assert.equal(serviceRows().length, 0);
        });
    });

    it("preserves registered services when the compose apps root is unavailable", async () => {
        dbHandle
            .prepare(
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
            )
            .run();

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
        dbHandle
            .prepare(
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
            )
            .run();

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

    it("fails registration when a compose file cannot be parsed", async () => {
        const appsRoot = path.join(tempDir, "apps");
        const appDir = path.join(appsRoot, "broken-app");
        const okAppDir = path.join(appsRoot, "ok-app");
        await mkdir(appDir, { recursive: true });
        await mkdir(okAppDir, { recursive: true });
        await writeFile(
            path.join(appDir, "compose.yaml"),
            "services:\n  web:\n    image: [",
            "utf8"
        );
        await writeFile(
            path.join(okAppDir, "compose.yaml"),
            "services:\n  web:\n    image: nginx:2\n",
            "utf8"
        );
        dbHandle
            .prepare(
                `INSERT INTO docker_managed_services (
                app_slug, service_name, compose_path, image_repo, compose_image_ref,
                compose_image_field, current_tag, current_digest, policy, pin_mode,
                tag_match_type, tag_match_pattern, enabled, metadata_json,
                last_checked_at, last_status
            ) VALUES (
                'broken-app', 'web', '/broken/compose.yaml', 'nginx',
                'nginx:1', 'services.web.image', '1', NULL, 'notify', 'tag',
                'exact', '1', 1, '{}', '2026-06-06T00:00:00.000Z', 'registered'
            )`
            )
            .run();

        await withEnv({ MIRA_DOCKER_APPS_ROOT: appsRoot }, async () => {
            const updater = await import(`./dockerUpdater.js?broken-app=${Date.now()}`);
            const result = await updater.registerDockerUpdaterServices();

            assert.equal(result.ok, false);
            assert.match(result.stderr, /broken-app/u);
            assert.deepEqual(
                serviceRows().map((row) => row.app_slug),
                ["broken-app", "ok-app"]
            );
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
      mira.updater.tagPatternIsRegex: "true"
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
        mockFetch(async (input: string | URL | Request) => {
            const url = typeof input === "string" ? input : input.toString();
            fetchUrls.push(url);
            return {
                ok: true,
                headers: new Headers(),
                json: async () =>
                    url.endsWith("/manifests/3")
                        ? {
                              manifests: [
                                  {
                                      digest: "sha256:new",
                                      platform: { architecture: "arm64" },
                                  },
                              ],
                          }
                        : { tags: ["1", "2", "3"] },
            } as Response;
        });

        await withEnv(
            {
                MIRA_DOCKER_APPS_ROOT: appsRoot,
                MIRA_DOCKER_UPDATER_PLATFORM: "linux/arm64",
            },
            async () => {
                const updater = await import(`./dockerUpdater.js?manual=${Date.now()}`);
                await updater.registerDockerUpdaterServices();
                const service = dbHandle
                    .prepare(
                        "SELECT id FROM docker_managed_services WHERE service_name = 'web'"
                    )
                    .get() as { id: number };
                const steps = await updater.runDockerUpdaterService(service.id);
                assert.equal(steps.at(-1)?.ok, true);
            }
        );

        assert.match(await readFile(composePath, "utf8"), /image: nginx:3/u);
        const updatedService = dbHandle
            .prepare(
                "SELECT current_tag, current_digest FROM docker_managed_services WHERE service_name = 'web'"
            )
            .get() as { current_tag: string; current_digest: string | null };
        assert.equal(updatedService.current_tag, "3");
        assert.equal(updatedService.current_digest, "sha256:new");

        await withEnv({ MIRA_DOCKER_APPS_ROOT: appsRoot }, async () => {
            const updater = await import(
                `./dockerUpdater.js?manual-fallback=${Date.now()}`
            );
            await updater.registerDockerUpdaterServices();
            const service = dbHandle
                .prepare(
                    "SELECT id, current_digest FROM docker_managed_services WHERE service_name = 'web'"
                )
                .get() as { current_digest: string | null; id: number };
            assert.equal(service.current_digest, "sha256:new");
            let deleted = false;
            mockFetch(async () => {
                if (!deleted) {
                    deleted = true;
                    dbHandle
                        .prepare(
                            "DELETE FROM docker_update_events WHERE managed_service_id = ?"
                        )
                        .run(service.id);
                    dbHandle
                        .prepare("DELETE FROM docker_managed_services WHERE id = ?")
                        .run(service.id);
                }
                return {
                    ok: true,
                    headers: new Headers(),
                    json: async () => ({ tags: ["3"] }),
                } as Response;
            });
            const missingAfterPoll = await updater.runDockerUpdaterService(service.id);
            assert.equal(
                missingAfterPoll.at(-1)?.stderr,
                "Docker updater service not found after registry poll"
            );

            await updater.registerDockerUpdaterServices();
            const toggledService = dbHandle
                .prepare(
                    "SELECT id FROM docker_managed_services WHERE service_name = 'web'"
                )
                .get() as { id: number };
            let toggled = false;
            mockFetch(async () => {
                if (!toggled) {
                    toggled = true;
                    dbHandle
                        .prepare(
                            "UPDATE docker_managed_services SET enabled = 0 WHERE id = ?"
                        )
                        .run(toggledService.id);
                }
                return {
                    ok: true,
                    headers: new Headers(),
                    json: async () => ({ tags: ["3"] }),
                } as Response;
            });
            const disabledAfterPoll = await updater.runDockerUpdaterService(
                toggledService.id
            );
            assert.equal(
                disabledAfterPoll.at(-1)?.stderr,
                "Docker updater service not found or disabled"
            );
            assert.equal(disabledAfterPoll.at(-1)?.code, "DISABLED");
        });
    });

    it("records unsupported registries during polling", async () => {
        const updater = await import(`./dockerUpdater.js?unsupported=${Date.now()}`);
        dbHandle
            .prepare(
                `INSERT INTO docker_managed_services (
                id, app_slug, service_name, compose_path, image_repo,
                compose_image_ref, compose_image_field, current_tag, current_digest,
                latest_tag, latest_digest, policy, pin_mode, tag_match_type,
                tag_match_pattern, enabled, metadata_json
            ) VALUES (
                720, 'external', 'swag', '/tmp/compose.yaml', 'quay.io/linuxserver/swag',
                'quay.io/linuxserver/swag:latest', 'services.swag.image', 'latest', NULL,
                NULL, NULL, 'notify', 'tag', 'exact', 'latest', 1, '{}'
            )`
            )
            .run();

        const result = await updater.pollDockerUpdaterRegistries(720);
        assert.equal(result.ok, true);
        assert.equal(result.stderr, "");
        const stdout = JSON.parse(result.stdout) as {
            checkedAt: string;
            checked: string[];
            ok: boolean;
            skipped: Array<{ reason: string; service: string }>;
            updates: string[];
        };
        assert.match(stdout.checkedAt, /^\d{4}-\d{2}-\d{2}T/u);
        assert.deepEqual(stdout, {
            checked: [],
            checkedAt: stdout.checkedAt,
            ok: true,
            skipped: [
                {
                    reason: "Unsupported image registry: quay.io",
                    service: "external/swag",
                },
            ],
            updates: [],
        });
        const row = dbHandle
            .prepare("SELECT last_status FROM docker_managed_services WHERE id = 720")
            .get() as { last_status: string };
        assert.equal(row.last_status, "unsupported_registry");
        const appsRoot = path.join(tempDir, "empty-apps-for-unsupported");
        await mkdir(appsRoot, { recursive: true });
        await withEnv({ MIRA_DOCKER_APPS_ROOT: appsRoot }, async () => {
            const manualSteps = (await updater.runDockerUpdaterService(
                720
            )) as StepResult[];
            assert.equal(manualSteps.at(-1)?.step, "manual-update:external/swag");
            assert.equal(manualSteps.at(-1)?.ok, false);
            assert.equal(manualSteps.at(-1)?.code, "NOT_FOUND");
        });
    });

    it("keeps global registry polls successful when only some services fail", async () => {
        const updater = await import(`./dockerUpdater.js?partial-poll=${Date.now()}`);
        const insert = dbHandle.prepare(
            `INSERT INTO docker_managed_services (
                id, app_slug, service_name, compose_path, image_repo,
                compose_image_ref, compose_image_field, current_tag, current_digest,
                latest_tag, latest_digest, policy, pin_mode, tag_match_type,
                tag_match_pattern, enabled, metadata_json
            ) VALUES (
                @id, @app_slug, 'web', '/tmp/compose.yaml', @image_repo,
                @compose_image_ref, 'services.web.image', '1', NULL,
                NULL, NULL, 'notify', 'tag', 'exact', '2', 1, '{}'
            )`
        );
        insert.run({
            id: 721,
            app_slug: "healthy",
            image_repo: "nginx",
            compose_image_ref: "nginx:1",
        });
        insert.run({
            id: 722,
            app_slug: "limited",
            image_repo: "busybox",
            compose_image_ref: "busybox:1",
        });
        mockFetch(async (input: string | URL | Request) => {
            const url = typeof input === "string" ? input : input.toString();
            if (url.includes("/library/nginx/manifests/2")) {
                return {
                    ok: true,
                    headers: new Headers(),
                    json: async () => ({
                        manifests: [
                            {
                                digest: "sha256:new",
                                platform: { architecture: "amd64" },
                            },
                        ],
                    }),
                } as Response;
            }
            return {
                ok: false,
                status: 429,
                headers: new Headers(),
                json: async () => ({}),
            } as Response;
        });

        const globalResult = await updater.pollDockerUpdaterRegistries();
        assert.equal(globalResult.ok, true);
        assert.match(globalResult.stderr, /limited\/web: HTTP 429/u);
        const globalStdout = JSON.parse(globalResult.stdout) as {
            checked: string[];
            ok: boolean;
            updates: string[];
        };
        assert.equal(globalStdout.ok, true);
        assert.deepEqual(globalStdout.checked, ["healthy/web"]);
        assert.deepEqual(globalStdout.updates, ["healthy/web"]);

        const targetedResult = await updater.pollDockerUpdaterRegistries(722);
        assert.equal(targetedResult.ok, false);
        assert.match(targetedResult.stderr, /limited\/web: HTTP 429/u);
    });

    it("does not count skipped services as successful registry checks", async () => {
        const updater = await import(`./dockerUpdater.js?skipped-poll=${Date.now()}`);
        const insert = dbHandle.prepare(
            `INSERT INTO docker_managed_services (
                id, app_slug, service_name, compose_path, image_repo,
                compose_image_ref, compose_image_field, current_tag, current_digest,
                latest_tag, latest_digest, policy, pin_mode, tag_match_type,
                tag_match_pattern, enabled, metadata_json
            ) VALUES (
                @id, @app_slug, 'web', '/tmp/compose.yaml', @image_repo,
                @compose_image_ref, 'services.web.image', '1', NULL,
                NULL, NULL, 'notify', 'tag', 'exact', '2', 1, '{}'
            )`
        );
        insert.run({
            id: 723,
            app_slug: "unsupported",
            image_repo: "quay.io/example/app",
            compose_image_ref: "quay.io/example/app:1",
        });
        insert.run({
            id: 724,
            app_slug: "limited",
            image_repo: "busybox",
            compose_image_ref: "busybox:1",
        });
        mockFetch(
            async () =>
                ({
                    ok: false,
                    status: 429,
                    headers: new Headers(),
                    json: async () => ({}),
                }) as Response
        );

        const result = await updater.pollDockerUpdaterRegistries();
        assert.equal(result.ok, false);
        assert.match(result.stderr, /limited\/web: HTTP 429/u);
        const stdout = JSON.parse(result.stdout) as {
            checked: string[];
            ok: boolean;
            skipped: Array<{ service: string }>;
        };
        assert.equal(stdout.ok, false);
        assert.deepEqual(stdout.checked, []);
        assert.deepEqual(
            stdout.skipped.map((item) => item.service),
            ["unsupported/web"]
        );
    });

    it("does not block a manual update on unrelated registry or discovery failures", async () => {
        const appsRoot = path.join(tempDir, "apps");
        const appDir = path.join(appsRoot, "manual-scope");
        const brokenAppDir = path.join(appsRoot, "broken-scope");
        const binDir = path.join(tempDir, "bin");
        await mkdir(appDir, { recursive: true });
        await mkdir(brokenAppDir, { recursive: true });
        await mkdir(binDir);
        const composePath = path.join(appDir, "compose.yaml");
        await writeFile(
            composePath,
            `services:
  target:
    image: nginx:1
    labels:
      mira.updater.tagPattern: "^[0-9]+$"
      mira.updater.tagPatternIsRegex: "true"
  broken:
    image: busybox:1
`,
            "utf8"
        );
        await writeFile(path.join(brokenAppDir, "compose.yaml"), "services: [", "utf8");
        await writeExecutable(
            path.join(binDir, "docker"),
            "#!/usr/bin/env node\nprocess.exit(0);\n"
        );
        dbHandle
            .prepare(
                `INSERT INTO docker_managed_services (
                app_slug, service_name, compose_path, image_repo, compose_image_ref,
                compose_image_field, current_tag, current_digest, policy, pin_mode,
                tag_match_type, tag_match_pattern, enabled, metadata_json,
                latest_tag, latest_digest, last_checked_at, last_status
            ) VALUES (
                'broken-auto-scope', 'target', ?, 'nginx',
                'nginx:1', 'services.target.image', '1', 'sha256:old', 'auto', 'tag',
                'regex', '^[0-9]+$', 1, '{}', '2', 'sha256:new',
                '2026-06-06T00:00:00.000Z', 'update_available'
            )`
            )
            .run(path.join(brokenAppDir, "compose.yaml"));
        process.env.PATH = `${binDir}${path.delimiter}${originalPath || ""}`;
        mockFetch(async (input: string | URL | Request) => {
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
                    url.endsWith("/manifests/2")
                        ? {
                              manifests: [
                                  {
                                      digest: "sha256:new",
                                      platform: { architecture: "arm64" },
                                  },
                              ],
                          }
                        : { tags: ["1", "2"] },
            } as Response;
        });

        await withEnv({ MIRA_DOCKER_APPS_ROOT: appsRoot }, async () => {
            const updater = await import(`./dockerUpdater.js?manual-scope=${Date.now()}`);
            assert.deepEqual(
                [...updater.__testing.failedDiscoveryAppSlugs({ stderr: "" })],
                []
            );
            assert.deepEqual(
                [
                    ...updater.__testing.failedDiscoveryAppSlugs({
                        stderr: JSON.stringify({
                            failed: [
                                { appSlug: "selected" },
                                { appSlug: "partial", blocking: false },
                                { appSlug: 123 },
                                {},
                            ],
                        }),
                    }),
                ],
                ["selected"]
            );
            assert.deepEqual(
                [
                    ...updater.__testing.failedDiscoveryAppSlugs({
                        stderr: JSON.stringify({ ok: false }),
                    }),
                ],
                []
            );
            assert.deepEqual(
                [
                    ...updater.__testing.failedDiscoveryAppSlugs({
                        stderr: "not json",
                    }),
                ],
                ["*"]
            );
            assert.equal(
                updater.__testing.shouldBlockManualUpdateForDiscoveryFailure(
                    {
                        step: "register-services",
                        ok: true,
                        code: null,
                        stdout: "",
                        stderr: "",
                    },
                    "selected"
                ),
                false
            );
            assert.equal(
                updater.__testing.shouldBlockManualUpdateForDiscoveryFailure(
                    {
                        step: "register-services",
                        ok: false,
                        code: "PARTIAL_FAILURE",
                        stdout: "",
                        stderr: JSON.stringify({ failed: [{ appSlug: "selected" }] }),
                    },
                    "selected"
                ),
                true
            );
            await updater.registerDockerUpdaterServices();
            const service = dbHandle
                .prepare(
                    "SELECT id FROM docker_managed_services WHERE service_name = 'target'"
                )
                .get() as { id: number };
            const steps = (await updater.runDockerUpdaterService(
                service.id
            )) as StepResult[];
            assert.equal(steps[0]?.step, "register-services");
            assert.equal(steps[0]?.ok, false);
            assert.equal(steps.at(-1)?.step, "manual-update:manual-scope/target");
            assert.equal(steps.at(-1)?.ok, true);
        });

        assert.match(await readFile(composePath, "utf8"), /image: nginx:2/u);
    });

    it("continues auto updates for healthy apps after unrelated discovery failures", async () => {
        const appsRoot = path.join(tempDir, "apps");
        const appDir = path.join(appsRoot, "auto-scope");
        const brokenAppDir = path.join(appsRoot, "broken-auto-scope");
        const binDir = path.join(tempDir, "bin");
        await mkdir(appDir, { recursive: true });
        await mkdir(brokenAppDir, { recursive: true });
        await mkdir(binDir);
        const composePath = path.join(appDir, "compose.yaml");
        await writeFile(
            composePath,
            `services:
  target:
    image: nginx:1
    labels:
      mira.updater.autoUpdate: "true"
      mira.updater.tagPattern: "^[0-9]+$"
      mira.updater.tagPatternIsRegex: "true"
`,
            "utf8"
        );
        await writeFile(path.join(brokenAppDir, "compose.yaml"), "services: [", "utf8");
        await writeExecutable(
            path.join(binDir, "docker"),
            "#!/usr/bin/env node\nprocess.exit(0);\n"
        );
        process.env.PATH = `${binDir}${path.delimiter}${originalPath || ""}`;
        mockFetch(async (input: string | URL | Request) => {
            const url = typeof input === "string" ? input : input.toString();
            return {
                ok: true,
                headers: new Headers(),
                json: async () =>
                    url.endsWith("/manifests/2")
                        ? {
                              manifests: [
                                  {
                                      digest: "sha256:new",
                                      platform: { architecture: "amd64" },
                                  },
                              ],
                          }
                        : { tags: ["1", "2"] },
            } as Response;
        });

        await withEnv({ MIRA_DOCKER_APPS_ROOT: appsRoot }, async () => {
            const updater = await import(`./dockerUpdater.js?auto-scope=${Date.now()}`);
            const steps = (await updater.runDockerUpdaterService()) as StepResult[];
            assert.equal(steps[0]?.step, "register-services");
            assert.equal(steps[0]?.ok, false);
            assert.equal(steps[1]?.step, "poll");
            assert.equal(steps[1]?.ok, true);
            assert.equal(steps.at(-1)?.step, "auto-update:auto-scope/target");
            assert.equal(steps.at(-1)?.ok, true);
            assert.equal(
                steps.some(
                    (step) => step.step === "auto-update:broken-auto-scope/target"
                ),
                false
            );
            assert.equal(
                updater.__testing.shouldBlockGlobalUpdateForDiscoveryFailure(steps[0]),
                false
            );
        });

        assert.match(await readFile(composePath, "utf8"), /image: nginx:2/u);
    });

    it("blocks a manual update when discovery cannot classify failed apps", async () => {
        const appsRoot = path.join(tempDir, "apps");
        const appDir = path.join(appsRoot, "unavailable-apps-root");
        await mkdir(appDir, { recursive: true });
        const composePath = path.join(appDir, "compose.yaml");
        await writeFile(
            composePath,
            `services:
  target:
    image: nginx:1
    labels:
      mira.updater.tagPattern: "^[0-9]+$"
      mira.updater.tagPatternIsRegex: "true"
`,
            "utf8"
        );

        await withEnv({ MIRA_DOCKER_APPS_ROOT: appsRoot }, async () => {
            const updater = await import(
                `./dockerUpdater.js?unavailable-apps-root=${Date.now()}`
            );
            await updater.registerDockerUpdaterServices();
            const service = dbHandle
                .prepare(
                    "SELECT id FROM docker_managed_services WHERE service_name = 'target'"
                )
                .get() as { id: number };
            await rm(appsRoot, { recursive: true, force: true });
            await writeFile(appsRoot, "not a directory", "utf8");
            const steps = (await updater.runDockerUpdaterService(
                service.id
            )) as StepResult[];
            assert.equal(steps[0]?.step, "register-services");
            assert.equal(steps[0]?.ok, false);
            assert.equal(
                steps.at(-1)?.step,
                "manual-update:unavailable-apps-root/target"
            );
            assert.equal(steps.at(-1)?.ok, false);
            assert.equal(steps.at(-1)?.code, "CONFLICT");
            assert.equal(
                steps.at(-1)?.stderr,
                "Docker updater discovery failed for the selected service"
            );
        });
    });

    it("keeps discovery failure conflicts when registration loses the selected service", async () => {
        const appsRoot = path.join(tempDir, "apps");
        const appDir = path.join(appsRoot, "failed-selected");
        await mkdir(appDir, { recursive: true });
        const composePath = path.join(appDir, "compose.yaml");
        await writeFile(composePath, "services:\n  target: [unterminated\n", "utf8");
        dbHandle
            .prepare(
                `INSERT INTO docker_managed_services (
                id, app_slug, service_name, compose_path, image_repo,
                compose_image_ref, compose_image_field, current_tag, current_digest,
                latest_tag, latest_digest, policy, pin_mode, tag_match_type,
                tag_match_pattern, enabled, metadata_json
            ) VALUES (
                762, 'failed-selected', 'target', ?, 'nginx',
                'nginx:1', 'services.target.image', '1', NULL,
                '2', NULL, 'notify', 'tag', 'exact', '1', 1, '{}'
            )`
            )
            .run(composePath);

        await withEnv({ MIRA_DOCKER_APPS_ROOT: appsRoot }, async () => {
            const updater = await import(
                `./dockerUpdater.js?failed-selected=${Date.now()}`
            );
            const originalPrepare = dbHandle.prepare.bind(dbHandle);
            let selectedServiceLookups = 0;
            const prepareMock = mock.method(dbHandle, "prepare", (sql: string) => {
                if (
                    sql === "SELECT * FROM docker_managed_services WHERE id = ? LIMIT 1"
                ) {
                    selectedServiceLookups += 1;
                    if (selectedServiceLookups === 2) {
                        return {
                            get: () => {},
                        } as unknown as ReturnType<typeof dbHandle.prepare>;
                    }
                }
                const statement = originalPrepare(sql);
                return statement;
            });
            try {
                const steps = (await updater.runDockerUpdaterService(
                    762
                )) as StepResult[];
                assert.equal(steps[0]?.step, "register-services");
                assert.equal(steps[0]?.ok, false);
                assert.equal(steps.at(-1)?.step, "manual-update:failed-selected/target");
                assert.equal(steps.at(-1)?.ok, false);
                assert.equal(steps.at(-1)?.code, "CONFLICT");
                assert.equal(
                    steps.at(-1)?.stderr,
                    "Docker updater discovery failed for the selected service"
                );
            } finally {
                prepareMock.mock.restore();
            }
        });
    });

    it("reports unsupported registries for registered manual services", async () => {
        const appsRoot = path.join(tempDir, "apps");
        const appDir = path.join(appsRoot, "unsupported-compose");
        await mkdir(appDir, { recursive: true });
        await writeFile(
            path.join(appDir, "compose.yaml"),
            `services:
  swag:
    image: quay.io/linuxserver/swag:latest
    labels:
      mira.updater.tagPattern: "latest"
`,
            "utf8"
        );

        await withEnv({ MIRA_DOCKER_APPS_ROOT: appsRoot }, async () => {
            const updater = await import(
                `./dockerUpdater.js?unsupported-compose=${Date.now()}`
            );
            await updater.registerDockerUpdaterServices();
            const service = dbHandle
                .prepare(
                    "SELECT id FROM docker_managed_services WHERE service_name = 'swag'"
                )
                .get() as { id: number };
            const steps = (await updater.runDockerUpdaterService(
                service.id
            )) as StepResult[];
            assert.equal(steps.at(-1)?.step, "manual-update:unsupported-compose/swag");
            assert.equal(steps.at(-1)?.ok, false);
            assert.equal(steps.at(-1)?.code, "UNSUPPORTED_REGISTRY");
        });
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
    image: nginx:1@sha256:same-tag
    labels:
      mira.updater.tagPattern: "^[0-9]+$"
      mira.updater.tagPatternIsRegex: "true"
`,
            "utf8"
        );
        await writeExecutable(
            path.join(binDir, "docker"),
            "#!/usr/bin/env node\nprocess.stdout.write('unexpected apply\\n');\n"
        );
        process.env.PATH = `${binDir}${path.delimiter}${originalPath || ""}`;
        mockFetch(async (input: string | URL | Request) => {
            const url = typeof input === "string" ? input : input.toString();
            return {
                ok: true,
                headers: new Headers(),
                json: async () =>
                    url.endsWith("/manifests/1")
                        ? { digest: "sha256:same-tag" }
                        : { tags: ["1"] },
            } as Response;
        });

        await withEnv({ MIRA_DOCKER_APPS_ROOT: appsRoot }, async () => {
            const updater = await import(
                `./dockerUpdater.js?manual-current=${Date.now()}`
            );
            await updater.registerDockerUpdaterServices();
            const service = dbHandle
                .prepare(
                    "SELECT id FROM docker_managed_services WHERE service_name = 'target'"
                )
                .get() as { id: number };
            dbHandle
                .prepare(
                    `UPDATE docker_managed_services
                     SET current_digest = 'sha256:same-tag',
                         latest_tag = '2', latest_digest = 'sha256:stale',
                         last_status = 'update_available'
                 WHERE id = ?`
                )
                .run(service.id);

            const steps = (await updater.runDockerUpdaterService(
                service.id
            )) as StepResult[];
            assert.deepEqual(
                steps.map((step) => step.step),
                [
                    "register-services",
                    "poll",
                    "manual-update-skipped:manual-current/target",
                ]
            );
            assert.equal(steps.at(-1)?.ok, false);
            assert.equal(steps.at(-1)?.code, "CONFLICT");
            const row = dbHandle
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

        assert.match(
            await readFile(composePath, "utf8"),
            /image: nginx:1@sha256:same-tag/u
        );
    });

    it("reports a disabled manual service after a successful fresh poll", async () => {
        const appsRoot = path.join(tempDir, "apps");
        const appDir = path.join(appsRoot, "manual-disabled-after-poll");
        const binDir = path.join(tempDir, "bin");
        await mkdir(appDir, { recursive: true });
        await mkdir(binDir);
        await writeFile(
            path.join(appDir, "compose.yaml"),
            `services:
  target:
    image: nginx:1
    labels:
      mira.updater.tagPattern: "^[0-9]+$"
      mira.updater.tagPatternIsRegex: "true"
`,
            "utf8"
        );
        await writeExecutable(
            path.join(binDir, "docker"),
            "#!/usr/bin/env node\nprocess.stdout.write('unexpected apply\\n');\n"
        );
        process.env.PATH = `${binDir}${path.delimiter}${originalPath || ""}`;

        await withEnv({ MIRA_DOCKER_APPS_ROOT: appsRoot }, async () => {
            const updater = await import(
                `./dockerUpdater.js?manual-disabled-after-poll=${Date.now()}`
            );
            await updater.registerDockerUpdaterServices();
            const service = dbHandle
                .prepare(
                    "SELECT id FROM docker_managed_services WHERE service_name = 'target'"
                )
                .get() as { id: number };
            let disabled = false;
            mockFetch(async (input: string | URL | Request) => {
                const url = typeof input === "string" ? input : input.toString();
                if (!disabled) {
                    disabled = true;
                    dbHandle
                        .prepare(
                            "UPDATE docker_managed_services SET enabled = 0 WHERE id = ?"
                        )
                        .run(service.id);
                }
                return {
                    ok: true,
                    headers: new Headers(),
                    json: async () =>
                        url.endsWith("/manifests/2")
                            ? { digest: "sha256:new" }
                            : { tags: ["1", "2"] },
                } as Response;
            });

            const steps = (await updater.runDockerUpdaterService(
                service.id
            )) as StepResult[];
            assert.deepEqual(
                steps.map((step) => [step.step, step.ok, step.code]),
                [
                    ["register-services", true, undefined],
                    ["poll", true, undefined],
                    [
                        "manual-update:manual-disabled-after-poll/target",
                        false,
                        "DISABLED",
                    ],
                ]
            );
        });
    });

    it("keeps update results when event and notification persistence fail", async () => {
        const appDir = path.join(tempDir, "best-effort-persistence");
        const binDir = path.join(tempDir, "bin");
        await mkdir(appDir, { recursive: true });
        await mkdir(binDir);
        const composePath = path.join(appDir, "compose.yaml");
        await writeFile(
            composePath,
            `services:
  target:
    image: nginx:1
`,
            "utf8"
        );
        await writeExecutable(
            path.join(binDir, "docker"),
            "#!/usr/bin/env node\nprocess.stdout.write('updated\\n');\n"
        );
        process.env.PATH = `${binDir}${path.delimiter}${originalPath || ""}`;
        mockFetch(async (input: string | URL | Request) => {
            const url = typeof input === "string" ? input : input.toString();
            return {
                ok: true,
                headers: new Headers(),
                json: async () =>
                    url.endsWith("/manifests/2")
                        ? {
                              manifests: [
                                  {
                                      digest: "sha256:new",
                                      platform: {
                                          architecture:
                                              process.arch === "x64"
                                                  ? "amd64"
                                                  : process.arch,
                                          os: "linux",
                                      },
                                  },
                              ],
                          }
                        : { tags: ["1", "2"] },
            } as Response;
        });

        const consoleErrorMock = mock.method(console, "error", () => {});
        dbHandle
            .prepare(
                `INSERT INTO docker_managed_services (
                app_slug, service_name, compose_path, image_repo,
                compose_image_ref, compose_image_field, current_tag, current_digest,
                latest_tag, latest_digest, policy, pin_mode, tag_match_type,
                tag_match_pattern, enabled, metadata_json
            ) VALUES (
                'best-effort-persistence', 'target', ?, 'nginx', 'nginx:1',
                'services.target.image', '1', 'sha256:old', NULL, NULL, 'notify',
                'tag', 'regex', '^[0-9]+$', 1, '{}'
            )`
            )
            .run(composePath);
        dbHandle.exec(`
            CREATE TEMP TRIGGER docker_update_events_fail
            BEFORE INSERT ON docker_update_events
            BEGIN
                SELECT RAISE(FAIL, 'event persistence failed');
            END;
            CREATE TEMP TRIGGER notifications_fail
            BEFORE INSERT ON notifications
            BEGIN
                SELECT RAISE(FAIL, 'notification persistence failed');
            END;
        `);
        try {
            const updater = await import(
                `./dockerUpdater.js?best-effort-persistence=${Date.now()}`
            );
            const poll = await updater.pollDockerUpdaterRegistries();
            assert.equal(poll.ok, true);
            const service = dbHandle
                .prepare(
                    "SELECT * FROM docker_managed_services WHERE service_name = 'target'"
                )
                .get();
            const apply = await updater.__testing.applyServiceUpdate(service, "manual");
            assert.equal(apply.ok, true);
            assert.equal(consoleErrorMock.mock.callCount(), 4);
        } finally {
            dbHandle.exec(`
                DROP TRIGGER IF EXISTS docker_update_events_fail;
                DROP TRIGGER IF EXISTS notifications_fail;
            `);
            consoleErrorMock.mock.restore();
        }
    });

    it("only records update notifications when an available update changes", async () => {
        const appsRoot = path.join(tempDir, "apps");
        const appDir = path.join(appsRoot, "update-transition");
        await mkdir(appDir, { recursive: true });
        await writeFile(
            path.join(appDir, "compose.yaml"),
            `services:
  target:
    image: nginx:1
    labels:
      mira.updater.tagPattern: "^[0-9]+$"
      mira.updater.tagPatternIsRegex: "true"
`,
            "utf8"
        );
        mockFetch(async (input: string | URL | Request) => {
            const url = typeof input === "string" ? input : input.toString();
            return {
                ok: true,
                headers: new Headers(),
                json: async () =>
                    url.endsWith("/manifests/2")
                        ? {
                              manifests: [
                                  {
                                      digest: "sha256:new",
                                      platform: { architecture: "amd64" },
                                  },
                              ],
                          }
                        : { tags: ["1", "2"] },
            } as Response;
        });

        await withEnv({ MIRA_DOCKER_APPS_ROOT: appsRoot }, async () => {
            const updater = await import(`./dockerUpdater.js?transition=${Date.now()}`);
            await updater.registerDockerUpdaterServices();

            const firstPoll = await updater.pollDockerUpdaterRegistries();
            const secondPoll = await updater.pollDockerUpdaterRegistries();

            assert.equal(firstPoll.ok, true);
            assert.equal(secondPoll.ok, true);
            assert.equal(
                (
                    dbHandle
                        .prepare(
                            "SELECT COUNT(*) AS count FROM docker_update_events WHERE event_type = 'update_available'"
                        )
                        .get() as { count: number }
                ).count,
                1
            );
            assert.equal(
                (
                    dbHandle
                        .prepare(
                            "SELECT COUNT(*) AS count FROM notifications WHERE dedupe_key = 'docker:updater:updates-available'"
                        )
                        .get() as { count: number }
                ).count,
                1
            );
        });
    });

    it("registers the scheduled Docker updater job", async () => {
        const updater = await import(`./dockerUpdater.js?schedule=${Date.now()}`);
        const scheduledJobs = await import("./scheduledJobs.js");
        scheduledJobs.__testing.clearActionHandlers();
        const appsRoot = path.join(tempDir, "scheduled-apps");
        await mkdir(appsRoot);

        await withEnv({ MIRA_DOCKER_APPS_ROOT: appsRoot }, async () => {
            updater.registerDockerUpdaterScheduledJobs();

            const row = dbHandle
                .prepare(
                    `SELECT id, enabled, schedule_type, interval_seconds, time_of_day, action_key
                 FROM scheduled_jobs WHERE id = 'docker.updater'`
                )
                .get() as
                | undefined
                | {
                      action_key: string;
                      enabled: number;
                      id: string;
                      interval_seconds: number;
                      schedule_type: string;
                      time_of_day: string | null;
                  };
            assert.ok(row);
            assert.equal(row.id, "docker.updater");
            assert.equal(row.enabled, 1);
            assert.equal(row.schedule_type, "daily");
            assert.equal(row.interval_seconds, 86_400);
            assert.equal(row.time_of_day, "04:10");
            assert.equal(row.action_key, "docker.updater");

            dbHandle
                .prepare(
                    `UPDATE scheduled_jobs
                     SET schedule_type = 'interval',
                         interval_seconds = 3600,
                         time_of_day = NULL,
                         cron_expression = NULL
                     WHERE id = 'docker.updater'`
                )
                .run();
            updater.registerDockerUpdaterScheduledJobs();
            const migratedRow = dbHandle
                .prepare(
                    `SELECT schedule_type, interval_seconds, time_of_day
                     FROM scheduled_jobs WHERE id = 'docker.updater'`
                )
                .get() as {
                interval_seconds: number;
                schedule_type: string;
                time_of_day: string | null;
            };
            assert.equal(migratedRow.schedule_type, "daily");
            assert.equal(migratedRow.interval_seconds, 86_400);
            assert.equal(migratedRow.time_of_day, "04:10");

            const run = await scheduledJobs.runScheduledJob("docker.updater", "manual");
            assert.equal(run.status, "success");
            assert.deepEqual(
                (run.output.steps as StepResult[]).map((step) => step.step),
                ["register-services", "poll"]
            );

            const partialAppDir = path.join(appsRoot, "partial");
            await mkdir(partialAppDir);
            await writeFile(
                path.join(partialAppDir, "compose.yaml"),
                `services:
  valid-disabled:
    image: repo/valid:1
    labels:
      mira.updater.enabled: "false"
  invalidRegex:
    image: repo/invalid:stable
    labels:
      mira.updater.tagPattern: "["
      mira.updater.tagPatternIsRegex: "true"
`,
                "utf8"
            );

            const partialRun = await scheduledJobs.runScheduledJob(
                "docker.updater",
                "manual"
            );
            assert.equal(partialRun.status, "success");
            const partialSteps = partialRun.output.steps as StepResult[];
            assert.equal(partialSteps[0]?.step, "register-services");
            assert.equal(partialSteps[0]?.ok, false);
            assert.equal(partialSteps[1]?.step, "poll");
            assert.equal(partialSteps[1]?.ok, true);

            await rm(appsRoot, { recursive: true, force: true });
            const failedRun = await scheduledJobs.runScheduledJob(
                "docker.updater",
                "manual"
            );
            assert.equal(failedRun.status, "failed");
            assert.match(failedRun.message ?? "", /Compose apps root not found/u);
        });

        const originalPrepare = dbHandle.prepare.bind(dbHandle);
        const prepareMock = mock.method(dbHandle, "prepare", (sql: string) => {
            if (sql.startsWith("DELETE FROM scheduled_jobs")) {
                throw new Error("prune failed");
            }
            return originalPrepare(sql);
        });
        try {
            assert.throws(
                () => updater.registerDockerUpdaterScheduledJobs(),
                /prune failed/u
            );
        } finally {
            prepareMock.mock.restore();
        }
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
        await withEnv(
            {
                COMPOSE_EMPTY: "",
                COMPOSE_LOOP: "${COMPOSE_LOOP}x",
                COMPOSE_SET: "apps/app/compose.yaml",
            },
            async () => {
                assert.equal(
                    updater.__testing.interpolateComposePath("${COMPOSE_SET}"),
                    "apps/app/compose.yaml"
                );
                assert.equal(
                    updater.__testing.interpolateComposePath("$COMPOSE_SET"),
                    "apps/app/compose.yaml"
                );
                assert.equal(
                    updater.__testing.interpolateComposePath("$COMPOSE_MISSING"),
                    "$COMPOSE_MISSING"
                );
                assert.equal(
                    updater.__testing.interpolateComposePath("${COMPOSE_MISSING}"),
                    "${COMPOSE_MISSING}"
                );
                assert.equal(
                    updater.__testing.interpolateComposePath(
                        "${COMPOSE_MISSING:-fallback.yaml}"
                    ),
                    "fallback.yaml"
                );
                assert.equal(
                    updater.__testing.interpolateComposePath(
                        "${COMPOSE_MISSING:-${COMPOSE_SET}}"
                    ),
                    "apps/app/compose.yaml"
                );
                assert.equal(
                    updater.__testing.interpolateComposePath("${COMPOSE_LOOP}"),
                    "${COMPOSE_LOOP}xxxxxxxx"
                );
                assert.equal(
                    updater.__testing.interpolateComposePath(
                        "${COMPOSE_EMPTY-default.yaml}"
                    ),
                    ""
                );
                assert.equal(
                    updater.__testing.interpolateComposePath("${COMPOSE_SET:+alt.yaml}"),
                    "alt.yaml"
                );
                assert.equal(
                    updater.__testing.interpolateComposePath(
                        "${COMPOSE_EMPTY:+alt.yaml}"
                    ),
                    ""
                );
                assert.equal(
                    updater.__testing.interpolateComposePath("${COMPOSE_EMPTY+alt.yaml}"),
                    "alt.yaml"
                );
                assert.equal(
                    updater.__testing.interpolateComposePath("${COMPOSE_SET:?required}"),
                    "apps/app/compose.yaml"
                );
                assert.equal(
                    updater.__testing.interpolateComposePath(
                        "${COMPOSE_MISSING:?required}"
                    ),
                    "${COMPOSE_MISSING:?required}"
                );
            }
        );
        const helperEnvRoot = path.join(tempDir, "helper-env-root");
        await mkdir(helperEnvRoot, { recursive: true });
        await writeFile(
            path.join(helperEnvRoot, ".env"),
            "APP_COMPOSE=apps/env-app\nFROM_DOTENV=base\n",
            "utf8"
        );
        await writeFile(
            path.join(helperEnvRoot, "compose.env"),
            "FROM_DOTENV=override\nFROM_ENV_FILE=value\n",
            "utf8"
        );
        await writeFile(
            path.join(helperEnvRoot, "absolute.env"),
            "FROM_ABSOLUTE_ENV=absolute\n",
            "utf8"
        );
        assert.deepEqual(
            updater.__testing.loadComposeProjectEnv(helperEnvRoot, [
                "compose.env",
                path.join(helperEnvRoot, "absolute.env"),
            ]),
            {
                APP_COMPOSE: "apps/env-app",
                FROM_ABSOLUTE_ENV: "absolute",
                FROM_DOTENV: "override",
                FROM_ENV_FILE: "value",
            }
        );
        const brokenEnvRoot = path.join(tempDir, "broken-helper-env-root");
        await mkdir(path.join(brokenEnvRoot, ".env"), { recursive: true });
        assert.deepEqual(updater.__testing.loadComposeProjectEnv(brokenEnvRoot), {});
        assert.equal(
            updater.__testing.stripRegistry("docker.io/library/redis"),
            "library/redis"
        );
        assert.equal(
            updater.__testing.stripRegistry("index.docker.io/library/redis"),
            "library/redis"
        );
        assert.equal(updater.__testing.stripRegistry("ghcr.io/owner/app"), "owner/app");
        assert.equal(
            updater.__testing.stripRegistry("lscr.io/linuxserver/swag"),
            "linuxserver/swag"
        );
        await withEnv(
            {
                MIRA_DOCKER_COMPOSE_WRAPPER: "/tmp/mira-compose-wrapper",
            },
            async () => {
                assert.deepEqual(
                    updater.__testing.getComposeCommand("/srv/app/compose.yaml", "web"),
                    {
                        file: "/tmp/mira-compose-wrapper",
                        args: [
                            "-f",
                            "/srv/app/compose.yaml",
                            "up",
                            "-d",
                            "--pull",
                            "always",
                            "web",
                        ],
                        cwd: "/srv/app",
                    }
                );
            }
        );
        const nestedRoot = path.join(tempDir, "nested-compose-root");
        const nestedComposePath = path.join(nestedRoot, "apps", "app", "compose.yaml");
        const projectComposePath = path.join(nestedRoot, "compose.yaml");
        await mkdir(path.dirname(nestedComposePath), { recursive: true });
        await writeFile(
            projectComposePath,
            "include:\n- apps/app/compose.yaml\n",
            "utf8"
        );
        await writeFile(nestedComposePath, "services: {}\n", "utf8");
        await withEnv(
            {
                MIRA_DOCKER_COMPOSE_WRAPPER: "/tmp/mira-compose-wrapper",
            },
            async () => {
                assert.deepEqual(
                    updater.__testing.getComposeCommand(nestedComposePath, "web"),
                    {
                        file: "/tmp/mira-compose-wrapper",
                        args: [
                            "-f",
                            projectComposePath,
                            "up",
                            "-d",
                            "--pull",
                            "always",
                            "web",
                        ],
                        cwd: nestedRoot,
                    }
                );
            }
        );
        const interpolatedIncludeRoot = path.join(tempDir, "interpolated-include-root");
        const interpolatedIncludeComposePath = path.join(
            interpolatedIncludeRoot,
            "apps",
            "app",
            "compose.yaml"
        );
        await mkdir(path.dirname(interpolatedIncludeComposePath), { recursive: true });
        await writeFile(
            path.join(interpolatedIncludeRoot, "compose.yaml"),
            "include:\n- ${APP_COMPOSE_PATH:-apps/app/compose.yaml}\n",
            "utf8"
        );
        await writeFile(interpolatedIncludeComposePath, "services: {}\n", "utf8");
        await withEnv(
            {
                MIRA_DOCKER_COMPOSE_WRAPPER: "/tmp/mira-compose-wrapper",
            },
            async () => {
                assert.equal(
                    updater.__testing.getComposeCommand(
                        interpolatedIncludeComposePath,
                        "web"
                    ).cwd,
                    interpolatedIncludeRoot
                );
            }
        );
        const envIncludeRoot = path.join(tempDir, "env-include-root");
        const envIncludeComposePath = path.join(
            envIncludeRoot,
            "apps",
            "env-app",
            "compose.yaml"
        );
        await mkdir(path.dirname(envIncludeComposePath), { recursive: true });
        await writeFile(
            path.join(envIncludeRoot, ".env"),
            "APP_COMPOSE=apps/env-app\n",
            "utf8"
        );
        await writeFile(
            path.join(envIncludeRoot, "compose.yaml"),
            "include:\n- ${APP_COMPOSE}/compose.yaml\n",
            "utf8"
        );
        await writeFile(envIncludeComposePath, "services: {}\n", "utf8");
        await withEnv(
            {
                APP_COMPOSE: undefined,
                MIRA_DOCKER_COMPOSE_WRAPPER: "/tmp/mira-compose-wrapper",
            },
            async () => {
                assert.equal(
                    updater.__testing.getComposeCommand(envIncludeComposePath, "web").cwd,
                    envIncludeRoot
                );
            }
        );
        const unbracedEnvIncludeRoot = path.join(tempDir, "unbraced-env-include-root");
        const unbracedEnvIncludeComposePath = path.join(
            unbracedEnvIncludeRoot,
            "apps",
            "env-app",
            "compose.yaml"
        );
        await mkdir(path.dirname(unbracedEnvIncludeComposePath), { recursive: true });
        await writeFile(
            path.join(unbracedEnvIncludeRoot, ".env"),
            "APP_COMPOSE=apps/env-app\n",
            "utf8"
        );
        await writeFile(
            path.join(unbracedEnvIncludeRoot, "compose.yaml"),
            "include:\n- $APP_COMPOSE/compose.yaml\n",
            "utf8"
        );
        await writeFile(unbracedEnvIncludeComposePath, "services: {}\n", "utf8");
        await withEnv(
            {
                APP_COMPOSE: undefined,
                MIRA_DOCKER_COMPOSE_WRAPPER: "/tmp/mira-compose-wrapper",
            },
            async () => {
                assert.equal(
                    updater.__testing.getComposeCommand(
                        unbracedEnvIncludeComposePath,
                        "web"
                    ).cwd,
                    unbracedEnvIncludeRoot
                );
            }
        );
        const envFileIncludeRoot = path.join(tempDir, "env-file-include-root");
        const envFileIncludeComposePath = path.join(
            envFileIncludeRoot,
            "apps",
            "env-file-app",
            "compose.yaml"
        );
        await mkdir(path.dirname(envFileIncludeComposePath), { recursive: true });
        await writeFile(
            path.join(envFileIncludeRoot, "include.env"),
            "APP_COMPOSE=apps/env-file-app\n",
            "utf8"
        );
        await writeFile(
            path.join(envFileIncludeRoot, ".env"),
            "INCLUDE_ENV=include.env\n",
            "utf8"
        );
        await writeFile(
            path.join(envFileIncludeRoot, "compose.yaml"),
            "include:\n- path: ${APP_COMPOSE}/compose.yaml\n  env_file: ${INCLUDE_ENV}\n",
            "utf8"
        );
        await writeFile(envFileIncludeComposePath, "services: {}\n", "utf8");
        await withEnv(
            {
                APP_COMPOSE: undefined,
                INCLUDE_ENV: undefined,
                MIRA_DOCKER_COMPOSE_WRAPPER: "/tmp/mira-compose-wrapper",
            },
            async () => {
                assert.equal(
                    updater.__testing.getComposeCommand(envFileIncludeComposePath, "web")
                        .cwd,
                    envFileIncludeRoot
                );
            }
        );
        const localEnvPrecedenceRoot = path.join(tempDir, "local-env-precedence-root");
        const localEnvPrecedenceComposePath = path.join(
            localEnvPrecedenceRoot,
            "apps",
            "local",
            "compose.yaml"
        );
        await mkdir(path.dirname(localEnvPrecedenceComposePath), {
            recursive: true,
        });
        await mkdir(path.join(localEnvPrecedenceRoot, "apps", "include-file"), {
            recursive: true,
        });
        await writeFile(
            path.join(localEnvPrecedenceRoot, ".env"),
            "APP_COMPOSE=apps/local\n",
            "utf8"
        );
        await writeFile(
            path.join(localEnvPrecedenceRoot, "include.env"),
            "APP_COMPOSE=apps/include-file\n",
            "utf8"
        );
        await writeFile(
            path.join(localEnvPrecedenceRoot, "compose.yaml"),
            "include:\n- path: ${APP_COMPOSE}/compose.yaml\n  env_file: include.env\n",
            "utf8"
        );
        await writeFile(localEnvPrecedenceComposePath, "services: {}\n", "utf8");
        await writeFile(
            path.join(localEnvPrecedenceRoot, "apps", "include-file", "compose.yaml"),
            "services: {}\n",
            "utf8"
        );
        await withEnv(
            {
                APP_COMPOSE: undefined,
                MIRA_DOCKER_COMPOSE_WRAPPER: "/tmp/mira-compose-wrapper",
            },
            async () => {
                assert.equal(
                    updater.__testing.getComposeCommand(
                        localEnvPrecedenceComposePath,
                        "web"
                    ).cwd,
                    localEnvPrecedenceRoot
                );
            }
        );
        const nestedEnvFileRoot = path.join(tempDir, "nested-env-file-root");
        const nestedEnvFileComposePath = path.join(
            nestedEnvFileRoot,
            "apps",
            "leaf",
            "compose.yaml"
        );
        const nestedEnvFileIntermediatePath = path.join(
            nestedEnvFileRoot,
            "apps",
            "compose.yaml"
        );
        await mkdir(path.dirname(nestedEnvFileComposePath), { recursive: true });
        await writeFile(
            path.join(nestedEnvFileRoot, "apps", "include.env"),
            "APP=leaf\n",
            "utf8"
        );
        await writeFile(
            path.join(nestedEnvFileRoot, "compose.yaml"),
            "include:\n- path: apps/compose.yaml\n  env_file: apps/include.env\n",
            "utf8"
        );
        await writeFile(
            nestedEnvFileIntermediatePath,
            "include:\n- ${APP}/compose.yaml\n",
            "utf8"
        );
        await writeFile(nestedEnvFileComposePath, "services: {}\n", "utf8");
        await withEnv(
            {
                APP: undefined,
                MIRA_DOCKER_COMPOSE_WRAPPER: "/tmp/mira-compose-wrapper",
            },
            async () => {
                assert.equal(
                    updater.__testing.getComposeCommand(nestedEnvFileComposePath, "web")
                        .cwd,
                    nestedEnvFileRoot
                );
            }
        );
        const explicitEnvFileNoDefaultRoot = path.join(
            tempDir,
            "explicit-env-file-no-default-root"
        );
        const explicitEnvFileNoDefaultComposePath = path.join(
            explicitEnvFileNoDefaultRoot,
            "apps",
            "leaf",
            "compose.yaml"
        );
        const explicitEnvFileNoDefaultIntermediatePath = path.join(
            explicitEnvFileNoDefaultRoot,
            "apps",
            "compose.yaml"
        );
        await mkdir(path.dirname(explicitEnvFileNoDefaultComposePath), {
            recursive: true,
        });
        await writeFile(
            path.join(explicitEnvFileNoDefaultRoot, "apps", ".env"),
            "APP=leaf\n",
            "utf8"
        );
        await writeFile(
            path.join(explicitEnvFileNoDefaultRoot, "include.env"),
            "OTHER=value\n",
            "utf8"
        );
        await writeFile(
            path.join(explicitEnvFileNoDefaultRoot, "compose.yaml"),
            "include:\n- path: apps/compose.yaml\n  env_file: include.env\n",
            "utf8"
        );
        await writeFile(
            explicitEnvFileNoDefaultIntermediatePath,
            "include:\n- ${APP}/compose.yaml\n",
            "utf8"
        );
        await writeFile(explicitEnvFileNoDefaultComposePath, "services: {}\n", "utf8");
        await withEnv(
            {
                APP: undefined,
                MIRA_DOCKER_COMPOSE_WRAPPER: "/tmp/mira-compose-wrapper",
            },
            async () => {
                assert.equal(
                    updater.__testing.getComposeCommand(
                        explicitEnvFileNoDefaultComposePath,
                        "web"
                    ).cwd,
                    path.dirname(explicitEnvFileNoDefaultIntermediatePath)
                );
            }
        );
        const objectIncludeRoot = path.join(tempDir, "object-include-root");
        const objectIncludeComposePath = path.join(
            objectIncludeRoot,
            "apps",
            "app",
            "compose.yaml"
        );
        const objectProjectComposePath = path.join(objectIncludeRoot, "compose.yaml");
        await mkdir(path.dirname(objectIncludeComposePath), { recursive: true });
        await writeFile(
            objectProjectComposePath,
            `include:\n- path: ${JSON.stringify(objectIncludeComposePath)}\n`,
            "utf8"
        );
        await writeFile(objectIncludeComposePath, "services: {}\n", "utf8");
        await withEnv(
            {
                MIRA_DOCKER_COMPOSE_WRAPPER: "/tmp/mira-compose-wrapper",
            },
            async () => {
                assert.deepEqual(
                    updater.__testing.getComposeCommand(objectIncludeComposePath, "web"),
                    {
                        file: "/tmp/mira-compose-wrapper",
                        args: [
                            "-f",
                            objectProjectComposePath,
                            "up",
                            "-d",
                            "--pull",
                            "always",
                            "web",
                        ],
                        cwd: objectIncludeRoot,
                    }
                );
            }
        );
        const listIncludeRoot = path.join(tempDir, "list-include-root");
        const listIncludeComposePath = path.join(
            listIncludeRoot,
            "apps",
            "app",
            "compose.yaml"
        );
        const listProjectComposePath = path.join(listIncludeRoot, "compose.yaml");
        await mkdir(path.dirname(listIncludeComposePath), { recursive: true });
        await writeFile(
            listProjectComposePath,
            "include:\n- path:\n  - apps/app/compose.yaml\n  - apps/app/override.yaml\n",
            "utf8"
        );
        await writeFile(listIncludeComposePath, "services: {}\n", "utf8");
        const listOverrideComposePath = path.join(
            listIncludeRoot,
            "apps",
            "app",
            "override.yaml"
        );
        await writeFile(listOverrideComposePath, "services: {}\n", "utf8");
        await withEnv(
            {
                MIRA_DOCKER_COMPOSE_WRAPPER: "/tmp/mira-compose-wrapper",
            },
            async () => {
                assert.equal(
                    updater.__testing.getComposeCommand(listIncludeComposePath, "web")
                        .cwd,
                    listIncludeRoot
                );
                assert.equal(
                    updater.__testing.getComposeCommand(listOverrideComposePath, "web")
                        .cwd,
                    listIncludeRoot
                );
            }
        );
        const projectDirectoryRoot = path.join(tempDir, "project-directory-root");
        const projectDirectoryComposePath = path.join(
            projectDirectoryRoot,
            "apps",
            "web",
            "compose.yaml"
        );
        const sharedComposePath = path.join(
            projectDirectoryRoot,
            "shared",
            "compose.yaml"
        );
        await mkdir(path.dirname(projectDirectoryComposePath), { recursive: true });
        await mkdir(path.dirname(sharedComposePath), { recursive: true });
        await writeFile(
            path.join(projectDirectoryRoot, "compose.yaml"),
            "include:\n- path: shared/compose.yaml\n  project_directory: apps\n",
            "utf8"
        );
        await writeFile(sharedComposePath, "include:\n- web/compose.yaml\n", "utf8");
        await writeFile(projectDirectoryComposePath, "services: {}\n", "utf8");
        await withEnv(
            {
                MIRA_DOCKER_COMPOSE_WRAPPER: "/tmp/mira-compose-wrapper",
            },
            async () => {
                assert.equal(
                    updater.__testing.getComposeCommand(
                        projectDirectoryComposePath,
                        "web"
                    ).cwd,
                    projectDirectoryRoot
                );
            }
        );
        const recursiveIncludeRoot = path.join(tempDir, "recursive-include-root");
        const recursiveIncludeComposePath = path.join(
            recursiveIncludeRoot,
            "apps",
            "app",
            "compose.yaml"
        );
        const intermediateComposePath = path.join(
            recursiveIncludeRoot,
            "apps",
            "compose.yaml"
        );
        const recursiveProjectComposePath = path.join(
            recursiveIncludeRoot,
            "compose.yaml"
        );
        await mkdir(path.dirname(recursiveIncludeComposePath), { recursive: true });
        await writeFile(
            recursiveProjectComposePath,
            "include:\n- apps/compose.yaml\n",
            "utf8"
        );
        await writeFile(
            intermediateComposePath,
            "include:\n- app/compose.yaml\n",
            "utf8"
        );
        await writeFile(recursiveIncludeComposePath, "services: {}\n", "utf8");
        await withEnv(
            {
                MIRA_DOCKER_COMPOSE_WRAPPER: "/tmp/mira-compose-wrapper",
            },
            async () => {
                assert.equal(
                    updater.__testing.getComposeCommand(
                        recursiveIncludeComposePath,
                        "web"
                    ).cwd,
                    recursiveIncludeRoot
                );
            }
        );
        const repeatedIncludeRoot = path.join(tempDir, "repeated-include-root");
        const repeatedIncludeComposePath = path.join(
            repeatedIncludeRoot,
            "apps",
            "web",
            "compose.yaml"
        );
        const repeatedMissingComposePath = path.join(
            repeatedIncludeRoot,
            "apps",
            "missing",
            "compose.yaml"
        );
        const repeatedSharedComposePath = path.join(
            repeatedIncludeRoot,
            "shared",
            "compose.yaml"
        );
        await mkdir(path.dirname(repeatedIncludeComposePath), { recursive: true });
        await mkdir(path.dirname(repeatedMissingComposePath), { recursive: true });
        await mkdir(path.dirname(repeatedSharedComposePath), { recursive: true });
        await writeFile(
            path.join(repeatedIncludeRoot, "first.env"),
            "Z_CONTEXT=first\nAPP=missing\n",
            "utf8"
        );
        await writeFile(
            path.join(repeatedIncludeRoot, "second.env"),
            "Z_CONTEXT=second\nAPP=web\n",
            "utf8"
        );
        await writeFile(
            path.join(repeatedIncludeRoot, "compose.yaml"),
            [
                "include:",
                "- path: shared/compose.yaml",
                "  env_file: first.env",
                "- path: shared/compose.yaml",
                "  env_file: second.env",
                "",
            ].join("\n"),
            "utf8"
        );
        await writeFile(
            repeatedSharedComposePath,
            "include:\n- ../apps/${APP}/compose.yaml\n",
            "utf8"
        );
        await writeFile(repeatedMissingComposePath, "services: {}\n", "utf8");
        await writeFile(repeatedIncludeComposePath, "services: {}\n", "utf8");
        await withEnv(
            {
                APP: undefined,
                MIRA_DOCKER_COMPOSE_WRAPPER: "/tmp/mira-compose-wrapper",
            },
            async () => {
                assert.equal(
                    updater.__testing.getComposeCommand(repeatedIncludeComposePath, "web")
                        .cwd,
                    repeatedIncludeRoot
                );
            }
        );
        const absoluteRecursiveRoot = path.join(tempDir, "absolute-recursive-root");
        const absoluteRecursiveComposePath = path.join(
            absoluteRecursiveRoot,
            "apps",
            "app",
            "compose.yaml"
        );
        const absoluteIntermediateComposePath = path.join(
            absoluteRecursiveRoot,
            "apps",
            "compose.yaml"
        );
        await mkdir(path.dirname(absoluteRecursiveComposePath), { recursive: true });
        await writeFile(
            path.join(absoluteRecursiveRoot, "compose.yaml"),
            `include:\n- ${JSON.stringify(absoluteIntermediateComposePath)}\n`,
            "utf8"
        );
        await writeFile(
            absoluteIntermediateComposePath,
            "include:\n- app/compose.yaml\n",
            "utf8"
        );
        await writeFile(absoluteRecursiveComposePath, "services: {}\n", "utf8");
        await withEnv(
            {
                MIRA_DOCKER_COMPOSE_WRAPPER: "/tmp/mira-compose-wrapper",
            },
            async () => {
                assert.equal(
                    updater.__testing.getComposeCommand(
                        absoluteRecursiveComposePath,
                        "web"
                    ).cwd,
                    absoluteRecursiveRoot
                );
            }
        );
        const cyclicIncludeRoot = path.join(tempDir, "cyclic-include-root");
        const cyclicIncludeComposePath = path.join(
            cyclicIncludeRoot,
            "apps",
            "app",
            "compose.yaml"
        );
        const cyclicIntermediateComposePath = path.join(
            cyclicIncludeRoot,
            "apps",
            "compose.yaml"
        );
        await mkdir(path.dirname(cyclicIncludeComposePath), { recursive: true });
        await writeFile(
            path.join(cyclicIncludeRoot, "compose.yaml"),
            "include:\n- apps/compose.yaml\n",
            "utf8"
        );
        await writeFile(
            cyclicIntermediateComposePath,
            "include:\n- ../compose.yaml\n",
            "utf8"
        );
        await writeFile(cyclicIncludeComposePath, "services: {}\n", "utf8");
        await withEnv(
            {
                MIRA_DOCKER_BIN: "/tmp/mira-docker",
            },
            async () => {
                assert.equal(
                    updater.__testing.getComposeCommand(cyclicIncludeComposePath, "web")
                        .cwd,
                    path.dirname(cyclicIncludeComposePath)
                );
            }
        );
        const alternateFilenameRoot = path.join(tempDir, "alternate-filename-root");
        const alternateFilenameComposePath = path.join(
            alternateFilenameRoot,
            "apps",
            "app",
            "compose.yaml"
        );
        const alternateProjectComposePath = path.join(
            alternateFilenameRoot,
            "docker-compose.yml"
        );
        await mkdir(path.dirname(alternateFilenameComposePath), { recursive: true });
        await writeFile(
            alternateProjectComposePath,
            "include:\n- apps/app/compose.yaml\n",
            "utf8"
        );
        await writeFile(alternateFilenameComposePath, "services: {}\n", "utf8");
        await withEnv(
            {
                MIRA_DOCKER_COMPOSE_WRAPPER: "/tmp/mira-compose-wrapper",
            },
            async () => {
                assert.deepEqual(
                    updater.__testing.getComposeCommand(
                        alternateFilenameComposePath,
                        "web"
                    ),
                    {
                        file: "/tmp/mira-compose-wrapper",
                        args: [
                            "-f",
                            alternateProjectComposePath,
                            "up",
                            "-d",
                            "--pull",
                            "always",
                            "web",
                        ],
                        cwd: alternateFilenameRoot,
                    }
                );
            }
        );
        const filenamePrecedenceRoot = path.join(tempDir, "filename-precedence-root");
        const filenamePrecedenceComposePath = path.join(
            filenamePrecedenceRoot,
            "apps",
            "app",
            "compose.yaml"
        );
        const canonicalProjectComposePath = path.join(
            filenamePrecedenceRoot,
            "compose.yaml"
        );
        await mkdir(path.dirname(filenamePrecedenceComposePath), { recursive: true });
        await writeFile(
            canonicalProjectComposePath,
            "include:\n- apps/app/compose.yaml\n",
            "utf8"
        );
        await writeFile(
            path.join(filenamePrecedenceRoot, "docker-compose.yml"),
            "include:\n- apps/app/compose.yaml\n",
            "utf8"
        );
        await writeFile(filenamePrecedenceComposePath, "services: {}\n", "utf8");
        await withEnv(
            {
                MIRA_DOCKER_COMPOSE_WRAPPER: "/tmp/mira-compose-wrapper",
            },
            async () => {
                assert.deepEqual(
                    updater.__testing
                        .getComposeCommand(filenamePrecedenceComposePath, "web")
                        .args.slice(0, 2),
                    ["-f", canonicalProjectComposePath]
                );
            }
        );
        const overrideRoot = path.join(tempDir, "override-root");
        const overrideComposePath = path.join(
            overrideRoot,
            "apps",
            "app",
            "compose.yaml"
        );
        const overrideProjectComposePath = path.join(overrideRoot, "compose.yaml");
        const overrideProjectOverridePath = path.join(
            overrideRoot,
            "compose.override.yaml"
        );
        await mkdir(path.dirname(overrideComposePath), { recursive: true });
        await writeFile(
            overrideProjectComposePath,
            "include:\n- apps/app/compose.yaml\n",
            "utf8"
        );
        await writeFile(overrideProjectOverridePath, "services: {}\n", "utf8");
        await writeFile(
            path.join(overrideRoot, "compose.override.yml"),
            "services:\n  stale:\n    image: stale:latest\n",
            "utf8"
        );
        await writeFile(overrideComposePath, "services: {}\n", "utf8");
        await withEnv(
            {
                MIRA_DOCKER_COMPOSE_WRAPPER: "/tmp/mira-compose-wrapper",
            },
            async () => {
                assert.deepEqual(
                    updater.__testing
                        .getComposeCommand(overrideComposePath, "web")
                        .args.slice(0, 4),
                    ["-f", overrideProjectComposePath, "-f", overrideProjectOverridePath]
                );
            }
        );
        await writeFile(
            overrideProjectOverridePath,
            "services:\n  web:\n    image: repo/app:override\n",
            "utf8"
        );
        await withEnv(
            {
                MIRA_DOCKER_COMPOSE_WRAPPER: "/tmp/mira-compose-wrapper",
            },
            async () => {
                assert.deepEqual(
                    updater.__testing
                        .getComposeCommand(overrideComposePath, "web")
                        .args.slice(0, 4),
                    ["-f", overrideProjectComposePath, "-f", overrideProjectOverridePath]
                );
            }
        );
        await writeFile(overrideProjectOverridePath, "services:\n  web: [\n", "utf8");
        await withEnv(
            {
                MIRA_DOCKER_COMPOSE_WRAPPER: "/tmp/mira-compose-wrapper",
            },
            async () => {
                assert.deepEqual(
                    updater.__testing
                        .getComposeCommand(overrideComposePath, "web")
                        .args.slice(0, 4),
                    ["-f", overrideProjectComposePath, "-f", overrideProjectOverridePath]
                );
            }
        );
        const symlinkParentOverrideRoot = path.join(
            tempDir,
            "symlink-parent-override-root"
        );
        const symlinkParentTargetRoot = path.join(
            tempDir,
            "symlink-parent-override-target"
        );
        const symlinkParentComposePath = path.join(
            symlinkParentOverrideRoot,
            "compose.yaml"
        );
        const symlinkParentTargetComposePath = path.join(
            symlinkParentTargetRoot,
            "compose.yaml"
        );
        const symlinkParentOverridePath = path.join(
            symlinkParentOverrideRoot,
            "compose.override.yaml"
        );
        const symlinkParentChildComposePath = path.join(
            symlinkParentOverrideRoot,
            "apps",
            "app",
            "compose.yaml"
        );
        await mkdir(symlinkParentOverrideRoot, { recursive: true });
        await mkdir(symlinkParentTargetRoot, { recursive: true });
        await mkdir(path.dirname(symlinkParentChildComposePath), { recursive: true });
        await writeFile(symlinkParentTargetComposePath, "services: {}\n", "utf8");
        await symlink(symlinkParentTargetComposePath, symlinkParentComposePath);
        await writeFile(
            symlinkParentOverridePath,
            "include:\n- apps/app/compose.yaml\n",
            "utf8"
        );
        await writeFile(symlinkParentChildComposePath, "services: {}\n", "utf8");
        await withEnv(
            {
                MIRA_DOCKER_COMPOSE_WRAPPER: "/tmp/mira-compose-wrapper",
            },
            async () => {
                assert.deepEqual(
                    updater.__testing
                        .getComposeCommand(symlinkParentChildComposePath, "web")
                        .args.slice(0, 4),
                    ["-f", symlinkParentComposePath, "-f", symlinkParentOverridePath]
                );
            }
        );
        const nestedFallbackIncludeRoot = path.join(
            tempDir,
            "nested-fallback-include-root"
        );
        const nestedFallbackIncludeComposePath = path.join(
            nestedFallbackIncludeRoot,
            "apps",
            "fallback-app",
            "compose.yaml"
        );
        await mkdir(path.dirname(nestedFallbackIncludeComposePath), {
            recursive: true,
        });
        await writeFile(
            path.join(nestedFallbackIncludeRoot, ".env"),
            "DEFAULT_APP_DIR=apps/fallback-app\n",
            "utf8"
        );
        await writeFile(
            path.join(nestedFallbackIncludeRoot, "compose.yaml"),
            "include:\n- ${APP_DIR:-${DEFAULT_APP_DIR}}/compose.yaml\n",
            "utf8"
        );
        await writeFile(nestedFallbackIncludeComposePath, "services: {}\n", "utf8");
        await withEnv(
            {
                APP_DIR: undefined,
                DEFAULT_APP_DIR: undefined,
                MIRA_DOCKER_COMPOSE_WRAPPER: "/tmp/mira-compose-wrapper",
            },
            async () => {
                assert.equal(
                    updater.__testing.getComposeCommand(
                        nestedFallbackIncludeComposePath,
                        "web"
                    ).cwd,
                    nestedFallbackIncludeRoot
                );
            }
        );
        const overrideOnlyIncludeRoot = path.join(tempDir, "override-only-include-root");
        const overrideOnlyIncludeComposePath = path.join(
            overrideOnlyIncludeRoot,
            "apps",
            "app",
            "compose.yaml"
        );
        const overrideOnlyProjectComposePath = path.join(
            overrideOnlyIncludeRoot,
            "compose.yaml"
        );
        const overrideOnlyProjectOverridePath = path.join(
            overrideOnlyIncludeRoot,
            "compose.override.yaml"
        );
        await mkdir(path.dirname(overrideOnlyIncludeComposePath), { recursive: true });
        await writeFile(overrideOnlyProjectComposePath, "services: {}\n", "utf8");
        await writeFile(
            overrideOnlyProjectOverridePath,
            "include:\n- apps/app/compose.yaml\n",
            "utf8"
        );
        await writeFile(overrideOnlyIncludeComposePath, "services: {}\n", "utf8");
        await withEnv(
            {
                MIRA_DOCKER_COMPOSE_WRAPPER: "/tmp/mira-compose-wrapper",
            },
            async () => {
                assert.deepEqual(
                    updater.__testing
                        .getComposeCommand(overrideOnlyIncludeComposePath, "web")
                        .args.slice(0, 4),
                    [
                        "-f",
                        overrideOnlyProjectComposePath,
                        "-f",
                        overrideOnlyProjectOverridePath,
                    ]
                );
            }
        );
        const standaloneOverrideRoot = path.join(tempDir, "standalone-override-root");
        const standaloneOverrideComposePath = path.join(
            standaloneOverrideRoot,
            "compose.yaml"
        );
        const standaloneOverridePath = path.join(
            standaloneOverrideRoot,
            "compose.override.yaml"
        );
        await mkdir(standaloneOverrideRoot, { recursive: true });
        await writeFile(standaloneOverrideComposePath, "services: {}\n", "utf8");
        await writeFile(
            standaloneOverridePath,
            "services:\n  web:\n    image: nginx:override\n",
            "utf8"
        );
        await withEnv(
            {
                MIRA_DOCKER_COMPOSE_WRAPPER: "/tmp/mira-compose-wrapper",
            },
            async () => {
                assert.deepEqual(
                    updater.__testing
                        .getComposeCommand(standaloneOverrideComposePath, "web")
                        .args.slice(0, 2),
                    ["-f", standaloneOverrideComposePath]
                );
            }
        );
        const symlinkStandaloneRoot = path.join(tempDir, "symlink-standalone-root");
        const symlinkTargetRoot = path.join(tempDir, "symlink-standalone-target");
        const symlinkStandaloneComposePath = path.join(
            symlinkStandaloneRoot,
            "compose.yaml"
        );
        const symlinkTargetComposePath = path.join(symlinkTargetRoot, "compose.yaml");
        await mkdir(symlinkStandaloneRoot, { recursive: true });
        await mkdir(symlinkTargetRoot, { recursive: true });
        await writeFile(symlinkTargetComposePath, "services: {}\n", "utf8");
        await writeFile(
            path.join(symlinkTargetRoot, "compose.override.yaml"),
            "services:\n  web:\n    image: nginx:override\n",
            "utf8"
        );
        await symlink(symlinkTargetComposePath, symlinkStandaloneComposePath);
        await withEnv(
            {
                MIRA_DOCKER_COMPOSE_WRAPPER: "/tmp/mira-compose-wrapper",
            },
            async () => {
                assert.deepEqual(
                    updater.__testing
                        .getComposeCommand(symlinkStandaloneComposePath, "web")
                        .args.slice(0, 2),
                    ["-f", symlinkTargetComposePath]
                );
            }
        );
        const missingIncludeRoot = path.join(tempDir, "missing-include-root");
        const missingIncludeComposePath = path.join(
            missingIncludeRoot,
            "apps",
            "app",
            "compose.yaml"
        );
        await mkdir(path.dirname(missingIncludeComposePath), { recursive: true });
        await writeFile(
            path.join(missingIncludeRoot, "compose.yaml"),
            "include:\n- apps/missing/compose.yaml\n- path: 123\n",
            "utf8"
        );
        await writeFile(missingIncludeComposePath, "services: {}\n", "utf8");
        await withEnv(
            {
                MIRA_DOCKER_BIN: "/tmp/mira-docker",
            },
            async () => {
                assert.deepEqual(
                    updater.__testing.getComposeCommand(missingIncludeComposePath, "web"),
                    {
                        file: "/tmp/mira-docker",
                        args: [
                            "compose",
                            "-f",
                            missingIncludeComposePath,
                            "up",
                            "-d",
                            "--pull",
                            "always",
                            "web",
                        ],
                        cwd: path.dirname(missingIncludeComposePath),
                    }
                );
            }
        );
        const nonArrayIncludeRoot = path.join(tempDir, "non-array-include-root");
        const nonArrayIncludeComposePath = path.join(
            nonArrayIncludeRoot,
            "apps",
            "app",
            "compose.yaml"
        );
        await mkdir(path.dirname(nonArrayIncludeComposePath), { recursive: true });
        await writeFile(
            path.join(nonArrayIncludeRoot, "compose.yaml"),
            "include:\n  path: apps/app/compose.yaml\n",
            "utf8"
        );
        await writeFile(nonArrayIncludeComposePath, "services: {}\n", "utf8");
        await withEnv(
            {
                MIRA_DOCKER_BIN: "/tmp/mira-docker",
            },
            async () => {
                assert.equal(
                    updater.__testing.getComposeCommand(nonArrayIncludeComposePath, "web")
                        .cwd,
                    path.dirname(nonArrayIncludeComposePath)
                );
            }
        );
        const malformedIncludeRoot = path.join(tempDir, "malformed-include-root");
        const malformedIncludeComposePath = path.join(
            malformedIncludeRoot,
            "apps",
            "app",
            "compose.yaml"
        );
        await mkdir(path.dirname(malformedIncludeComposePath), { recursive: true });
        await writeFile(path.join(malformedIncludeRoot, "compose.yaml"), "[", "utf8");
        await writeFile(malformedIncludeComposePath, "services: {}\n", "utf8");
        await withEnv(
            {
                MIRA_DOCKER_BIN: "/tmp/mira-docker",
            },
            async () => {
                assert.equal(
                    updater.__testing.getComposeCommand(
                        malformedIncludeComposePath,
                        "web"
                    ).cwd,
                    path.dirname(malformedIncludeComposePath)
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
                            "--pull",
                            "always",
                            "web",
                        ],
                        cwd: "/srv/app",
                    }
                );
            }
        );
        const metadataTarget = path.join(tempDir, "metadata-helper.yaml");
        const chownCalls: Array<[string, number, number]> = [];
        const fstatMock = mock.method(
            fs,
            "fstatSync",
            () =>
                ({
                    mode: 0o100644,
                    uid: 1000,
                    gid: 1000,
                }) as fs.Stats
        );
        const chownMock = mock.method(
            fs,
            "fchownSync",
            (fd: number, uid: number, gid: number) => {
                assert.equal(typeof fd, "number");
                chownCalls.push([metadataTarget, uid, gid]);
            }
        );
        try {
            updater.__testing.writeFileWithMetadata(metadataTarget, "services: {}\n", {
                mode: 0o100600,
                uid: 2000,
                gid: 2000,
            } as fs.Stats);
        } finally {
            fstatMock.mock.restore();
            chownMock.mock.restore();
        }
        assert.deepEqual(chownCalls, [[metadataTarget, 2000, 2000]]);
        assert.equal(await readFile(metadataTarget, "utf8"), "services: {}\n");
        const epermMetadataTarget = path.join(tempDir, "metadata-helper-eperm.yaml");
        const epermFstatMock = mock.method(
            fs,
            "fstatSync",
            () =>
                ({
                    mode: 0o100644,
                    uid: 1000,
                    gid: 1000,
                }) as fs.Stats
        );
        const epermChownMock = mock.method(fs, "fchownSync", () => {
            throw Object.assign(new Error("ownership denied"), { code: "EPERM" });
        });
        try {
            updater.__testing.writeFileWithMetadata(
                epermMetadataTarget,
                "services: {}\n",
                {
                    mode: 0o100600,
                    uid: 2000,
                    gid: 2000,
                } as fs.Stats
            );
        } finally {
            epermFstatMock.mock.restore();
            epermChownMock.mock.restore();
        }
        assert.equal(await readFile(epermMetadataTarget, "utf8"), "services: {}\n");
        const failedChownTarget = path.join(tempDir, "metadata-helper-chown-failed.yaml");
        const failedChownFstatMock = mock.method(
            fs,
            "fstatSync",
            () =>
                ({
                    mode: 0o100644,
                    uid: 1000,
                    gid: 1000,
                }) as fs.Stats
        );
        const failedChownMock = mock.method(fs, "fchownSync", () => {
            throw Object.assign(new Error("ownership lookup failed"), { code: "EIO" });
        });
        try {
            assert.throws(
                () =>
                    updater.__testing.writeFileWithMetadata(
                        failedChownTarget,
                        "services: {}\n",
                        {
                            mode: 0o100600,
                            uid: 2000,
                            gid: 2000,
                        } as fs.Stats
                    ),
                /ownership lookup failed/u
            );
        } finally {
            failedChownFstatMock.mock.restore();
            failedChownMock.mock.restore();
            await rm(failedChownTarget, { force: true });
        }
        const failedMetadataTarget = path.join(tempDir, "metadata-helper-failed.yaml");
        const writeMock = mock.method(fs, "writeFileSync", () => {
            throw new Error("write denied");
        });
        const unlinkMock = mock.method(fs, "unlinkSync", () => {
            throw new Error("unlink denied");
        });
        try {
            assert.throws(
                () =>
                    updater.__testing.writeFileWithMetadata(
                        failedMetadataTarget,
                        "services: {}\n",
                        {
                            mode: 0o100600,
                            uid: 2000,
                            gid: 2000,
                        } as fs.Stats
                    ),
                /write denied/u
            );
        } finally {
            writeMock.mock.restore();
            unlinkMock.mock.restore();
            await rm(failedMetadataTarget, { force: true });
        }
        assert.equal(
            updater.__testing.isSafeTagRegexPattern(String.raw`^1\.2\.[0-9]+$`),
            true
        );
        assert.equal(updater.__testing.isSafeTagRegexPattern("(a+)+$"), false);
        assert.equal(updater.__testing.isSafeTagRegexPattern("a".repeat(129)), false);

        const pruneBin = path.join(tempDir, "docker-prune-fails");
        await writeExecutable(
            pruneBin,
            "#!/usr/bin/env node\nprocess.stderr.write('prune failed\\n');\nprocess.exit(12);\n"
        );
        const consoleErrorMock = mock.method(console, "error", () => {});
        try {
            await withEnv({ MIRA_DOCKER_BIN: pruneBin }, async () => {
                await updater.__testing.pruneDanglingImagesBestEffort();
            });
            assert.equal(consoleErrorMock.mock.callCount(), 1);
        } finally {
            consoleErrorMock.mock.restore();
        }

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
                {
                    ...baseService,
                    current_tag: "1",
                    tag_match_type: "regex",
                    tag_match_pattern: "[z-a]",
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
        assert.equal(
            updater.__testing.needsFullTagScan({
                ...baseService,
                tag_match_type: "exact",
                tag_match_pattern: "1",
            }),
            false
        );
        assert.equal(
            updater.__testing.needsFullTagScan({
                ...baseService,
                tag_match_type: "regex",
                tag_match_pattern: "",
            }),
            false
        );
        assert.equal(
            updater.__testing.needsFullTagScan({
                ...baseService,
                tag_match_type: "regex",
                tag_match_pattern: "a".repeat(129),
            }),
            false
        );
        assert.equal(
            updater.__testing.needsFullTagScan({
                ...baseService,
                tag_match_type: "regex",
                tag_match_pattern: "[",
            }),
            false
        );
        assert.equal(
            updater.__testing.needsFullTagScan({
                ...baseService,
                tag_match_type: "regex",
                tag_match_pattern: "^1$",
            }),
            true
        );
        assert.equal(
            updater.__testing.needsFullTagScan({
                ...baseService,
                tag_match_type: "regex",
                tag_match_pattern: String.raw`^\d+$`,
            }),
            true
        );
        assert.equal(
            updater.__testing.needsFullTagScan({
                ...baseService,
                current_tag: null,
                tag_match_type: "regex",
                tag_match_pattern: String.raw`^\d+$`,
            }),
            true
        );
        assert.equal(updater.__testing.hasUpdate(baseService), true);
        assert.equal(
            updater.__testing.hasUpdate({
                ...baseService,
                current_tag: null,
                latest_tag: "2",
            }),
            true
        );
        assert.equal(
            updater.__testing.hasUpdate({
                ...baseService,
                current_tag: "1",
                latest_tag: "1",
                current_digest: null,
                latest_digest: "sha256:new",
            }),
            true
        );
        assert.equal(
            updater.__testing.hasUpdate({
                ...baseService,
                current_tag: "1",
                latest_tag: "1",
                current_digest: "sha256:old",
                latest_digest: "sha256:new",
            }),
            true
        );
        assert.equal(
            updater.__testing.hasUpdate({
                ...baseService,
                current_tag: "1",
                latest_tag: "1",
                current_digest: "sha256:old",
                latest_digest: null,
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
        const missingServices = updater.__testing.servicesFromCompose(emptyCompose);
        assert.equal(missingServices.ok, false);
        assert.match(missingServices.error ?? "", /services object/u);
        const invalidImageCompose = path.join(tempDir, "invalid-image-compose.yaml");
        await writeFile(
            invalidImageCompose,
            "services:\n  app:\n    image:\n      repo: app\n",
            "utf8"
        );
        const invalidImage = updater.__testing.servicesFromCompose(invalidImageCompose);
        assert.equal(invalidImage.ok, false);
        assert.match(invalidImage.error ?? "", /image as a string/u);
        const nestedTarget = { services: { app: { image: "repo/app:1" } } };
        updater.__testing.setNestedValue(
            nestedTarget,
            "services.app.image",
            "repo/app:3"
        );
        assert.deepEqual(nestedTarget, { services: { app: { image: "repo/app:3" } } });
        assert.throws(
            () =>
                updater.__testing.setNestedValue(
                    { services: {} },
                    "services.app.image",
                    "repo/app:2"
                ),
            /Compose image field path does not exist/u
        );
        assert.throws(
            () =>
                updater.__testing.setNestedValue(
                    { services: { app: "bad" } },
                    "services.app.image",
                    "repo/app:2"
                ),
            /Compose image field path is not an object/u
        );
        assert.throws(
            () =>
                updater.__testing.setNestedValue(
                    { services: { app: { image: "repo/app:1" } } },
                    "services.__proto__.image",
                    "repo/app:2"
                ),
            /Unsafe compose image field segment/u
        );
        assert.throws(
            () =>
                updater.__testing.setNestedValue(
                    { services: { app: {} } },
                    "services.app.image",
                    "repo/app:2"
                ),
            /Compose image field path does not exist/u
        );
        const dottedTarget = { services: { "api.worker": { image: "repo/dotted:0" } } };
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
        mockFetch(
            async () =>
                ({
                    ok: true,
                    headers: new Headers({ "docker-content-digest": "sha256:new" }),
                    json: async () => ({}),
                }) as Response
        );
        assert.deepEqual(
            await updater.__testing.lookupGhcr({
                ...baseService,
                image_repo: "ghcr.io/owner/app",
                current_tag: null,
                tag_match_pattern: null,
            }),
            { latestTag: null, latestDigest: null }
        );
        mockFetch(
            async () =>
                ({
                    ok: true,
                    headers: new Headers(),
                    json: async () => ({}),
                }) as Response
        );
        assert.deepEqual(
            await updater.__testing.lookupGhcr({
                ...baseService,
                image_repo: "ghcr.io/owner/app",
                latest_digest: null,
            }),
            { latestTag: "1", latestDigest: null }
        );

        mockFetch(
            async () =>
                ({
                    ok: false,
                    status: 503,
                    headers: new Headers(),
                    json: async () => ({}),
                }) as Response
        );
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
        mockFetch(async () => {
            throw new DOMException("aborted", "AbortError");
        });
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
        mockFetch(
            async () =>
                ({
                    ok: false,
                    status: 500,
                    headers: new Headers(),
                    json: async () => ({}),
                }) as Response
        );
        await assert.rejects(
            () => updater.__testing.fetchJson("https://hub.docker.com/fail"),
            /HTTP 500/u
        );
        mockFetch(
            async () =>
                ({
                    ok: true,
                    headers: new Headers(),
                    json: async () => ({ ok: true }),
                }) as Response
        );
        assert.deepEqual(await updater.__testing.fetchJson("https://hub.docker.com/ok"), {
            ok: true,
        });
        mockFetch(
            async () =>
                ({
                    ok: true,
                    headers: new Headers(),
                    json: async () => {
                        throw new Error("bad json");
                    },
                }) as unknown as Response
        );
        await assert.rejects(
            () => updater.__testing.fetchJson("https://hub.docker.com/bad-json"),
            /bad json/u
        );
        mockFetch(async () => {
            throw new Error("network down");
        });
        await assert.rejects(
            () =>
                updater.__testing.lookupGhcr({
                    ...baseService,
                    image_repo: "ghcr.io/owner/app",
                }),
            /network down/u
        );

        const noChallengeDrained: string[] = [];
        mockFetch(
            async () =>
                ({
                    ok: false,
                    status: 401,
                    headers: new Headers(),
                    arrayBuffer: async () => {
                        noChallengeDrained.push("401");
                        return new ArrayBuffer(0);
                    },
                    json: async () => ({}),
                }) as Response
        );
        await assert.rejects(
            () =>
                updater.__testing.fetchRegistryJson(
                    "https://ghcr.io/v2/owner/app/tags/list"
                ),
            /HTTP 401/u
        );
        assert.deepEqual(noChallengeDrained, ["401"]);

        const authFailureDrained: string[] = [];
        mockFetch(async (input: string | URL | Request) => {
            const url = typeof input === "string" ? input : input.toString();
            if (url.startsWith("https://ghcr.io/token")) {
                return {
                    ok: false,
                    status: 503,
                    headers: new Headers(),
                    arrayBuffer: async () => {
                        authFailureDrained.push("token");
                        return new ArrayBuffer(0);
                    },
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
                arrayBuffer: async () => {
                    authFailureDrained.push("challenge");
                    return new ArrayBuffer(0);
                },
                json: async () => ({}),
            } as Response;
        });
        await assert.rejects(
            () =>
                updater.__testing.fetchRegistryJson(
                    "https://ghcr.io/v2/owner/app/tags/list"
                ),
            /HTTP 401/u
        );
        assert.deepEqual(authFailureDrained, ["challenge", "token"]);

        mockFetch(
            async () =>
                ({
                    ok: false,
                    status: 401,
                    headers: new Headers(),
                    arrayBuffer: async () => {
                        throw new Error("drain failed");
                    },
                    json: async () => ({}),
                }) as unknown as Response
        );
        await assert.rejects(
            () =>
                updater.__testing.fetchRegistryJson(
                    "https://ghcr.io/v2/owner/app/tags/list"
                ),
            /HTTP 401/u
        );

        mockFetch(async (input: string | URL | Request) => {
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
        });
        await assert.rejects(
            () =>
                updater.__testing.fetchRegistryJson(
                    "https://ghcr.io/v2/owner/app/tags/list"
                ),
            /HTTP 401/u
        );

        mockFetch(async (input: string | URL | Request) => {
            const url = typeof input === "string" ? input : input.toString();
            if (url.endsWith("/tags/list?n=1000")) {
                return {
                    ok: true,
                    headers: new Headers({
                        link: '</v2/repo/app/tags/list?n=1000&last=2>; rel="next"',
                    }),
                    json: async () => ({ tags: ["1", "2"] }),
                } as Response;
            }
            if (url.endsWith("/tags/list?n=1000&last=2")) {
                return {
                    ok: true,
                    headers: new Headers(),
                    json: async () => ({ tags: ["3"] }),
                } as Response;
            }
            return {
                ok: true,
                headers: new Headers(),
                json: async () => ({
                    manifests: [
                        {
                            digest: "sha256:v7",
                            platform: { architecture: "arm64", variant: "v7" },
                        },
                        {
                            digest: "sha256:v8",
                            platform: { architecture: "arm64", variant: "v8" },
                        },
                    ],
                }),
            } as Response;
        });
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

        mockFetch(async (input: string | URL | Request) => {
            const url = typeof input === "string" ? input : input.toString();
            return {
                ok: true,
                headers: new Headers({
                    link: `<${url}>; rel="next"`,
                }),
                json: async () => ({ tags: ["1"] }),
            } as Response;
        });
        await assert.rejects(
            () =>
                updater.__testing.lookupDockerHub({
                    ...baseService,
                    tag_match_type: "regex",
                    tag_match_pattern: String.raw`^v\d$`,
                }),
            /docker\.io tag pagination exceeded 100 pages/u
        );

        mockFetch(async (input: string | URL | Request) => {
            const url = typeof input === "string" ? input : input.toString();
            if (url.includes("/tags/list?n=1000")) {
                return {
                    ok: true,
                    headers: new Headers(),
                    json: async () => ({ tags: ["3"] }),
                } as Response;
            }
            return {
                ok: true,
                headers: new Headers(),
                json: async () => ({
                    manifests: [
                        {
                            digest: "sha256:v8",
                            platform: { architecture: "arm64", variant: "v8" },
                        },
                        {
                            digest: "sha256:amd64",
                            platform: { os: "linux", architecture: "amd64" },
                        },
                    ],
                }),
            } as Response;
        });
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
        const originalPlatform = process.env.MIRA_DOCKER_UPDATER_PLATFORM;
        try {
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
        } finally {
            if (originalPlatform === undefined) {
                delete process.env.MIRA_DOCKER_UPDATER_PLATFORM;
            } else {
                process.env.MIRA_DOCKER_UPDATER_PLATFORM = originalPlatform;
            }
        }
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
        const originalSecondPlatform = process.env.MIRA_DOCKER_UPDATER_PLATFORM;
        try {
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
        } finally {
            if (originalSecondPlatform === undefined) {
                delete process.env.MIRA_DOCKER_UPDATER_PLATFORM;
            } else {
                process.env.MIRA_DOCKER_UPDATER_PLATFORM = originalSecondPlatform;
            }
        }
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
        assert.equal(
            updater.__testing.parseNextLink(
                '</v2/owner/app/tags/list?n=100&last=1.0.0>; rel="next"',
                "https://ghcr.io/v2/owner/app/tags/list"
            ),
            "https://ghcr.io/v2/owner/app/tags/list?n=100&last=1.0.0"
        );

        mockFetch(async (input: string | URL | Request) => {
            const url = typeof input === "string" ? input : input.toString();
            if (url.endsWith("/tags/list?n=1000")) {
                return {
                    ok: true,
                    headers: new Headers({
                        link: '<https://ghcr.io/v2/owner/app/tags/list?n=1000&last=1.0.0>; rel="next"',
                    }),
                    json: async () => ({ tags: ["1.0.0", "dev"] }),
                } as Response;
            }
            if (url.includes("/tags/list?n=1000&last=1.0.0")) {
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
        });
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

        const unsafeRegexGhcrFetchUrls: string[] = [];
        mockFetch(async (input: string | URL | Request) => {
            const url = typeof input === "string" ? input : input.toString();
            unsafeRegexGhcrFetchUrls.push(url);
            return {
                ok: true,
                headers: new Headers({ "docker-content-digest": "sha256:ghcr-1" }),
                json: async () => ({}),
            } as Response;
        });
        assert.deepEqual(
            await updater.__testing.lookupGhcr({
                ...baseService,
                image_repo: "ghcr.io/owner/app",
                current_tag: "1.0.0",
                tag_match_type: "regex",
                tag_match_pattern: "(a+)+$",
            }),
            {
                latestTag: "1.0.0",
                latestDigest: "sha256:ghcr-1",
            }
        );
        assert.deepEqual(unsafeRegexGhcrFetchUrls, [
            "https://ghcr.io/v2/owner/app/manifests/1.0.0",
        ]);

        mockFetch(
            async () =>
                ({
                    ok: true,
                    headers: new Headers({
                        link: '<https://ghcr.io/v2/owner/app/tags/list>; rel="next"',
                    }),
                    json: async () => ({ tags: ["1"] }),
                }) as Response
        );
        await assert.rejects(
            () =>
                updater.__testing.lookupGhcr({
                    ...baseService,
                    image_repo: "ghcr.io/owner/app",
                    tag_match_type: "regex",
                    tag_match_pattern: String.raw`^\d$`,
                }),
            /ghcr\.io tag pagination exceeded 100 pages/u
        );

        const authFetchUrls: string[] = [];
        mockFetch(async (input: string | URL | Request, init?: RequestInit) => {
            const url = typeof input === "string" ? input : input.toString();
            authFetchUrls.push(url);
            const headers = new Headers(init?.headers);
            const authorization = headers.get("authorization");
            if (url.endsWith("/tags/list?n=1000") && !authorization) {
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
                    url.endsWith("/tags/list?n=1000") ? { tags: ["1", "2"] } : {},
            } as Response;
        });
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

        mockFetch(async (input: string | URL | Request, init?: RequestInit) => {
            const url = typeof input === "string" ? input : input.toString();
            if (url.startsWith("https://ghcr.io/token")) {
                return {
                    ok: true,
                    headers: new Headers(),
                    json: async () => ({ access_token: "registry-access-token" }),
                } as Response;
            }
            const headers = new Headers(init?.headers);
            const authorization = headers.get("authorization");
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
        });
        assert.deepEqual(
            await updater.__testing.fetchRegistryJson(
                "https://ghcr.io/v2/owner/app/tags/list"
            ),
            { tags: ["1"] }
        );

        const exactGhcrUrls: string[] = [];
        mockFetch(async (input: string | URL | Request) => {
            const url = typeof input === "string" ? input : input.toString();
            exactGhcrUrls.push(url);
            return {
                ok: true,
                headers: new Headers({ "docker-content-digest": "sha256:exact" }),
                json: async () => ({}),
            } as Response;
        });
        assert.deepEqual(
            await updater.__testing.lookupGhcr({
                ...baseService,
                image_repo: "ghcr.io/owner/app",
                tag_match_type: "exact",
                tag_match_pattern: "stable",
            }),
            { latestTag: "stable", latestDigest: "sha256:exact" }
        );
        assert.deepEqual(exactGhcrUrls, [
            "https://ghcr.io/v2/owner/app/manifests/stable",
        ]);

        mockFetch(async (input: string | URL | Request) => {
            const url = typeof input === "string" ? input : input.toString();
            return {
                ok: true,
                headers: new Headers({ "docker-content-digest": "sha256:regex-empty" }),
                json: async () => (url.endsWith("/tags/list") ? { tags: "bad" } : {}),
            } as Response;
        });
        assert.deepEqual(
            await updater.__testing.lookupGhcr({
                ...baseService,
                image_repo: "ghcr.io/owner/app",
                tag_match_type: "regex",
                tag_match_pattern: String.raw`^\d$`,
            }),
            { latestTag: "1", latestDigest: "sha256:regex-empty" }
        );

        mockFetch(
            async () =>
                ({
                    ok: true,
                    headers: new Headers(),
                    json: async () => ({ results: "bad" }),
                }) as Response
        );
        assert.deepEqual(
            await updater.__testing.lookupDockerHub({
                ...baseService,
                current_tag: null,
            }),
            { latestTag: null, latestDigest: null }
        );
        let dockerHubCall = 0;
        mockFetch(async () => {
            dockerHubCall += 1;
            return {
                ok: true,
                headers: new Headers(),
                json: async () =>
                    dockerHubCall === 1
                        ? { tags: ["2"] }
                        : { manifests: [], digest: null },
            } as Response;
        });
        assert.deepEqual(
            await updater.__testing.lookupDockerHub({
                ...baseService,
                current_digest: null,
                tag_match_type: "regex",
                tag_match_pattern: String.raw`^\d$`,
            }),
            { latestTag: "2", latestDigest: null }
        );
        mockFetch(async (input: string | URL | Request) => {
            const url = typeof input === "string" ? input : input.toString();
            return {
                ok: true,
                headers: new Headers(),
                json: async () =>
                    url.includes("/tags/list?n=")
                        ? { tags: ["stable"] }
                        : { manifests: [], digest: null },
            } as Response;
        });
        assert.deepEqual(
            await updater.__testing.lookupDockerHub({
                ...baseService,
                current_tag: "1",
                current_digest: null,
                tag_match_type: "regex",
                tag_match_pattern: String.raw`^\d$`,
            }),
            { latestTag: "1", latestDigest: null }
        );
        assert.deepEqual(
            await updater.__testing.lookupLatest({
                ...baseService,
                image_repo: "lscr.io/linuxserver/swag",
            }),
            { latestTag: "1", latestDigest: null }
        );
        assert.deepEqual(
            await updater.__testing.lookupLatest({
                ...baseService,
                image_repo: "lscr.io/linuxserver/swag",
                latest_tag: null,
                latest_digest: null,
            }),
            { latestTag: "1", latestDigest: null }
        );

        const acceptHeaders: string[] = [];
        mockFetch(async (_input, init) => {
            acceptHeaders.push(String((init?.headers as Record<string, string>).Accept));
            return {
                ok: true,
                headers: new Headers(),
                json: async () => ({}),
            } as Response;
        });
        assert.deepEqual(await updater.__testing.lookupGhcr(baseService), {
            latestTag: "1",
            latestDigest: null,
        });
        assert.ok(
            acceptHeaders.some((header) =>
                header.includes("application/vnd.docker.distribution.manifest.v2+json")
            )
        );
        mockFetch(
            async () =>
                ({
                    ok: true,
                    headers: new Headers({ "docker-content-digest": "sha256:index" }),
                    json: async () => ({
                        manifests: [
                            {
                                digest: "sha256:amd64",
                                platform: { architecture: "amd64", os: "linux" },
                            },
                            {
                                digest: "sha256:arm64v8",
                                platform: {
                                    architecture: "arm64",
                                    os: "linux",
                                    variant: "v8",
                                },
                            },
                        ],
                    }),
                }) as Response
        );
        assert.deepEqual(
            await updater.__testing.lookupGhcr({
                ...baseService,
                image_repo: "ghcr.io/owner/app",
                metadata_json: JSON.stringify({ platform: "linux/arm64" }),
            }),
            { latestTag: "1", latestDigest: "sha256:arm64v8" }
        );
        mockFetch(
            async () =>
                ({
                    ok: true,
                    headers: new Headers(),
                    json: async () => ({ digest: "sha256:body" }),
                }) as Response
        );
        assert.deepEqual(await updater.__testing.lookupGhcr(baseService), {
            latestTag: "1",
            latestDigest: "sha256:body",
        });
        mockFetch(async (input) => {
            assert.match(String(input), /\/tags\/list/u);
            return {
                ok: true,
                headers: new Headers(),
                json: async () => ({ tags: ["stable"] }),
            } as Response;
        });
        assert.deepEqual(
            await updater.__testing.lookupGhcr({
                ...baseService,
                current_tag: null,
                current_digest: "sha256:current",
                latest_tag: "2",
                latest_digest: "sha256:stale",
                tag_match_type: "regex",
                tag_match_pattern: String.raw`^\d$`,
            }),
            { latestTag: null, latestDigest: null }
        );

        dbHandle
            .prepare(
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
            )
            .run();
        await withEnv({ MIRA_DOCKER_UPDATER_SKIP_REGISTRY: "1" }, async () => {
            const result = await updater.pollDockerUpdaterRegistries();
            assert.equal(result.ok, true);
        });
        const nullFallback = dbHandle
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
            const originalExec = dbHandle.exec.bind(dbHandle);
            const calls: string[] = [];
            const execMock = mock.method(dbHandle, "exec", (sql: string) => {
                calls.push(sql);
                if (sql === "COMMIT") {
                    throw new Error("commit failed");
                }
                return originalExec(sql);
            });
            try {
                const result = await updater.registerDockerUpdaterServices();
                assert.equal(result.ok, false);
                assert.equal(result.step, "register-services");
                assert.match(result.stderr, /commit failed/u);
                assert.deepEqual(
                    calls.filter((sql) => sql === "ROLLBACK"),
                    ["ROLLBACK"]
                );
            } finally {
                execMock.mock.restore();
            }

            const beginMock = mock.method(dbHandle, "exec", (sql: string) => {
                if (sql === "BEGIN") {
                    throw new Error("begin failed");
                }
                return originalExec(sql);
            });
            try {
                const result = await updater.registerDockerUpdaterServices();
                assert.equal(result.ok, false);
                assert.equal(result.step, "register-services");
                assert.match(result.stderr, /begin failed/u);
            } finally {
                beginMock.mock.restore();
            }

            const rollbackMock = mock.method(dbHandle, "exec", (sql: string) => {
                if (sql === "COMMIT") {
                    throw new Error("commit failed");
                }
                if (sql === "ROLLBACK") {
                    throw new Error("rollback failed");
                }
                return originalExec(sql);
            });
            try {
                const result = await updater.registerDockerUpdaterServices();
                assert.equal(result.ok, false);
                assert.equal(result.step, "register-services");
                assert.match(result.stderr, /commit failed/u);
                assert.match(result.stderr, /rollback failed/u);
            } finally {
                rollbackMock.mock.restore();
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
        dbHandle
            .prepare(
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
            )
            .run(service);
        const originalRenameSync = fs.renameSync.bind(fs);
        let renameCount = 0;
        mock.method(fs, "renameSync", (...args: Parameters<typeof fs.renameSync>) => {
            renameCount += 1;
            if (renameCount === 2) {
                throw new Error("rollback denied");
            }
            return originalRenameSync(...args);
        });

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
        dbHandle
            .prepare(
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
            )
            .run(service);

        const result = await updater.__testing.applyServiceUpdate(service, "manual");

        assert.equal(result.ok, false);
        assert.match(result.stderr, /compose failed/u);
        assert.equal(await readFile(composePath, "utf8"), originalCompose);
        assert.equal(await readFile(callLogPath, "utf8"), "compose\ncompose\n");
    });

    it("keeps the compose failure when re-applying the restored file also fails", async () => {
        const appDir = path.join(tempDir, "rollback-reapply-fails");
        const binDir = path.join(tempDir, "bin");
        await mkdir(appDir, { recursive: true });
        await mkdir(binDir);
        const composePath = path.join(appDir, "compose.yaml");
        const callLogPath = path.join(tempDir, "compose-failing-calls.log");
        const originalCompose = "services:\n  web:\n    image: nginx:1\n";
        await writeFile(composePath, originalCompose, "utf8");
        await writeExecutable(
            path.join(binDir, "docker"),
            String.raw`#!/usr/bin/env node
const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(callLogPath)}, "compose\n");
process.stderr.write("compose failed\n");
process.exit(12);
`
        );
        process.env.PATH = `${binDir}${path.delimiter}${originalPath || ""}`;
        const updater = await import(
            `./dockerUpdater.js?rollback-reapply-fails=${Date.now()}`
        );
        const service = {
            id: 1,
            app_slug: "rollback-reapply-fails",
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
        dbHandle
            .prepare(
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
            )
            .run(service);

        const result = await updater.__testing.applyServiceUpdate(service, "manual");

        assert.equal(result.ok, false);
        assert.match(result.stderr, /compose failed/u);
        assert.equal(await readFile(composePath, "utf8"), originalCompose);
        assert.equal(await readFile(callLogPath, "utf8"), "compose\ncompose\n");
    });

    it("preserves compose file permissions when rewriting services", async () => {
        const appDir = path.join(tempDir, "metadata-preserve");
        const binDir = path.join(tempDir, "bin");
        await mkdir(appDir, { recursive: true });
        await mkdir(binDir);
        const composePath = path.join(appDir, "compose.yaml");
        const callLogPath = path.join(tempDir, "metadata-compose-calls.log");
        await writeFile(composePath, "services:\n  web:\n    image: nginx:1\n", "utf8");
        await chmod(composePath, 0o600);
        const originalStats = await stat(composePath);
        await writeExecutable(
            path.join(binDir, "docker"),
            String.raw`#!/usr/bin/env node
const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(callLogPath)}, process.argv.slice(2).join(" ") + "\n");
process.exit(0);
`
        );
        process.env.PATH = `${binDir}${path.delimiter}${originalPath || ""}`;
        const updater = await import(
            `./dockerUpdater.js?metadata-preserve=${Date.now()}`
        );
        const service = {
            id: 1,
            app_slug: "metadata-preserve",
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
        dbHandle
            .prepare(
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
            )
            .run(service);
        const originalUnlinkSync = fs.unlinkSync.bind(fs);
        const unlinkMock = mock.method(
            fs,
            "unlinkSync",
            (...args: Parameters<typeof fs.unlinkSync>) => {
                if (String(args[0]).includes(".rollback-")) {
                    throw new Error("cleanup denied");
                }
                return originalUnlinkSync(...args);
            }
        );

        let result;
        try {
            result = await updater.__testing.applyServiceUpdate(service, "manual");
        } finally {
            unlinkMock.mock.restore();
        }

        assert.equal(result.ok, true);
        assert.match(await readFile(composePath, "utf8"), /nginx:2/u);
        assert.match(await readFile(callLogPath, "utf8"), /up -d --pull always web/u);
        const updatedStats = await stat(composePath);
        assert.equal(updatedStats.mode & 0o777, originalStats.mode & 0o777);
        assert.equal(updatedStats.uid, originalStats.uid);
        assert.equal(updatedStats.gid, originalStats.gid);
    });

    it("does not mark applied compose updates as update failures when state persistence fails", async () => {
        const appDir = path.join(tempDir, "reconcile-failure");
        const binDir = path.join(tempDir, "bin");
        await mkdir(appDir, { recursive: true });
        await mkdir(binDir);
        const composePath = path.join(appDir, "compose.yaml");
        const callLogPath = path.join(tempDir, "reconcile-compose-calls.log");
        await writeFile(composePath, "services:\n  web:\n    image: nginx:1\n", "utf8");
        await writeExecutable(
            path.join(binDir, "docker"),
            String.raw`#!/usr/bin/env node
const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(callLogPath)}, process.argv.slice(2).join(" ") + "\n");
process.exit(0);
`
        );
        process.env.PATH = `${binDir}${path.delimiter}${originalPath || ""}`;
        const updater = await import(
            `./dockerUpdater.js?reconcile-failure=${Date.now()}`
        );
        const service = {
            id: 1,
            app_slug: "reconcile-failure",
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
            metadata_json: "{}",
            last_status: "update_available",
        };
        dbHandle
            .prepare(
                `INSERT INTO docker_managed_services (
                id, app_slug, service_name, compose_path, image_repo,
                compose_image_ref, compose_image_field, current_tag, current_digest,
                latest_tag, latest_digest, policy, pin_mode, tag_match_type,
                tag_match_pattern, enabled, metadata_json, last_status
            ) VALUES (
                @id, @app_slug, @service_name, @compose_path, @image_repo,
                @compose_image_ref, @compose_image_field, @current_tag, @current_digest,
                @latest_tag, @latest_digest, @policy, @pin_mode, @tag_match_type,
                @tag_match_pattern, @enabled, @metadata_json, @last_status
            )`
            )
            .run(service);
        const originalPrepare = dbHandle.prepare.bind(dbHandle);
        const prepareMock = mock.method(dbHandle, "prepare", (sql: string) => {
            if (sql.includes("SET compose_image_ref = ?")) {
                throw new Error("reconcile denied");
            }
            return originalPrepare(sql);
        });

        let result;
        try {
            result = await updater.__testing.applyServiceUpdate(service, "manual");
        } finally {
            prepareMock.mock.restore();
        }

        assert.equal(result.ok, false);
        assert.match(
            result.stderr,
            /Docker service updated but failed to persist updater state: reconcile denied/u
        );
        assert.match(await readFile(composePath, "utf8"), /nginx:2/u);
        assert.match(await readFile(callLogPath, "utf8"), /up -d --pull always web/u);
        const row = dbHandle
            .prepare("SELECT last_status FROM docker_managed_services WHERE id = ?")
            .get(service.id) as { last_status: string };
        assert.equal(row.last_status, "update_available");
        const event = dbHandle
            .prepare(
                "SELECT event_type FROM docker_update_events WHERE managed_service_id = ?"
            )
            .get(service.id) as { event_type: string };
        assert.equal(event.event_type, "manual_update_reconcile_failed");
    });

    it("updates symlinked compose targets without replacing the symlink", async () => {
        const rootDir = path.join(tempDir, "symlink-project");
        const appDir = path.join(rootDir, "apps", "symlink-compose");
        const targetDir = path.join(tempDir, "symlink-compose-target");
        const binDir = path.join(tempDir, "bin");
        await mkdir(appDir, { recursive: true });
        await mkdir(targetDir, { recursive: true });
        await mkdir(binDir);
        const projectComposePath = path.join(rootDir, "compose.yaml");
        const composeTargetPath = path.join(targetDir, "compose.yaml");
        const composeLinkPath = path.join(appDir, "compose.yaml");
        const callLogPath = path.join(tempDir, "symlink-compose-calls.log");
        await writeFile(
            projectComposePath,
            "include:\n- apps/symlink-compose/compose.yaml\n",
            "utf8"
        );
        await writeFile(
            composeTargetPath,
            "services:\n  web:\n    image: nginx:1\n",
            "utf8"
        );
        await symlink(composeTargetPath, composeLinkPath);
        await writeExecutable(
            path.join(binDir, "docker"),
            String.raw`#!/usr/bin/env node
const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(callLogPath)}, process.argv.slice(2).join(" ") + "\n");
process.exit(0);
`
        );
        process.env.PATH = `${binDir}${path.delimiter}${originalPath || ""}`;
        const updater = await import(`./dockerUpdater.js?symlink-compose=${Date.now()}`);
        const service = {
            id: 1,
            app_slug: "symlink-compose",
            service_name: "web",
            compose_path: composeLinkPath,
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
        dbHandle
            .prepare(
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
            )
            .run(service);

        const result = await updater.__testing.applyServiceUpdate(service, "manual");

        assert.equal(result.ok, true);
        assert.equal(fs.lstatSync(composeLinkPath).isSymbolicLink(), true);
        assert.match(await readFile(composeTargetPath, "utf8"), /nginx:2/u);
        assert.match(await readFile(composeLinkPath, "utf8"), /nginx:2/u);
        const composeCalls = await readFile(callLogPath, "utf8");
        assert.equal(composeCalls.includes(projectComposePath), true);
        assert.equal(composeCalls.includes(composeTargetPath), false);
        assert.equal(composeCalls.includes(composeLinkPath), false);
    });

    it("runs standalone symlinked compose updates from the real target path", async () => {
        const linkDir = path.join(tempDir, "standalone-symlink-link");
        const targetDir = path.join(tempDir, "standalone-symlink-target");
        const binDir = path.join(tempDir, "standalone-symlink-bin");
        await mkdir(linkDir, { recursive: true });
        await mkdir(targetDir, { recursive: true });
        await mkdir(binDir);
        const composeTargetPath = path.join(targetDir, "compose.yaml");
        const composeLinkPath = path.join(linkDir, "compose.yaml");
        const callLogPath = path.join(tempDir, "standalone-symlink-calls.log");
        await writeFile(
            composeTargetPath,
            "services:\n  web:\n    image: nginx:1\n",
            "utf8"
        );
        await symlink(composeTargetPath, composeLinkPath);
        await writeExecutable(
            path.join(binDir, "docker"),
            String.raw`#!/usr/bin/env node
const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(callLogPath)}, process.argv.slice(2).join(" ") + "\n");
process.exit(0);
`
        );
        process.env.PATH = `${binDir}${path.delimiter}${originalPath || ""}`;
        const updater = await import(
            `./dockerUpdater.js?standalone-symlink-compose=${Date.now()}`
        );
        const service = {
            id: 1,
            app_slug: "standalone-symlink",
            service_name: "web",
            compose_path: composeLinkPath,
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
        dbHandle
            .prepare(
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
            )
            .run(service);

        const result = await updater.__testing.applyServiceUpdate(service, "manual");

        assert.equal(result.ok, true);
        assert.equal(fs.lstatSync(composeLinkPath).isSymbolicLink(), true);
        assert.match(await readFile(composeTargetPath, "utf8"), /nginx:2/u);
        const composeCalls = await readFile(callLogPath, "utf8");
        assert.equal(composeCalls.includes(composeTargetPath), true);
        assert.equal(composeCalls.includes(composeLinkPath), false);
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
        dbHandle
            .prepare(
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
            )
            .run(service);
        const originalWriteFileSync = fs.writeFileSync.bind(fs);
        let writeCount = 0;
        mock.method(
            fs,
            "writeFileSync",
            (...args: Parameters<typeof fs.writeFileSync>) => {
                writeCount += 1;
                if (writeCount === 2) {
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
        assert.equal(writeCount, 2);
    });

    it("leaves the compose file untouched when rollback temp creation fails", async () => {
        const appDir = path.join(tempDir, "direct-restore");
        await mkdir(appDir, { recursive: true });
        const composePath = path.join(appDir, "compose.yaml");
        const originalCompose = "services:\n  web:\n    image: repo/app:1\n";
        await writeFile(composePath, originalCompose, "utf8");
        const updater = await import(`./dockerUpdater.js?direct-restore=${Date.now()}`);
        const service = {
            id: 1,
            app_slug: "direct-restore",
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
        dbHandle
            .prepare(
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
            )
            .run(service);
        let writeCount = 0;
        mock.method(fs, "writeFileSync", () => {
            writeCount += 1;
            if (writeCount === 1) {
                throw new Error("backup failed");
            }
        });

        const result = await updater.__testing.applyServiceUpdate(service, "manual");

        assert.equal(result.ok, false);
        assert.match(result.stderr, /backup failed/u);
        assert.equal(await readFile(composePath, "utf8"), originalCompose);
        assert.equal(writeCount, 1);
    });
});
