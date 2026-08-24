import { describe, expect, test } from "bun:test";

import { deriveDashboardProjectLayout } from "../server/platform/filesystem/projectLayout.ts";
import type { ProjectFileLogDestination } from "../server/platform/observability/projectFileLogSink.ts";
import type { RuntimeRelease } from "../server/platform/release/runtimeRelease.ts";
import type { ProcessTerminationController } from "../server/platform/runtime/processSignals.ts";
import {
    parseReleaseManifest,
    releaseBuildCommands,
    releaseProcessRoles,
} from "../shared/releaseManifest.ts";
import type { DashboardWorkerRuntime } from "../worker/runtime.ts";
import {
    type DashboardWorkerProcessDependencies,
    runDashboardWorkerProcess,
} from "./worker.ts";

const projectRoot = "/srv/mira-dashboard";
const releaseId = "b".repeat(40);
const revision = "a".repeat(40);
const checksum = "c".repeat(64);
const layout = deriveDashboardProjectLayout(projectRoot);
const release: RuntimeRelease = Object.freeze({
    manifest: parseReleaseManifest({
        artifacts: [{ bytes: 3, path: "server/worker.js", sha256: checksum }],
        buildCommands: [...releaseBuildCommands],
        documentationSha256: checksum,
        formatVersion: 1,
        lockfileSha256: checksum,
        migrations: [
            {
                id: "20260804022252_dashboard-foundation",
                migrationSha256: checksum,
                snapshotSha256: checksum,
            },
        ],
        packages: [{ name: "effect", scope: "dependency", version: "4.0.0-beta.106" }],
        processRoles: [...releaseProcessRoles],
        runtime: { revision, version: "1.4.0" },
        source: { commitSha: releaseId, treeState: "clean" },
    }),
    releaseRoot: `${layout.production.releases}/${releaseId}`,
});

function processFixture(
    initializationFailure?: Error,
    runtimeFailure?: Error,
    runtimeStopsUnexpectedly = false,
    waitForForceDuringDisposal = false
) {
    const events: string[] = [];
    const logLines: string[] = [];
    const forceSignals: Array<AbortSignal | undefined> = [];
    const forceController = new AbortController();
    let resolveDisposalStarted: (() => void) | undefined;
    const disposalStarted = new Promise<void>((resolve) => {
        resolveDisposalStarted = resolve;
    });
    let resolveCompletion: (() => void) | undefined;
    let rejectCompletion: ((error: unknown) => void) | undefined;
    const completion = new Promise<void>((resolve, reject) => {
        resolveCompletion = resolve;
        rejectCompletion = reject;
    });
    const destination = Object.freeze({
        fallbackWrite() {
            events.push("log-fallback");
        },
        sink: Object.freeze({
            flush(): undefined {
                events.push("log-flush");
                return;
            },
            write(line: string): undefined {
                logLines.push(line);
                return;
            },
        }),
    } satisfies ProjectFileLogDestination);
    const termination: ProcessTerminationController = Object.freeze({
        dispose() {
            events.push("signals-dispose");
        },
        forceSignal: forceController.signal,
        termination:
            runtimeFailure !== undefined || runtimeStopsUnexpectedly
                ? new Promise<"SIGTERM">(() => {})
                : Promise.resolve("SIGTERM" as const),
    });
    const runtime: DashboardWorkerRuntime = Object.freeze({
        completion,
        dispose(forceSignal?: AbortSignal) {
            events.push("runtime-dispose");
            forceSignals.push(forceSignal);
            resolveDisposalStarted?.();
            if (waitForForceDuringDisposal) {
                if (forceSignal === undefined) {
                    return Promise.reject(
                        new Error("Runtime cleanup did not receive the force signal")
                    );
                }
                if (!forceSignal.aborted) {
                    return new Promise<void>((resolve) => {
                        forceSignal.addEventListener("abort", () => resolve(), {
                            once: true,
                        });
                    });
                }
            }
            resolveCompletion?.();
            return Promise.resolve();
        },
        initialize() {
            events.push("runtime-initialize");
            if (initializationFailure) {
                rejectCompletion?.(initializationFailure);
                return Promise.reject(initializationFailure);
            }
            if (runtimeFailure) {
                queueMicrotask(() => rejectCompletion?.(runtimeFailure));
            } else if (runtimeStopsUnexpectedly) {
                queueMicrotask(() => resolveCompletion?.());
            }
            return Promise.resolve();
        },
    });
    const dependencies = Object.freeze({
        createLogDestination(logsDirectory, processRole) {
            events.push(`logs:${processRole}:${logsDirectory}`);
            return destination;
        },
        createRuntime(_configuration, observedLayout, observedRelease, logger) {
            expect(observedLayout).toBe(layout);
            expect(observedRelease).toBe(release);
            expect(logger).toBeDefined();
            events.push("runtime-create");
            return runtime;
        },
        createTerminationController() {
            events.push("signals-create");
            return termination;
        },
        loadRelease(releasesDirectory, releaseRoot, processRole) {
            events.push(`release:${processRole}:${releasesDirectory}:${releaseRoot}`);
            return Promise.resolve(release);
        },
        resolveProjectLayout(observedProjectRoot) {
            events.push(`layout:${observedProjectRoot}`);
            return Promise.resolve(layout);
        },
    } satisfies DashboardWorkerProcessDependencies);
    return {
        dependencies,
        disposalStarted,
        events,
        forceController,
        forceSignals,
        logLines,
    };
}

const processOptions = Object.freeze({
    configurationSource: {
        MIRA_DASHBOARD_LOG_LEVEL: "debug",
        MIRA_DASHBOARD_PROJECT_ROOT: projectRoot,
        NODE_ENV: "production",
    },
    releaseRoot: release.releaseRoot,
});

describe("Dashboard worker process", () => {
    test("validates its release and database before waiting for shutdown", async () => {
        const fixture = processFixture();

        await runDashboardWorkerProcess(processOptions, fixture.dependencies);

        expect(fixture.events).toEqual([
            `layout:${projectRoot}`,
            `release:worker:${layout.production.releases}:${release.releaseRoot}`,
            `logs:worker:${layout.production.state.logs}`,
            "signals-create",
            "runtime-create",
            "runtime-initialize",
            "runtime-dispose",
            "signals-dispose",
            "log-flush",
        ]);
        expect(
            fixture.logLines.map((line) => (JSON.parse(line) as { event: string }).event)
        ).toEqual(["runtime.started", "runtime.stopped"]);
        expect(fixture.forceSignals).toEqual([
            expect.objectContaining({ aborted: false }),
        ]);
    });

    test("disposes partial ownership and reports a redacted startup failure", () => {
        const failure = new Error("private worker failure");
        const fixture = processFixture(failure);

        expect(
            runDashboardWorkerProcess(processOptions, fixture.dependencies)
        ).rejects.toBe(failure);

        expect(fixture.events).toContain("runtime-dispose");
        expect(fixture.events.slice(-2)).toEqual(["signals-dispose", "log-flush"]);
        const fatal = JSON.parse(fixture.logLines.at(-1) ?? "null") as {
            event: string;
            failure?: unknown;
        };
        expect(fatal.event).toBe("runtime.start_failed");
        expect(JSON.stringify(fatal)).not.toContain("private worker failure");
    });

    test("disposes and fails when the durable coordinator exits unexpectedly", async () => {
        const failure = new Error("private coordinator failure");
        const fixture = processFixture(undefined, failure);

        expect(
            await runDashboardWorkerProcess(processOptions, fixture.dependencies).catch(
                (error: unknown) => error
            )
        ).toBe(failure);

        expect(fixture.events).toContain("runtime-dispose");
        const fatal = JSON.parse(fixture.logLines.at(-1) ?? "null") as {
            event: string;
            failure?: unknown;
        };
        expect(fatal.event).toBe("runtime.start_failed");
        expect(JSON.stringify(fatal)).not.toContain("private coordinator failure");
    });

    test("allows a second signal to force runtime-failure cleanup", async () => {
        const failure = new Error("private coordinator failure");
        const fixture = processFixture(undefined, failure, false, true);
        const execution = runDashboardWorkerProcess(processOptions, fixture.dependencies);

        await fixture.disposalStarted;
        expect(
            await Promise.race([
                execution.then(
                    () => "settled" as const,
                    () => "settled" as const
                ),
                Bun.sleep(10).then(() => "waiting" as const),
            ])
        ).toBe("waiting");

        fixture.forceController.abort(
            new DOMException("Forced process shutdown requested", "AbortError")
        );

        expect(await execution.catch((error: unknown) => error)).toBe(failure);
        expect(fixture.forceSignals).toEqual([fixture.forceController.signal]);
    });

    test("fails closed when the durable runtime resolves before a signal", async () => {
        const fixture = processFixture(undefined, undefined, true);

        expect(
            await runDashboardWorkerProcess(processOptions, fixture.dependencies).catch(
                (error: unknown) => error
            )
        ).toEqual(new Error("Dashboard worker runtime stopped unexpectedly"));

        expect(fixture.events).toContain("runtime-dispose");
        const fatal = JSON.parse(fixture.logLines.at(-1) ?? "null") as {
            event: string;
        };
        expect(fatal.event).toBe("runtime.start_failed");
    });
});
