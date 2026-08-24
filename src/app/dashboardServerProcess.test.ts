import { describe, expect, test } from "bun:test";

import { Redacted } from "effect";

import { rejectionError } from "../../scripts/testSupport/rejection.ts";
import { testTotpSecretCipher } from "../server/domains/security/testSupport/authentication.ts";
import { deriveDashboardProjectLayout } from "../server/platform/filesystem/projectLayout.ts";
import type { ProjectFileLogDestination } from "../server/platform/observability/projectFileLogSink.ts";
import type { DashboardApplicationRuntime } from "../server/platform/runtime/applicationRuntime.ts";
import type { ProcessTerminationController } from "../server/platform/runtime/processSignals.ts";
import {
    parseReleaseManifest,
    releaseBuildCommands,
    releaseDeliveryProtocols,
    releaseProcessRoles,
} from "../shared/releaseManifest.ts";
import {
    type DashboardWebProcessDependencies,
    resolveTerminalWorkspaceRoots,
    runDashboardWebProcess,
} from "./dashboardServer.ts";
import type { ApplicationServer } from "./server.ts";

const projectRoot = "/srv/mira-dashboard";
const openClawRoot = "/srv/openclaw";
const workspaceRoot = "/srv/mira-workspace";
const releaseId = "b".repeat(40);
const revision = "a".repeat(40);
const checksum = "c".repeat(64);
const layout = deriveDashboardProjectLayout(projectRoot);
const release = Object.freeze({
    manifest: parseReleaseManifest({
        artifacts: [{ bytes: 3, path: "server/web.js", sha256: checksum }],
        buildCommands: [...releaseBuildCommands],
        deliveryProtocols: [...releaseDeliveryProtocols],
        display: { builtAtMs: 1, commitTitle: "Test release", schemaTarget: 1 },
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

function encodedKey(byte: number): string {
    return Buffer.alloc(32, byte).toString("base64");
}

const serializedKeyring = JSON.stringify({
    activeKeyId: "primary",
    formatVersion: 1,
    keys: [{ id: "primary", keyBase64: encodedKey(1) }],
});

const processOptions = Object.freeze({
    configurationSource: {
        ELEVENLABS_API_KEY: "elevenlabs-api-key-test-value",
        MIRA_DASHBOARD_LOG_LEVEL: "debug",
        MIRA_DASHBOARD_OPENCLAW_ROOT: openClawRoot,
        MIRA_DASHBOARD_PROJECT_ROOT: projectRoot,
        MIRA_DASHBOARD_PUBLIC_ORIGIN: "https://dashboard.example.com",
        MIRA_DASHBOARD_RECENT_AUTH_MINUTES: "10",
        MIRA_DASHBOARD_RESEND_FROM_EMAIL: "no-reply@example.com",
        MIRA_DASHBOARD_SESSION_IDLE_MINUTES: "30",
        MIRA_DASHBOARD_TOTP_KEYRING: serializedKeyring,
        MIRA_DASHBOARD_TRUSTED_PROXY_IPS: "127.0.0.1,::1",
        MIRA_DASHBOARD_WORKSPACE_ROOT: workspaceRoot,
        MIRA_DASHBOARD_WEBAUTHN_ORIGINS: "https://dashboard.example.com",
        MIRA_DASHBOARD_WEBAUTHN_RP_ID: "example.com",
        MIRA_DASHBOARD_WEBAUTHN_RP_NAME: "Mira Dashboard",
        NODE_ENV: "production",
        OPENCLAW_GATEWAY_TOKEN: "gateway-token-test-value",
        OPENCLAW_GATEWAY_URL: "ws://127.0.0.1:18789",
        PORT: "3100",
        RESEND_API_KEY: "resend-dashboard-process-test-value",
    },
    releaseRoot: release.releaseRoot,
});

test("resolves configured terminal roots without web-sandbox-only paths", async () => {
    const roots = await resolveTerminalWorkspaceRoots(
        openClawRoot,
        projectRoot,
        workspaceRoot
    );

    expect(roots).toEqual([
        { id: "workspace", label: "Workspace", path: workspaceRoot },
        { id: "openclaw", label: "OpenClaw", path: openClawRoot },
        { id: "docker", label: "Docker", optional: true, path: "/opt/docker" },
        { id: "dashboard", label: "Mira Dashboard", path: projectRoot },
    ]);
    expect(Object.isFrozen(roots)).toBe(true);
    expect(roots.every((root) => Object.isFrozen(root))).toBe(true);
});

function unhandledFrontendAsset(): Promise<Response | undefined> {
    return Promise.resolve<Response | undefined>(void 0);
}

function processFixture(totpFailure?: Error, cutoverValidation = false) {
    const events: string[] = [];
    const logLines: string[] = [];
    const destination = Object.freeze({
        fallbackWrite() {
            events.push("log-fallback");
        },
        sink: Object.freeze({
            flush(): undefined {
                events.push("log-flush");
            },
            write(line: string): undefined {
                logLines.push(line);
            },
        }),
    } satisfies ProjectFileLogDestination);
    const termination = Object.freeze({
        dispose() {
            events.push("signals-dispose");
        },
        forceSignal: new AbortController().signal,
        termination: Promise.resolve("SIGTERM" as const),
    } satisfies ProcessTerminationController);
    let runtime: DashboardApplicationRuntime | undefined;
    const dependencies = Object.freeze({
        createFrontendAssets(observedRelease) {
            expect(observedRelease).toBe(release);
            events.push("frontend-create");
            return Promise.resolve(unhandledFrontendAsset);
        },
        createLogDestination(logsDirectory, processRole) {
            events.push(`logs:${processRole}:${logsDirectory}`);
            return destination;
        },
        createRuntime(_configuration, observedLayout, observedRelease, logger) {
            expect(observedLayout).toBe(layout);
            expect(observedRelease).toBe(release);
            events.push("runtime-create");
            runtime = Object.freeze({ logger }) as DashboardApplicationRuntime;
            return runtime;
        },
        createServer(options) {
            const observedRuntime = runtime;
            if (!observedRuntime) throw new Error("Expected composed runtime");
            expect(options.applicationRuntime).toBe(observedRuntime);
            expect(options.readiness.isReady()).toBe(false);
            expect(options.browserOrigin).toBe("https://dashboard.example.com");
            expect(options.dashboardLogsRoot).toBe(layout.production.state.logs);
            expect(options.dashboardLogMaintenanceRoot).toBe(
                layout.production.state.logMaintenance
            );
            expect(Redacted.value(options.elevenLabsApiKey!)).toBe(
                "elevenlabs-api-key-test-value"
            );
            expect(options.frontendAssets).toBeFunction();
            if (cutoverValidation) {
                expect(options.cutoverValidation).toBeTrue();
                expect(
                    options.jobActionDefinitions?.map(({ actionKey }) => actionKey)
                ).toEqual(["system.worker-smoke"]);
            } else {
                expect(options.cutoverValidation).toBeUndefined();
                expect(options.jobActionDefinitions).toBeUndefined();
            }
            expect(options.port).toBe(3100);
            expect(options.verifiedReleaseId).toBe(releaseId);
            expect(options.openClawFileRoot).toEqual({
                id: "openclaw-config",
                label: "OpenClaw Config",
                manifest: [
                    {
                        contentPolicy: "redacted-config-json",
                        maximumSizeBytes: 2_097_152,
                        segments: ["openclaw.json"],
                        uploadContentPolicy: "reject-redaction-sentinel",
                        writable: true,
                    },
                    {
                        contentPolicy: "raw",
                        maximumSizeBytes: 2_097_152,
                        segments: ["hooks", "transforms", "agentmail.ts"],
                        uploadContentPolicy: "reject-redaction-sentinel",
                        writable: true,
                    },
                ],
                path: openClawRoot,
                writable: false,
            });
            expect(options.workspaceFileRoot).toEqual({
                id: "workspace",
                label: "Workspace",
                path: workspaceRoot,
                writable: true,
            });
            expect(options.workspaceFileUploadSpoolRoot).toBe(
                layout.production.state.workspaceFileUploads
            );
            expect(options.terminalBrokerDirectory).toBe(
                layout.production.state.terminalBroker
            );
            expect(options.terminalBrokerSocket).toBe(
                layout.production.state.terminalBrokerSocket
            );
            expect(options.terminalRoots).toEqual([
                {
                    id: "workspace",
                    label: "Workspace",
                    path: workspaceRoot,
                },
                {
                    id: "openclaw",
                    label: "OpenClaw",
                    path: openClawRoot,
                },
                {
                    id: "docker",
                    label: "Docker",
                    optional: true,
                    path: "/opt/docker",
                },
                {
                    id: "dashboard",
                    label: "Mira Dashboard",
                    path: layout.root,
                },
            ]);
            events.push("server-create");
            const server = Object.freeze({
                port: 3100,
                stop(force = false) {
                    expect(options.readiness.isReady()).toBe(true);
                    events.push(`server-stop:${force ? "force" : "graceful"}`);
                    options.readiness.markUnavailable();
                    options.applicationRuntime.logger.flush();
                    return Promise.resolve();
                },
                url: new URL("http://127.0.0.1:3100/"),
            } satisfies ApplicationServer);
            return Promise.resolve(server);
        },
        createTerminationController() {
            events.push("signals-create");
            return termination;
        },
        detectCutoverValidation() {
            return Promise.resolve(cutoverValidation);
        },
        createTotpCipher(serialized) {
            events.push("totp-create");
            expect(serialized).toBe(serializedKeyring);
            if (totpFailure) return Promise.reject(totpFailure);
            return Promise.resolve(testTotpSecretCipher);
        },
        loadRelease(releasesDirectory, releaseRoot, processRole) {
            events.push(`release:${processRole}:${releasesDirectory}:${releaseRoot}`);
            return Promise.resolve(release);
        },
        resolveProjectLayout(observedProjectRoot) {
            events.push(`layout:${observedProjectRoot}`);
            return Promise.resolve(layout);
        },
        resolveTerminalRoots(
            observedOpenClawRoot,
            observedDashboardRoot,
            observedWorkspaceRoot
        ) {
            expect(observedOpenClawRoot).toBe(openClawRoot);
            expect(observedDashboardRoot).toBe(layout.root);
            expect(observedWorkspaceRoot).toBe(workspaceRoot);
            return Promise.resolve(
                Object.freeze([
                    Object.freeze({
                        id: "workspace",
                        label: "Workspace",
                        path: workspaceRoot,
                    }),
                    Object.freeze({
                        id: "openclaw",
                        label: "OpenClaw",
                        path: openClawRoot,
                    }),
                    Object.freeze({
                        id: "docker",
                        label: "Docker",
                        optional: true,
                        path: "/opt/docker",
                    }),
                    Object.freeze({
                        id: "dashboard",
                        label: "Mira Dashboard",
                        path: layout.root,
                    }),
                ])
            );
        },
        resolveOpenClawFileRoot(observedOpenClawRoot, observedProductionRoot) {
            expect(observedOpenClawRoot).toBe(openClawRoot);
            expect(observedProductionRoot).toBe(layout.production.root);
            events.push(`openclaw:${observedOpenClawRoot}`);
            return Promise.resolve(
                Object.freeze({
                    id: "openclaw-config",
                    label: "OpenClaw Config",
                    manifest: Object.freeze([
                        Object.freeze({
                            contentPolicy: "redacted-config-json" as const,
                            maximumSizeBytes: 2_097_152,
                            segments: Object.freeze(["openclaw.json"]),
                            uploadContentPolicy: "reject-redaction-sentinel" as const,
                            writable: true,
                        }),
                        Object.freeze({
                            contentPolicy: "raw" as const,
                            maximumSizeBytes: 2_097_152,
                            segments: Object.freeze([
                                "hooks",
                                "transforms",
                                "agentmail.ts",
                            ]),
                            uploadContentPolicy: "reject-redaction-sentinel" as const,
                            writable: true,
                        }),
                    ]),
                    path: openClawRoot,
                    writable: false,
                })
            );
        },
        resolveWorkspaceFileRoot(observedWorkspaceRoot, observedLayout) {
            expect(observedWorkspaceRoot).toBe(workspaceRoot);
            expect(observedLayout).toBe(layout);
            events.push(`workspace:${observedWorkspaceRoot}`);
            return Promise.resolve(
                Object.freeze({
                    id: "workspace",
                    label: "Workspace",
                    path: workspaceRoot,
                    writable: true,
                })
            );
        },
    } satisfies DashboardWebProcessDependencies);
    return { dependencies, events, logLines };
}

describe("Dashboard web process", () => {
    test("starts unavailable, promotes only after composition, and drains gracefully", async () => {
        const fixture = processFixture();

        await runDashboardWebProcess(processOptions, fixture.dependencies);

        expect(fixture.events).toEqual([
            `layout:${projectRoot}`,
            `release:web:${layout.production.releases}:${release.releaseRoot}`,
            `workspace:${workspaceRoot}`,
            `openclaw:${openClawRoot}`,
            `logs:web:${layout.production.state.logs}`,
            "signals-create",
            "frontend-create",
            "totp-create",
            "runtime-create",
            "server-create",
            "server-stop:graceful",
            "log-flush",
            "signals-dispose",
        ]);
        expect(
            fixture.logLines.map((line) => (JSON.parse(line) as { event: string }).event)
        ).toEqual(["runtime.started"]);
    });

    test("cleans pre-listener ownership and redacts a startup failure", async () => {
        const failure = new Error("private totp startup failure");
        const fixture = processFixture(failure);

        const observedFailure = await rejectionError(
            runDashboardWebProcess(processOptions, fixture.dependencies)
        );

        expect(observedFailure).toBe(failure);

        expect(fixture.events.slice(-2)).toEqual(["log-flush", "signals-dispose"]);
        const fatal = JSON.parse(fixture.logLines.at(-1) ?? "null") as {
            event: string;
        };
        expect(fatal.event).toBe("runtime.start_failed");
        expect(JSON.stringify(fatal)).not.toContain("private totp startup failure");
    });

    test("keeps the full runtime behind the cutover mutation gate for exact smoke", async () => {
        const fixture = processFixture(undefined, true);

        await runDashboardWebProcess(processOptions, fixture.dependencies);

        expect(fixture.events).toContain("runtime-create");
    });
});
