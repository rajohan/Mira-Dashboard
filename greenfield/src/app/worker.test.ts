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
        packages: [{ name: "effect", scope: "dependency", version: "4.0.0-beta.104" }],
        processRoles: [...releaseProcessRoles],
        runtime: { revision, version: "1.4.0" },
        source: { commitSha: releaseId, treeState: "clean" },
    }),
    releaseRoot: `${layout.production.releases}/${releaseId}`,
});

function processFixture(initializationFailure?: Error) {
    const events: string[] = [];
    const logLines: string[] = [];
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
        forceSignal: new AbortController().signal,
        termination: Promise.resolve("SIGTERM" as const),
    });
    const runtime: DashboardWorkerRuntime = Object.freeze({
        dispose() {
            events.push("runtime-dispose");
            return Promise.resolve();
        },
        initialize() {
            events.push("runtime-initialize");
            if (initializationFailure) return Promise.reject(initializationFailure);
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
    return { dependencies, events, logLines };
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
});
