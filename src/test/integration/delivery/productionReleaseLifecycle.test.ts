import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import {
    chmod,
    cp,
    lstat,
    mkdir,
    mkdtemp,
    readFile,
    symlink,
    writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { drizzle } from "drizzle-orm/bun-sqlite";
import { Effect } from "effect";
import * as v from "valibot";

import type { BuildSourceIdentity } from "../../../../scripts/buildSourceIdentity.ts";
import { buildProcessArtifacts } from "../../../../scripts/delivery/buildProcesses.ts";
import {
    buildDashboardRelease,
    type ReleaseBuildCommand,
} from "../../../../scripts/delivery/buildRelease.ts";
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
import { jobRunSummarySchema } from "../../../contracts/jobModel.ts";
import { jobRunDetailSchema } from "../../../contracts/jobs.ts";
import { seedAuthenticationTestDatabase } from "../../../server/domains/security/testSupport/authentication.ts";
import { dashboardSessionCookieName } from "../../../server/rawHttp/authenticationCredentials.ts";
import type { ProductionActivationRecord } from "../../../shared/productionActivationRecord.ts";

const sourceProjectRoot = path.resolve(import.meta.dir, "../../../..");
const releaseId = "d".repeat(40);
const lifecycleBrowserHtml =
    "<!doctype html><html><head><title>Mira Dashboard</title></head><body></body></html>";
const temporaryDirectories: string[] = [];
const excludedBuildEntries = new Set([".git", "coverage", "dist", "node_modules"]);
const gatewayTestEnvironment = Object.freeze({
    MIRA_DASHBOARD_WORKSPACE_ROOT: sourceProjectRoot,
    MOLTBOOK_AGENT_NAME: "mira_2026",
    MOLTBOOK_API_KEY: "worker-moltbook-key-test-value",
    OPENCLAW_GATEWAY_TOKEN: "gateway-token-test-value",
    OPENCLAW_GATEWAY_URL: "ws://127.0.0.1:65530",
});

afterEach(async () => {
    await removeProductionDeliveryFixtures(temporaryDirectories);
});

interface LoopbackPortReservation {
    readonly port: number;
    readonly release: () => Promise<void>;
}

function reserveLoopbackPort(): LoopbackPortReservation {
    const server = Bun.serve({
        fetch: () => new Response(null, { status: 503 }),
        hostname: "127.0.0.1",
        port: 0,
    });
    const port = server.port;
    if (port === undefined) {
        void server.stop(true);
        throw new Error("Bun did not assign a loopback port");
    }
    let reserved = true;
    return Object.freeze({
        port,
        async release() {
            if (!reserved) return;
            reserved = false;
            await server.stop(true);
        },
    });
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
        commitTitle: "Lifecycle release",
        state: "clean",
    });
    const release = await buildDashboardRelease(repositoryRoot, {
        resolveSourceIdentity: () => Promise.resolve(sourceIdentity),
        runCommand: materializeLifecycleBuildCommand,
        runtimeIdentity,
    });
    return release.releaseRoot;
}

async function materializeLifecycleBuildCommand(
    command: ReleaseBuildCommand,
    repositoryRoot: string
): Promise<void> {
    switch (command) {
        case "bun run build browser": {
            const browserRoot = path.join(repositoryRoot, "dist/browser");
            await mkdir(browserRoot, { recursive: true });
            await writeFile(path.join(browserRoot, "index.html"), lifecycleBrowserHtml);
            return;
        }
        case "bun run build processes": {
            await buildProcessArtifacts(
                repositoryRoot,
                path.join(repositoryRoot, "dist/processes")
            );
            return;
        }
        case "bun run check database":
        case "bun run check docs": {
            // Dedicated gates cover source validation; this test exercises built runtime bytes.
            return;
        }
    }
}

function webEnvironment(projectRoot: string, port: number): Record<string, string> {
    const encodedKey = Buffer.alloc(32, 7).toString("base64");
    return {
        MIRA_DASHBOARD_LOG_LEVEL: "debug",
        MIRA_DASHBOARD_OPENCLAW_ROOT: path.join(projectRoot, "openclaw-test"),
        MIRA_DASHBOARD_PROJECT_ROOT: projectRoot,
        MIRA_DASHBOARD_PUBLIC_ORIGIN: "https://dashboard.example.com",
        MIRA_DASHBOARD_RECENT_AUTH_MINUTES: "10",
        MIRA_DASHBOARD_RESEND_FROM_EMAIL: "no-reply@example.com",
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
        ...gatewayTestEnvironment,
        MIRA_DASHBOARD_PORT: String(port),
        RESEND_API_KEY: "resend-production-lifecycle-test-value",
    };
}

interface ChildStopResult {
    readonly exitCode: number;
    readonly forced: boolean;
}

async function stopChild(
    child: Bun.Subprocess<"ignore", "ignore", "pipe">
): Promise<ChildStopResult> {
    if (child.exitCode !== null) {
        throw new Error("Production child exited before the shutdown signal");
    }
    child.kill("SIGTERM");
    let deadlineHandle: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<null>((resolve) => {
        deadlineHandle = setTimeout(() => resolve(null), 5000);
        deadlineHandle.unref?.();
    });
    let exitCodeBeforeDeadline: number | null;
    try {
        exitCodeBeforeDeadline = await Promise.race([child.exited, deadline]);
    } finally {
        if (deadlineHandle !== undefined) clearTimeout(deadlineHandle);
    }
    let forced = false;
    if (exitCodeBeforeDeadline === null && child.exitCode === null) {
        child.kill("SIGKILL");
        forced = true;
    }
    const exitCode = await child.exited;
    if (!forced && exitCode !== 0) {
        throw new Error(
            "Production child did not exit cleanly after the shutdown signal"
        );
    }
    return Object.freeze({ exitCode, forced });
}

interface TrpcEnvelope {
    readonly error?: unknown;
    readonly result?: { readonly data?: { readonly json?: unknown } };
}

async function runBundledWorkerSmoke(
    databasePath: string,
    port: number
): Promise<v.InferOutput<typeof jobRunDetailSchema>> {
    const sqlite = new Database(databasePath, {
        create: false,
        readwrite: true,
        strict: true,
    });
    sqlite.exec("PRAGMA busy_timeout = 5000");
    sqlite.exec("PRAGMA foreign_keys = ON");
    let sessionToken: string;
    try {
        sessionToken = seedAuthenticationTestDatabase(
            drizzle({ client: sqlite }),
            new Date()
        ).session.token;
    } finally {
        sqlite.close(true);
    }

    const headers = {
        cookie: `${dashboardSessionCookieName}=${sessionToken}`,
    };
    const enqueueResponse = await fetch(`http://127.0.0.1:${port}/trpc/schedules.run`, {
        body: JSON.stringify({
            json: {
                id: "system.worker-smoke",
                idempotencyKey: "cmVsZWFzZS13b3JrZXItc21va2UtMjAyNi0wOC0wNw",
            },
        }),
        headers: { ...headers, "content-type": "application/json" },
        method: "POST",
    });
    const enqueueBody = (await enqueueResponse.json()) as TrpcEnvelope;
    expect(enqueueResponse.status).toBe(200);
    expect(enqueueBody.error).toBeUndefined();
    const queued = v.parse(jobRunSummarySchema, enqueueBody.result?.data?.json);
    expect(queued).toMatchObject({
        actionKey: "system.worker-smoke",
        state: "queued",
        triggerType: "manual",
    });

    // The coverage worker needs extra time to load instrumented server modules.
    const deadline = Date.now() + 30_000;
    let last: v.InferOutput<typeof jobRunDetailSchema> | undefined;
    while (Date.now() < deadline) {
        const input = encodeURIComponent(JSON.stringify({ json: { id: queued.id } }));
        const response = await fetch(
            `http://127.0.0.1:${port}/trpc/jobs.getRun?input=${input}`,
            { headers }
        );
        const body = (await response.json()) as TrpcEnvelope;
        expect(response.status).toBe(200);
        expect(body.error).toBeUndefined();
        last = v.parse(jobRunDetailSchema, body.result?.data?.json);
        if (last.run.state === "succeeded") return last;
        if (["cancelled", "failed", "timed-out"].includes(last.run.state)) break;
        await Bun.sleep(50);
    }
    throw new Error(
        `Bundled worker smoke did not succeed: ${last?.run.state ?? "missing"}`
    );
}

async function activationDiagnostics(
    stateDirectory: string,
    processStderr: string
): Promise<string> {
    const entries = await Promise.all(
        ["web", "worker"].map(async (processName) => {
            const logPath = path.join(stateDirectory, `logs/${processName}.ndjson`);
            const contents = await readFile(logPath, "utf8").catch(() => "<missing>");
            return `${processName}: ${contents}`;
        })
    );
    return `${entries.join("\n")}\nstderr:\n${processStderr}`;
}

class DirectProcessController implements ProductionServiceController {
    readonly #lease: Parameters<typeof pointProductionProcessesAtRelease>[0];
    readonly #paths: Parameters<typeof pointProductionProcessesAtRelease>[1];
    readonly #port: number;
    readonly #projectRoot: string;
    readonly #portReservation: LoopbackPortReservation;
    readonly #stopResults: Array<
        ChildStopResult & { readonly process: "web" | "worker" }
    > = [];
    #web: Bun.Subprocess<"ignore", "ignore", "pipe"> | undefined;
    #webStderr = Promise.resolve("");
    #worker: Bun.Subprocess<"ignore", "ignore", "pipe"> | undefined;
    #workerStderr = Promise.resolve("");

    constructor(
        lease: Parameters<typeof pointProductionProcessesAtRelease>[0],
        paths: Parameters<typeof pointProductionProcessesAtRelease>[1],
        projectRoot: string,
        portReservation: LoopbackPortReservation
    ) {
        this.#lease = lease;
        this.#paths = paths;
        this.#projectRoot = projectRoot;
        this.#port = portReservation.port;
        this.#portReservation = portReservation;
    }

    provision(): Promise<void> {
        return Promise.resolve();
    }

    prepare(): Promise<void> {
        return Promise.resolve();
    }

    get stopResults(): readonly (ChildStopResult & {
        readonly process: "web" | "worker";
    })[] {
        return Object.freeze([...this.#stopResults]);
    }

    async stderrDiagnostics(): Promise<string> {
        const [web, worker] = await Promise.all([this.#webStderr, this.#workerStderr]);
        return `web stderr: ${web || "<empty>"}\nworker stderr: ${worker || "<empty>"}`;
    }

    async start(
        release: PublishedProductionRelease,
        runtime: InstalledProductionRuntime
    ): Promise<void> {
        await this.stop();
        await this.#portReservation.release();
        const openClawRoot = path.join(this.#projectRoot, "openclaw-test");
        await mkdir(openClawRoot, { mode: 0o700, recursive: true });
        await chmod(openClawRoot, 0o700);
        await pointProductionProcessesAtRelease(
            this.#lease,
            this.#paths,
            release,
            runtime
        );
        const common = {
            cwd: release.releaseRoot,
            stderr: "pipe" as const,
            stdin: "ignore" as const,
            stdout: "ignore" as const,
        };
        this.#worker = Bun.spawn(
            [runtime.executable, path.join(release.releaseRoot, "server/worker.js")],
            {
                ...common,
                env: {
                    MIRA_DASHBOARD_LOG_LEVEL: "debug",
                    MIRA_DASHBOARD_OPENCLAW_ROOT: openClawRoot,
                    MIRA_DASHBOARD_PROJECT_ROOT: this.#projectRoot,
                    NODE_ENV: "production",
                    ...gatewayTestEnvironment,
                },
            }
        );
        this.#workerStderr = new Response(this.#worker.stderr).text();
        this.#web = Bun.spawn(
            [runtime.executable, path.join(release.releaseRoot, "server/web.js")],
            { ...common, env: webEnvironment(this.#projectRoot, this.#port) }
        );
        this.#webStderr = new Response(this.#web.stderr).text();
    }

    async stop(): Promise<void> {
        const web = this.#web;
        const worker = this.#worker;
        if (!web && !worker) return;
        this.#web = undefined;
        this.#worker = undefined;
        if (!web || !worker) {
            const child = web ?? worker;
            if (child && child.exitCode === null) {
                child.kill("SIGKILL");
                await child.exited;
            }
            throw new Error("Production process pair was incomplete during shutdown");
        }
        const failures: unknown[] = [];
        try {
            this.#stopResults.push(
                Object.freeze({ ...(await stopChild(web)), process: "web" })
            );
        } catch (error) {
            failures.push(error);
        }
        try {
            this.#stopResults.push(
                Object.freeze({ ...(await stopChild(worker)), process: "worker" })
            );
        } catch (error) {
            failures.push(error);
        }
        if (failures.length > 0) {
            throw new AggregateError(failures, "Production process shutdown failed");
        }
    }

    async verifyReady(): Promise<void> {
        // Coverage instrumentation and parallel CI can make the first production
        // process startup materially slower than an uninstrumented local run.
        const deadline = Date.now() + 30_000;
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

    verifySmoke(): Promise<void> {
        return this.verifyReady();
    }
}

describe("disposable production release lifecycle", () => {
    test("rejects a child that exits before its shutdown signal", async () => {
        const child = Bun.spawn([process.execPath, "-e", "process.exit(0)"], {
            stderr: "pipe",
            stdin: "ignore",
            stdout: "ignore",
        });
        expect(await child.exited).toBe(0);
        let stopError: unknown;
        try {
            await stopChild(child);
        } catch (error) {
            stopError = error;
        }
        expect(stopError).toBeInstanceOf(Error);
        expect((stopError as Error).message).toBe(
            "Production child exited before the shutdown signal"
        );
    });

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
        const portReservation = reserveLoopbackPort();
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
            const services = new DirectProcessController(
                lease,
                paths,
                projectRoot,
                portReservation
            );
            try {
                let activation: ProductionActivationRecord;
                try {
                    activation = await Effect.runPromise(
                        activatePublishedProductionRelease(
                            lease,
                            paths,
                            release,
                            runtime,
                            { services }
                        )
                    );
                } catch (error) {
                    process.stderr.write(
                        `Production lifecycle activation diagnostics:\n${await activationDiagnostics(paths.stateDirectory, await services.stderrDiagnostics())}\n`
                    );
                    throw error;
                }
                expect(activation.current).toEqual({
                    releaseId,
                    runtimeRevision: Bun.revision,
                });
                const browser = await fetch(`http://127.0.0.1:${portReservation.port}/`);
                expect(browser.status).toBe(200);
                expect(browser.headers.get("content-type")).toContain("text/html");
                expect(await browser.text()).toBe(lifecycleBrowserHtml);
                const smoke = await runBundledWorkerSmoke(
                    path.join(paths.stateDirectory, "mira-dashboard.db"),
                    portReservation.port
                );
                expect(smoke.result).toMatchObject({
                    databaseReleaseId: releaseId,
                    status: "ok",
                });
                await services.stop();
                expect(services.stopResults).toEqual([
                    { exitCode: 0, forced: false, process: "web" },
                    { exitCode: 0, forced: false, process: "worker" },
                ]);
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
                expect(workerLog).toContain('"event":"runtime.stopped"');
                expect(databaseStatus.isFile()).toBeTrue();
                expect(databaseStatus.mode & 0o777n).toBe(0o600n);
            } finally {
                await services.stop();
                await portReservation.release();
            }
        });
    }, 120_000);
});
