import { afterEach, describe, expect, test } from "bun:test";
import { cp, lstat, mkdtemp, readFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { Effect } from "effect";

import type { BuildSourceIdentity } from "../../../../scripts/buildSourceIdentity.ts";
import { buildDashboardRelease } from "../../../../scripts/delivery/buildRelease.ts";
import { withDeploymentLease } from "../../../../scripts/delivery/deploymentLease.ts";
import { prepareProductionDeliveryDirectories } from "../../../../scripts/delivery/productionDeliveryFilesystem.ts";
import {
    activatePublishedProductionRelease,
    type ProductionServiceController,
} from "../../../../scripts/delivery/productionReleaseActivation.ts";
import { publishProductionRelease } from "../../../../scripts/delivery/productionReleasePublication.ts";
import type { PublishedProductionRelease } from "../../../../scripts/delivery/productionReleasePublication.ts";
import { installProductionRuntime } from "../../../../scripts/delivery/productionRuntime.ts";
import type { InstalledProductionRuntime } from "../../../../scripts/delivery/productionRuntime.ts";
import { pointProductionProcessesAtRelease } from "../../../../scripts/delivery/productionRuntimePointers.ts";
import { prepareProtectedProductionStatePath } from "../../../../scripts/delivery/productionStateFilesystem.ts";
import type { ReleaseRuntimeIdentity } from "../../../../scripts/delivery/releaseIdentity.ts";
import { removeProductionDeliveryFixtures } from "../../../../scripts/testSupport/productionDeliveryFixture.ts";

const sourceProjectRoot = path.resolve(import.meta.dir, "../../../..");
const releaseId = "d".repeat(40);
const temporaryDirectories: string[] = [];
const excludedBuildEntries = new Set([".git", "coverage", "dist", "node_modules"]);

afterEach(async () => {
    await removeProductionDeliveryFixtures(temporaryDirectories);
});

async function unusedLoopbackPort(): Promise<number> {
    const server = Bun.serve({
        fetch: () => new Response(null, { status: 503 }),
        hostname: "127.0.0.1",
        port: 0,
    });
    const port = server.port;
    await server.stop(true);
    if (port === undefined) throw new Error("Bun did not assign a loopback port");
    return port;
}

async function realReleaseFixture(
    runtimeIdentity: ReleaseRuntimeIdentity
): Promise<string> {
    const fixtureParent = await mkdtemp(
        path.join(tmpdir(), "mira-production-lifecycle-build-")
    );
    temporaryDirectories.push(fixtureParent);
    const repositoryRoot = path.join(fixtureParent, "checkout");
    await cp(sourceProjectRoot, repositoryRoot, {
        filter(source) {
            const relative = path.relative(sourceProjectRoot, source);
            const rootEntry = relative.split(path.sep)[0];
            return relative.length === 0 || !excludedBuildEntries.has(rootEntry ?? "");
        },
        recursive: true,
    });
    await symlink(
        path.join(sourceProjectRoot, "node_modules"),
        path.join(repositoryRoot, "node_modules"),
        "dir"
    );
    const sourceIdentity: BuildSourceIdentity = Object.freeze({
        commitSha: releaseId,
        state: "clean",
    });
    const release = await buildDashboardRelease(repositoryRoot, {
        resolveSourceIdentity: () => sourceIdentity,
        runtimeIdentity,
    });
    return release.releaseRoot;
}

function webEnvironment(projectRoot: string, port: number): Record<string, string> {
    const encodedKey = Buffer.alloc(32, 7).toString("base64");
    return {
        MIRA_DASHBOARD_LOG_LEVEL: "debug",
        MIRA_DASHBOARD_PROJECT_ROOT: projectRoot,
        MIRA_DASHBOARD_PUBLIC_ORIGIN: "https://dashboard.example.com",
        MIRA_DASHBOARD_RECENT_AUTH_MINUTES: "10",
        MIRA_DASHBOARD_SESSION_IDLE_MINUTES: "30",
        MIRA_DASHBOARD_TOTP_KEYRING: JSON.stringify({
            activeKeyId: "primary",
            formatVersion: 1,
            keys: [{ id: "primary", keyBase64: encodedKey }],
        }),
        MIRA_DASHBOARD_TRUSTED_PROXY_IPS: "127.0.0.1,::1",
        MIRA_DASHBOARD_WEBAUTHN_ORIGINS: "https://dashboard.example.com",
        MIRA_DASHBOARD_WEBAUTHN_RP_ID: "example.com",
        MIRA_DASHBOARD_WEBAUTHN_RP_NAME: "Mira Dashboard",
        NODE_ENV: "production",
        OPENCLAW_GATEWAY_URL: "ws://127.0.0.1:65530",
        PORT: String(port),
    };
}

async function stopChild(
    child: Bun.Subprocess<"ignore", "ignore", "ignore"> | undefined
): Promise<void> {
    if (!child || child.exitCode !== null) return;
    child.kill("SIGTERM");
    const exited = await Promise.race([
        child.exited.then(() => true),
        Bun.sleep(5000).then(() => false),
    ]);
    if (!exited && child.exitCode === null) {
        child.kill("SIGKILL");
        await child.exited;
    }
}

class DirectProcessController implements ProductionServiceController {
    readonly #lease: Parameters<typeof pointProductionProcessesAtRelease>[0];
    readonly #paths: Parameters<typeof pointProductionProcessesAtRelease>[1];
    readonly #port: number;
    readonly #projectRoot: string;
    #web: Bun.Subprocess<"ignore", "ignore", "ignore"> | undefined;
    #worker: Bun.Subprocess<"ignore", "ignore", "ignore"> | undefined;

    constructor(
        lease: Parameters<typeof pointProductionProcessesAtRelease>[0],
        paths: Parameters<typeof pointProductionProcessesAtRelease>[1],
        projectRoot: string,
        port: number
    ) {
        this.#lease = lease;
        this.#paths = paths;
        this.#projectRoot = projectRoot;
        this.#port = port;
    }

    prepare(): Promise<void> {
        return Promise.resolve();
    }

    async start(
        release: PublishedProductionRelease,
        runtime: InstalledProductionRuntime
    ): Promise<void> {
        await this.stop();
        await pointProductionProcessesAtRelease(
            this.#lease,
            this.#paths,
            release,
            runtime
        );
        const common = {
            cwd: release.releaseRoot,
            stderr: "ignore" as const,
            stdin: "ignore" as const,
            stdout: "ignore" as const,
        };
        this.#worker = Bun.spawn(
            [runtime.executable, path.join(release.releaseRoot, "server/worker.js")],
            {
                ...common,
                env: {
                    MIRA_DASHBOARD_LOG_LEVEL: "debug",
                    MIRA_DASHBOARD_PROJECT_ROOT: this.#projectRoot,
                    NODE_ENV: "production",
                },
            }
        );
        await Bun.sleep(100);
        if (this.#worker.exitCode !== null) throw new Error("Worker exited early");
        this.#web = Bun.spawn(
            [runtime.executable, path.join(release.releaseRoot, "server/web.js")],
            { ...common, env: webEnvironment(this.#projectRoot, this.#port) }
        );
        await Bun.sleep(100);
        if (this.#web.exitCode !== null) throw new Error("Web exited early");
    }

    async stop(): Promise<void> {
        const web = this.#web;
        const worker = this.#worker;
        this.#web = undefined;
        this.#worker = undefined;
        await stopChild(web);
        await stopChild(worker);
    }

    async verifyReady(): Promise<void> {
        const deadline = Date.now() + 15_000;
        const readinessUrl = `http://127.0.0.1:${this.#port}/api/health/ready`;
        while (Date.now() < deadline) {
            if (this.#web?.exitCode !== null || this.#worker?.exitCode !== null) {
                throw new Error("Production process exited before readiness");
            }
            try {
                const response = await fetch(readinessUrl, {
                    cache: "no-store",
                    signal: AbortSignal.timeout(1000),
                });
                if (response.status === 200) return;
            } catch {
                // Retry only within the bounded activation readiness window.
            }
            await Bun.sleep(50);
        }
        throw new Error("Production readiness timed out");
    }
}

describe("disposable production release lifecycle", () => {
    test("builds, migrates, activates, serves, logs, and shuts down exact artifacts", async () => {
        const runtimeIdentity = Object.freeze({
            revision: Bun.revision,
            version: Bun.version,
        });
        const sourceRelease = await realReleaseFixture(runtimeIdentity);
        const projectRoot = await mkdtemp(
            path.join(tmpdir(), "mira-production-lifecycle-target-")
        );
        temporaryDirectories.push(projectRoot);
        const state = await prepareProtectedProductionStatePath(projectRoot);
        const port = await unusedLoopbackPort();
        await withDeploymentLease(state.stateDirectory, async (lease) => {
            const paths = await prepareProductionDeliveryDirectories(state);
            const runtime = await installProductionRuntime(
                lease,
                paths,
                runtimeIdentity,
                { sourceExecutable: process.execPath }
            );
            const release = await publishProductionRelease(
                lease,
                paths,
                sourceRelease,
                runtimeIdentity
            );
            const services = new DirectProcessController(lease, paths, projectRoot, port);
            try {
                const activation = await Effect.runPromise(
                    activatePublishedProductionRelease(lease, paths, release, runtime, {
                        services,
                    })
                );
                expect(activation.current).toEqual({
                    releaseId,
                    runtimeRevision: Bun.revision,
                });
                const browser = await fetch(`http://127.0.0.1:${port}/`);
                expect(browser.status).toBe(200);
                expect(await browser.text()).toContain("<title>Mira Dashboard</title>");
                const [webLog, workerLog, databaseStatus] = await Promise.all([
                    readFile(path.join(paths.stateDirectory, "logs/web.ndjson"), "utf8"),
                    readFile(
                        path.join(paths.stateDirectory, "logs/worker.ndjson"),
                        "utf8"
                    ),
                    lstat(path.join(paths.stateDirectory, "mira-dashboard.db"), {
                        bigint: true,
                    }),
                ]);
                expect(webLog).toContain('"event":"runtime.started"');
                expect(workerLog).toContain('"event":"runtime.started"');
                expect(databaseStatus.isFile()).toBeTrue();
                expect(databaseStatus.mode & 0o777n).toBe(0o600n);
            } finally {
                await services.stop();
            }
        });
    }, 120_000);
});
