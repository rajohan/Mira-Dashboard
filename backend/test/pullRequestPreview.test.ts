import {
    chmodSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    rmSync,
    statSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it, jest } from "bun:test";

import * as developmentStack from "../src/development/developmentStack.ts";
import * as processModule from "../src/lib/processes.ts";
import type { JobExecution } from "../src/services/jobExecutionQueue.ts";
import * as jobExecutionQueue from "../src/services/jobExecutionQueue.ts";
import * as previewHost from "../src/services/pullRequestPreviewHost.ts";
import {
    buildPullRequestPreviewSandboxCommand,
    getPullRequestPreviewStatus,
    parsePreviewUnitState,
    type PullRequestPreviewConfig,
    resolvePullRequestPreviewConfig,
    startPullRequestPreview,
    stopPullRequestPreview,
} from "../src/services/pullRequestPreviewHost.ts";
import {
    prepareAndStartPullRequestPreview,
    prepareAndStopPullRequestPreview,
    registerPullRequestPreviewExecutionActions,
} from "../src/services/pullRequestPreviews.ts";
import type { PullRequestSummary } from "../src/services/pullRequests.ts";
import * as pullRequests from "../src/services/pullRequests.ts";
import * as queuedJobExecution from "../src/services/queuedJobExecution.ts";
import type {
    ScheduledJob,
    ScheduledJobActionContext,
    ScheduledJobActionHandler,
} from "../src/services/scheduledJobs.ts";
import * as scheduledJobs from "../src/services/scheduledJobs.ts";

const COMMIT = "a".repeat(40);

function noOperation(): void {}

function previewRouteRequest(number: string) {
    return Object.assign(
        new Request(`https://dashboard.test/api/pull-requests/${number}/preview`, {
            method: "POST",
        }),
        { params: { number } }
    );
}

function pausePreviewWorkerClaims(): () => void {
    return noOperation;
}

function previewConfig(root: string): PullRequestPreviewConfig {
    return {
        allowedAuthors: new Set(["mira-2026", "rajohan"]),
        backendPort: 3101,
        bunExecutable: "/home/ubuntu/.bun/bin/bun",
        dashboardRoot: path.join(root, "dashboard"),
        frontendPort: 5173,
        gatewayProxyEntrypoint: path.resolve(
            import.meta.dirname,
            "../src/pullRequestPreviewGatewayProxy.ts"
        ),
        gatewayProxyIdentityFile: path.join(
            root,
            "preview",
            "gateway-proxy-identity.json"
        ),
        gatewayProxyPort: 18_790,
        gatewayProxyUnitName: "mira-dashboard-pr-preview-gateway.service",
        gatewayTokenFile: path.join(root, "preview", "gateway.token"),
        gatewayUpstreamTokenFile: path.join(root, "preview", "gateway-upstream.token"),
        gatewayUrl: "ws://127.0.0.1:18789",
        gitCommonDirectory: path.join(root, "dashboard", ".git"),
        previewRoot: path.join(root, "preview"),
        stateFile: path.join(root, "preview", "active-preview.json"),
        unitName: "mira-dashboard-pr-preview.service",
        worktreeRoot: path.join(root, "worktrees"),
    };
}

function previewExecution(
    id: string,
    status: "queued" | "success",
    previewStatus: "running" | "stopped"
): JobExecution {
    return {
        actionKey: "dashboard.preview.start",
        attempt: status === "queued" ? 0 : 1,
        availableAt: "2026-07-26T00:00:00.000Z",
        cancelRequestedAt: undefined,
        cancellable: true,
        displayName: "PR preview",
        finishedAt: status === "success" ? "2026-07-26T00:00:01.000Z" : undefined,
        heartbeatAt: undefined,
        id,
        leaseExpiresAt: undefined,
        leaseOwner: undefined,
        message: undefined,
        output: { preview: { number: 335, status: previewStatus } },
        payload: { commitSha: COMMIT, number: 335 },
        priority: 0,
        queuedAt: "2026-07-26T00:00:00.000Z",
        resourceClass: "exclusive",
        scheduledJobId: undefined,
        scheduledRunId: undefined,
        startedAt: status === "success" ? "2026-07-26T00:00:00.500Z" : undefined,
        status,
        timeoutMs: 600_000,
        triggerType: "manual",
    };
}

function previewScheduledJob(number: unknown, commitSha: unknown = COMMIT): ScheduledJob {
    return {
        actionKey: "dashboard.preview.start",
        actionPayload: { commitSha, number },
        cronExpression: undefined,
        createdAt: "2026-07-26T00:00:00.000Z",
        description: "PR preview",
        disableIntent: undefined,
        enabled: true,
        id: "preview",
        intervalSeconds: 60,
        isQueued: false,
        isRunning: false,
        lastRun: undefined,
        name: "PR preview",
        nextRunAt: undefined,
        resourceClass: "exclusive",
        scheduleType: "interval",
        timeOfDay: undefined,
        timeoutMs: 600_000,
        updatedAt: "2026-07-26T00:00:00.000Z",
    };
}

describe("managed pull request preview", () => {
    it("uses the running Bun executable when the service PATH does not expose Bun", () => {
        const root = mkdtempSync(path.join(tmpdir(), "mira-preview-bun-path-"));
        try {
            const config = resolvePullRequestPreviewConfig({
                MIRA_DASHBOARD_PREVIEW_ROOT: path.join(root, "state"),
                MIRA_DASHBOARD_ROOT: path.join(root, "dashboard"),
                MIRA_DASHBOARD_WORKTREE_ROOT: path.join(root, "worktrees"),
                PATH: path.join(root, "empty-bin"),
            });

            expect(config.bunExecutable).toBe(process.execPath);
            expect(path.isAbsolute(config.bunExecutable)).toBe(true);
            expect(() =>
                resolvePullRequestPreviewConfig({
                    BUN_BINARY: "bun",
                    MIRA_DASHBOARD_PREVIEW_ROOT: path.join(root, "state"),
                    MIRA_DASHBOARD_ROOT: path.join(root, "dashboard"),
                    MIRA_DASHBOARD_WORKTREE_ROOT: path.join(root, "worktrees"),
                    PATH: path.join(root, "empty-bin"),
                })
            ).toThrow("bun executable must resolve to an absolute path");
        } finally {
            rmSync(root, { force: true, recursive: true });
        }
    });

    it("resolves a single-slot host contract without accepting ambiguous config", () => {
        const root = mkdtempSync(path.join(tmpdir(), "mira-preview-config-"));
        try {
            const config = resolvePullRequestPreviewConfig({
                BUN_BINARY: "/home/ubuntu/.bun/bin/bun",
                MIRA_DASHBOARD_PREVIEW_BACKEND_PORT: "4101",
                MIRA_DASHBOARD_PREVIEW_FRONTEND_PORT: "4173",
                MIRA_DASHBOARD_PREVIEW_ROOT: path.join(root, "state"),
                MIRA_DASHBOARD_ROOT: path.join(root, "dashboard"),
                MIRA_DASHBOARD_WORKTREE_ROOT: path.join(root, "worktrees"),
            });
            expect(config).toMatchObject({
                backendPort: 4101,
                frontendPort: 4173,
                gatewayProxyPort: 18_790,
                gatewayProxyUnitName: "mira-dashboard-pr-preview-gateway.service",
                gatewayTokenFile: path.join(root, "state", "gateway.token"),
                gatewayUpstreamTokenFile: path.join(
                    root,
                    "state",
                    "gateway-upstream.token"
                ),
                gatewayUrl: "ws://127.0.0.1:18789",
                previewRoot: path.join(root, "state"),
                unitName: "mira-dashboard-pr-preview.service",
            });
            expect(config.allowedAuthors).toEqual(new Set(["mira-2026", "rajohan"]));
            expect(() =>
                resolvePullRequestPreviewConfig({
                    BUN_BINARY: "/home/ubuntu/.bun/bin/bun",
                    MIRA_DASHBOARD_PREVIEW_ALLOWED_AUTHORS: " , ",
                    MIRA_DASHBOARD_ROOT: path.join(root, "dashboard"),
                    MIRA_DASHBOARD_WORKTREE_ROOT: path.join(root, "worktrees"),
                })
            ).toThrow(
                "MIRA_DASHBOARD_PREVIEW_ALLOWED_AUTHORS must contain at least one author"
            );

            for (const environment of [
                {
                    BUN_BINARY: "/home/ubuntu/.bun/bin/bun",
                    MIRA_DASHBOARD_PREVIEW_BACKEND_PORT: "5173",
                    MIRA_DASHBOARD_PREVIEW_FRONTEND_PORT: "5173",
                    MIRA_DASHBOARD_ROOT: path.join(root, "dashboard"),
                    MIRA_DASHBOARD_WORKTREE_ROOT: path.join(root, "worktrees"),
                },
                {
                    BUN_BINARY: "/home/ubuntu/.bun/bin/bun",
                    MIRA_DASHBOARD_PREVIEW_GATEWAY_URL: "https://gateway.example/ws",
                    MIRA_DASHBOARD_ROOT: path.join(root, "dashboard"),
                    MIRA_DASHBOARD_WORKTREE_ROOT: path.join(root, "worktrees"),
                },
                {
                    BUN_BINARY: "/home/ubuntu/.bun/bin/bun",
                    MIRA_DASHBOARD_PREVIEW_UNIT: "../preview.service",
                    MIRA_DASHBOARD_ROOT: path.join(root, "dashboard"),
                    MIRA_DASHBOARD_WORKTREE_ROOT: path.join(root, "worktrees"),
                },
            ]) {
                expect(() => resolvePullRequestPreviewConfig(environment)).toThrow();
            }
        } finally {
            rmSync(root, { force: true, recursive: true });
        }
    });

    it("builds a read-only source sandbox with isolated writable state", () => {
        const root = mkdtempSync(path.join(tmpdir(), "mira-preview-sandbox-"));
        try {
            const config = {
                ...previewConfig(root),
                gatewayTokenFile: path.join(root, "gateway.token"),
                gatewayUrl: "wss://gateway.example/ws",
                sourceWebAuthnRpId: "dashboard.example",
            };
            const worktreePath = path.join(config.worktreeRoot, "preview-pr-335");
            const stateRoot = path.join(config.previewRoot, "states", "pr-335");
            const command = buildPullRequestPreviewSandboxCommand({
                config,
                number: 335,
                publicOrigin: "https://dashboard.example:5173",
                stateRoot,
                worktreePath,
            });
            expect(command.slice(0, 4)).toEqual([
                "bwrap",
                "--unshare-all",
                "--share-net",
                "--die-with-parent",
            ]);
            for (const value of [
                "--clearenv",
                "--ro-bind",
                "--bind",
                "/etc/resolv.conf",
                "MIRA_DASHBOARD_DEV_STATE_OWNER",
                "managed-pr-335",
                "MIRA_DASHBOARD_DEV_GATEWAY_TOKEN_FILE",
                "/run/mira-dashboard-preview/gateway.token",
                "MIRA_DASHBOARD_DEV_GATEWAY_URL",
                "ws://127.0.0.1:18790/gateway",
                "MIRA_DASHBOARD_DEV_SOURCE_WEBAUTHN_RP_ID",
                "dashboard.example",
            ]) {
                expect(command).toContain(value);
            }
            const stateBindIndex = command.findIndex(
                (value, index) =>
                    value === "--bind" &&
                    command[index + 1] === stateRoot &&
                    command[index + 2] === stateRoot
            );
            const stateEnvironmentIndex = command.findIndex(
                (value, index) =>
                    value === "--setenv" &&
                    command[index + 1] === "MIRA_DASHBOARD_DEV_STATE_ROOT" &&
                    command[index + 2] === stateRoot
            );
            expect(stateBindIndex).toBeGreaterThanOrEqual(0);
            expect(stateEnvironmentIndex).toBeGreaterThanOrEqual(0);
            expect(command).not.toContain("/state");
            expect(command).not.toContain("MIRA_GITHUB_TOKEN");
            expect(command).not.toContain("OPENCLAW_GATEWAY_TOKEN");
            expect(command).not.toContain(config.gatewayUpstreamTokenFile);
            expect(command).not.toContain(config.gatewayUrl);
            expect(command.at(-1)).toBe(
                path.join(worktreePath, "scripts", "developmentStack.ts")
            );
        } finally {
            rmSync(root, { force: true, recursive: true });
        }
    });

    it("quarantines an invalid preview record instead of blocking the dev slot", async () => {
        const root = mkdtempSync(path.join(tmpdir(), "mira-preview-corrupt-state-"));
        const config = previewConfig(root);
        mkdirSync(config.previewRoot, { recursive: true });
        writeFileSync(config.stateFile, "{not-json\n", { mode: 0o600 });
        const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});

        try {
            await expect(getPullRequestPreviewStatus(config)).resolves.toEqual({
                status: "stopped",
            });
            expect(existsSync(config.stateFile)).toBe(false);
            expect(
                readdirSync(config.previewRoot).filter((entry) =>
                    entry.startsWith("active-preview.corrupt-")
                )
            ).toHaveLength(1);
            expect(errorSpy).toHaveBeenCalledWith(
                expect.stringContaining("Quarantined invalid state")
            );
        } finally {
            errorSpy.mockRestore();
            rmSync(root, { force: true, recursive: true });
        }
    });

    it("does not quarantine a preview record that cannot be safely read", async () => {
        const root = mkdtempSync(path.join(tmpdir(), "mira-preview-unreadable-state-"));
        const config = previewConfig(root);
        mkdirSync(config.previewRoot, { recursive: true });
        writeFileSync(config.stateFile, "x".repeat(256 * 1024 + 1), {
            mode: 0o600,
        });

        try {
            await expect(getPullRequestPreviewStatus(config)).rejects.toThrow(
                "Dashboard preview state is too large"
            );
            expect(existsSync(config.stateFile)).toBe(true);
            expect(
                readdirSync(config.previewRoot).filter((entry) =>
                    entry.startsWith("active-preview.corrupt-")
                )
            ).toHaveLength(0);
        } finally {
            rmSync(root, { force: true, recursive: true });
        }
    });

    it("preserves preview state after a transient read failure", async () => {
        const root = mkdtempSync(path.join(tmpdir(), "mira-preview-read-failure-"));
        const config = previewConfig(root);
        mkdirSync(config.previewRoot, { recursive: true });
        writeFileSync(config.stateFile, "{}\n", { mode: 0o000 });

        try {
            await expect(getPullRequestPreviewStatus(config)).rejects.toThrow();
            expect(existsSync(config.stateFile)).toBe(true);
            expect(
                readdirSync(config.previewRoot).filter((entry) =>
                    entry.startsWith("active-preview.corrupt-")
                )
            ).toHaveLength(0);
        } finally {
            if (existsSync(config.stateFile)) {
                chmodSync(config.stateFile, 0o600);
            }
            rmSync(root, { force: true, recursive: true });
        }
    });

    it("rejects a symlinked preview record without quarantining its target", async () => {
        const root = mkdtempSync(path.join(tmpdir(), "mira-preview-symlink-state-"));
        const config = previewConfig(root);
        const target = path.join(root, "outside-preview-state.json");
        mkdirSync(config.previewRoot, { recursive: true });
        writeFileSync(target, "{}\n", { mode: 0o600 });
        symlinkSync(target, config.stateFile);

        try {
            await expect(getPullRequestPreviewStatus(config)).rejects.toThrow(
                "Dashboard preview state must be a readable real regular file"
            );
            expect(existsSync(config.stateFile)).toBe(true);
            expect(existsSync(target)).toBe(true);
            expect(
                readdirSync(config.previewRoot).filter((entry) =>
                    entry.startsWith("active-preview.corrupt-")
                )
            ).toHaveLength(0);
        } finally {
            rmSync(root, { force: true, recursive: true });
        }
    });

    it("starts, reuses, updates, reports, and stops one trusted preview slot", async () => {
        const root = mkdtempSync(path.join(tmpdir(), "mira-preview-lifecycle-"));
        const config = {
            ...previewConfig(root),
            recentAuthMinutes: "10",
            sessionIdleMinutes: "60",
        };
        const worktreePath = path.join(config.worktreeRoot, "preview-pr-335");
        let expectedCommit = COMMIT;
        let shouldFailServeDisable = false;
        let shouldFailServeInspectionWhenEnabled = false;
        let isServeEnabled = false;
        let isPreviewUnitCollected = false;
        let didProxyReceiveDisposableToken = false;
        let didProxyReceiveUpstreamToken = false;
        let didProxyStartWithStartingRecord = false;
        const activeUnits = new Set<string>();
        const commands: string[] = [];
        mkdirSync(config.dashboardRoot, { recursive: true });
        mkdirSync(config.gitCommonDirectory, { recursive: true });

        const processSpy = jest
            .spyOn(processModule, "runProcess")
            .mockImplementation(async (executable, arguments_) => {
                const commandArguments = [...arguments_];
                commands.push([executable, ...commandArguments].join(" "));
                if (executable === "tailscale" && commandArguments[0] === "status") {
                    return {
                        code: 0,
                        stderr: "",
                        stdout: JSON.stringify({
                            Self: { DNSName: "Preview-Node.ts.net." },
                        }),
                    };
                }
                if (
                    executable === "tailscale" &&
                    commandArguments[0] === "serve" &&
                    commandArguments[1] === "status"
                ) {
                    if (isServeEnabled && shouldFailServeInspectionWhenEnabled) {
                        return {
                            code: 1,
                            stderr: "serve status unavailable",
                            stdout: "",
                        };
                    }
                    return {
                        code: 0,
                        stderr: "",
                        stdout: JSON.stringify(
                            isServeEnabled
                                ? {
                                      TCP: { "5173": { HTTPS: true } },
                                      Web: {
                                          "preview-node.ts.net:5173": {
                                              Handlers: {
                                                  "/": {
                                                      Proxy: "http://127.0.0.1:5173",
                                                  },
                                              },
                                          },
                                      },
                                  }
                                : {}
                        ),
                    };
                }
                if (executable === "sudo" && commandArguments.includes("serve")) {
                    if (shouldFailServeDisable && commandArguments.includes("off")) {
                        return {
                            code: 1,
                            stderr: "serve cleanup unavailable",
                            stdout: "",
                        };
                    }
                    isServeEnabled = !commandArguments.includes("off");
                }
                if (executable === "systemd-run") {
                    const unitArgument = commandArguments.find((argument) =>
                        argument.startsWith("--unit=")
                    );
                    if (unitArgument) {
                        activeUnits.add(unitArgument.slice("--unit=".length));
                    }
                    if (
                        commandArguments.includes(`--unit=${config.gatewayProxyUnitName}`)
                    ) {
                        didProxyStartWithStartingRecord =
                            JSON.parse(readFileSync(config.stateFile, "utf8")).status ===
                            "starting";
                        didProxyReceiveDisposableToken =
                            readFileSync(config.gatewayTokenFile, "utf8").trim() !==
                            "persisted-gateway-token";
                        didProxyReceiveUpstreamToken =
                            readFileSync(
                                config.gatewayUpstreamTokenFile,
                                "utf8"
                            ).trim() === "persisted-gateway-token";
                    }
                    if (commandArguments.includes(`--unit=${config.unitName}`)) {
                        isPreviewUnitCollected = false;
                    }
                }
                if (executable === "systemctl" && commandArguments.includes("stop")) {
                    activeUnits.delete(
                        commandArguments[commandArguments.indexOf("stop") + 1] || ""
                    );
                }
                if (executable === "systemctl" && commandArguments.includes("show")) {
                    const shownUnit =
                        commandArguments[commandArguments.indexOf("show") + 1];
                    if (isPreviewUnitCollected && shownUnit === config.unitName) {
                        return {
                            code: 1,
                            stderr: "Unit could not be found",
                            stdout: "",
                        };
                    }
                    return {
                        code: 0,
                        stderr: "",
                        stdout: activeUnits.has(shownUnit || "")
                            ? "ActiveState=active\nSubState=running\nResult=success\n"
                            : "ActiveState=inactive\nSubState=dead\nResult=success\n",
                    };
                }
                if (
                    executable === "git" &&
                    commandArguments.includes("--show-toplevel")
                ) {
                    return { code: 0, stderr: "", stdout: `${worktreePath}\n` };
                }
                if (executable === "git" && commandArguments.includes("status")) {
                    return { code: 0, stderr: "", stdout: "" };
                }
                if (
                    executable === "git" &&
                    commandArguments.includes("worktree") &&
                    commandArguments.includes("add")
                ) {
                    mkdirSync(path.join(worktreePath, "backend"), {
                        recursive: true,
                    });
                }
                if (executable === "git" && commandArguments.includes("rev-parse")) {
                    return {
                        code: 0,
                        stderr: "",
                        stdout: `${expectedCommit}\n`,
                    };
                }
                return { code: 0, stderr: "", stdout: "" };
            });
        const prepareStateSpy = jest
            .spyOn(developmentStack, "prepareDevelopmentState")
            .mockReturnValue({
                database: "created-empty",
                releases: "empty",
                workspace: "empty",
            });
        const fetchSpy = jest
            .spyOn(globalThis, "fetch")
            .mockResolvedValue(new Response("ready"));
        const protectFromCancellation = jest.fn();

        try {
            const candidate = {
                authorLogin: "mira-2026",
                baseRefName: "main",
                commitSha: COMMIT,
                number: 335,
                title: "Trusted preview",
            };
            const running = await startPullRequestPreview(candidate, {
                config,
                protectFromCancellation,
                readGatewayToken: () => "persisted-gateway-token",
            });
            expect(running).toMatchObject({
                commitSha: COMMIT,
                number: 335,
                status: "running",
                url: "https://preview-node.ts.net:5173",
            });
            expect(prepareStateSpy).toHaveBeenCalledTimes(1);
            expect(protectFromCancellation).toHaveBeenCalledTimes(1);
            expect(fetchSpy).toHaveBeenCalledWith(
                "http://127.0.0.1:5173/api/health/ready",
                expect.objectContaining({ signal: expect.any(AbortSignal) })
            );
            expect(readFileSync(config.gatewayTokenFile, "utf8")).not.toContain(
                "persisted-gateway-token"
            );
            expect(existsSync(config.gatewayUpstreamTokenFile)).toBe(false);
            expect(didProxyStartWithStartingRecord).toBe(true);
            expect(didProxyReceiveDisposableToken).toBe(true);
            expect(didProxyReceiveUpstreamToken).toBe(true);
            expect(statSync(config.gatewayTokenFile).mode & 0o777).toBe(0o600);
            expect(commands).toContain(
                "sudo -n tailscale serve --bg --https=5173 http://127.0.0.1:5173"
            );
            expect(commands.some((command) => command.startsWith("systemd-run "))).toBe(
                true
            );
            const gatewayProxyCommand = commands.find(
                (command) =>
                    command.startsWith("systemd-run ") &&
                    command.includes(`--unit=${config.gatewayProxyUnitName}`)
            );
            expect(gatewayProxyCommand).toContain(config.gatewayUpstreamTokenFile);
            expect(gatewayProxyCommand).toContain(config.gatewayProxyEntrypoint);
            expect(gatewayProxyCommand).not.toContain("persisted-gateway-token");
            expect(
                commands.findIndex((command) => command.startsWith("systemd-run "))
            ).toBeLessThan(
                commands.findIndex((command) =>
                    command.startsWith("sudo -n tailscale serve --bg --https=5173")
                )
            );
            await expect(getPullRequestPreviewStatus(config)).resolves.toMatchObject({
                number: 335,
                status: "running",
            });
            await expect(
                startPullRequestPreview(candidate, { config })
            ).resolves.toMatchObject({
                commitSha: COMMIT,
                status: "running",
            });
            const interruptedRecord = JSON.parse(
                readFileSync(config.stateFile, "utf8")
            ) as Record<string, unknown>;
            writeFileSync(
                config.stateFile,
                `${JSON.stringify({
                    ...interruptedRecord,
                    ownsTailscaleServe: false,
                    status: "starting",
                })}\n`,
                { mode: 0o600 }
            );
            isServeEnabled = false;
            await expect(getPullRequestPreviewStatus(config)).resolves.toMatchObject({
                commitSha: COMMIT,
                status: "starting",
            });
            await expect(
                startPullRequestPreview(candidate, {
                    config,
                    readGatewayToken: () => "persisted-gateway-token",
                })
            ).resolves.toMatchObject({
                commitSha: COMMIT,
                status: "running",
            });
            expect(prepareStateSpy).toHaveBeenCalledTimes(2);

            const interruptedAfterServeRecord = JSON.parse(
                readFileSync(config.stateFile, "utf8")
            ) as Record<string, unknown>;
            writeFileSync(
                config.stateFile,
                `${JSON.stringify({
                    ...interruptedAfterServeRecord,
                    ownsTailscaleServe: true,
                    status: "starting",
                    updatedAt: "2026-07-26T00:00:00.000Z",
                })}\n`,
                { mode: 0o600 }
            );
            isServeEnabled = true;
            activeUnits.clear();
            await expect(getPullRequestPreviewStatus(config)).resolves.toMatchObject({
                commitSha: COMMIT,
                status: "stopped",
            });
            expect(isServeEnabled).toBe(false);
            expect(existsSync(config.gatewayTokenFile)).toBe(false);
            expect(existsSync(config.gatewayUpstreamTokenFile)).toBe(false);
            expect(JSON.parse(readFileSync(config.stateFile, "utf8"))).toMatchObject({
                ownsTailscaleServe: false,
                status: "stopped",
            });

            await expect(
                startPullRequestPreview(candidate, {
                    config,
                    readGatewayToken: () => "persisted-gateway-token",
                })
            ).resolves.toMatchObject({
                commitSha: COMMIT,
                status: "running",
            });
            expect(prepareStateSpy).toHaveBeenCalledTimes(3);
            await expect(
                startPullRequestPreview(
                    { ...candidate, number: 336, title: "Other trusted preview" },
                    { config }
                )
            ).rejects.toMatchObject({ statusCode: 409 });
            await expect(stopPullRequestPreview(336, { config })).rejects.toMatchObject({
                statusCode: 409,
            });
            await expect(
                stopPullRequestPreview(335, {
                    config,
                    protectFromCancellation,
                })
            ).resolves.toMatchObject({
                number: 335,
                status: "stopped",
            });
            expect(isServeEnabled).toBe(false);
            expect(existsSync(config.gatewayTokenFile)).toBe(false);
            expect(existsSync(config.gatewayUpstreamTokenFile)).toBe(false);
            expect(commands).toContain("sudo -n tailscale serve --https=5173 off");
            expect(commands).toContain(`systemctl --user stop ${config.unitName}`);
            expect(commands).toContain(
                `systemctl --user stop ${config.gatewayProxyUnitName}`
            );

            isServeEnabled = true;
            await expect(
                startPullRequestPreview(candidate, { config })
            ).rejects.toMatchObject({ statusCode: 409 });
            isServeEnabled = false;

            expectedCommit = "b".repeat(40);
            await expect(
                startPullRequestPreview(
                    {
                        ...candidate,
                        commitSha: expectedCommit,
                        title: "Updated trusted preview",
                    },
                    {
                        config,
                        readGatewayToken: () => "rotated-gateway-token",
                    }
                )
            ).resolves.toMatchObject({
                commitSha: expectedCommit,
                status: "running",
            });
            expect(
                commands.some((command) =>
                    command.includes(`checkout --detach ${expectedCommit}`)
                )
            ).toBe(true);
            isPreviewUnitCollected = true;
            activeUnits.delete(config.unitName);
            await expect(getPullRequestPreviewStatus(config)).resolves.toMatchObject({
                number: 335,
                status: "stopped",
            });
            expect(isServeEnabled).toBe(false);
            expect(existsSync(config.gatewayTokenFile)).toBe(false);
            expect(existsSync(config.gatewayUpstreamTokenFile)).toBe(false);

            expectedCommit = "c".repeat(40);
            shouldFailServeDisable = true;
            shouldFailServeInspectionWhenEnabled = true;
            await expect(
                startPullRequestPreview(
                    {
                        ...candidate,
                        commitSha: expectedCommit,
                        title: "Preview with failed Serve verification",
                    },
                    {
                        config,
                        readGatewayToken: () => "failure-path-gateway-token",
                    }
                )
            ).rejects.toThrow(
                "Tailscale Serve activation failed and its route could not be removed"
            );
            expect(JSON.parse(readFileSync(config.stateFile, "utf8"))).toMatchObject({
                commitSha: expectedCommit,
                ownsTailscaleServe: true,
                status: "failed",
            });
            await expect(getPullRequestPreviewStatus(config)).resolves.toMatchObject({
                commitSha: expectedCommit,
                message: expect.stringContaining(
                    "Tailscale Serve activation failed and its route could not be removed"
                ),
                status: "failed",
            });
            await expect(stopPullRequestPreview(335, { config })).rejects.toThrow(
                "PR dev stop cleanup failed"
            );
            expect(JSON.parse(readFileSync(config.stateFile, "utf8"))).toMatchObject({
                ownsTailscaleServe: true,
                status: "failed",
            });
            shouldFailServeDisable = false;
            shouldFailServeInspectionWhenEnabled = false;
            await expect(stopPullRequestPreview(335, { config })).resolves.toMatchObject({
                status: "stopped",
            });
            expect(isServeEnabled).toBe(false);

            const stoppedRecord = JSON.parse(
                readFileSync(config.stateFile, "utf8")
            ) as Record<string, unknown>;
            writeFileSync(
                config.stateFile,
                `${JSON.stringify({
                    ...stoppedRecord,
                    ownsTailscaleServe: true,
                    status: "stopping",
                    updatedAt: "2026-07-26T00:00:00.000Z",
                })}\n`,
                { mode: 0o600 }
            );
            isServeEnabled = true;
            activeUnits.add(config.unitName);
            activeUnits.add(config.gatewayProxyUnitName);
            await expect(getPullRequestPreviewStatus(config)).resolves.toMatchObject({
                status: "stopped",
            });
            expect(activeUnits.size).toBe(0);
            expect(isServeEnabled).toBe(false);
            expect(JSON.parse(readFileSync(config.stateFile, "utf8"))).toMatchObject({
                ownsTailscaleServe: false,
                status: "stopped",
            });
        } finally {
            processSpy.mockRestore();
            prepareStateSpy.mockRestore();
            fetchSpy.mockRestore();
            rmSync(root, { force: true, recursive: true });
        }
    });

    it("queues preview operations and registers guarded worker actions", async () => {
        const queuedStart = previewExecution("preview-start", "queued", "running");
        const queuedStop = previewExecution("preview-stop", "queued", "stopped");
        const completedStart = previewExecution("preview-start", "success", "running");
        const completedStop = previewExecution("preview-stop", "success", "stopped");
        const enqueueSpy = jest
            .spyOn(jobExecutionQueue, "enqueueJobExecution")
            .mockImplementation((input) =>
                input.actionKey === "dashboard.preview.start" ? queuedStart : queuedStop
            );
        const executionsSpy = jest
            .spyOn(jobExecutionQueue, "listJobExecutions")
            .mockReturnValue([]);
        const waitSpy = jest
            .spyOn(queuedJobExecution, "waitForJobExecution")
            .mockImplementation(async (id) =>
                id === queuedStart.id ? completedStart : completedStop
            );
        const handlers = new Map<string, ScheduledJobActionHandler>();
        const registerSpy = jest
            .spyOn(scheduledJobs, "registerScheduledJobAction")
            .mockImplementation((actionKey, handler) => {
                handlers.set(actionKey, handler);
            });
        const pullRequest: PullRequestSummary = {
            additions: 1,
            author: { login: "mira-2026" },
            baseRefName: "main",
            body: "",
            changedFiles: 1,
            createdAt: "2026-07-26T00:00:00.000Z",
            deletions: 0,
            headRefName: "preview",
            headRefOid: COMMIT,
            isDraft: false,
            latestOpinionatedReviews: { nodes: [] },
            mergeable: "MERGEABLE",
            mergeStateStatus: "CLEAN",
            number: 335,
            reviewDecision: "APPROVED",
            title: "Trusted preview",
            updatedAt: "2026-07-26T00:00:00.000Z",
            url: "https://github.test/pull/335",
        };
        const listSpy = jest
            .spyOn(pullRequests, "listDashboardPullRequests")
            .mockResolvedValue([pullRequest]);
        const startSpy = jest
            .spyOn(previewHost, "startPullRequestPreview")
            .mockResolvedValue({ number: 335, status: "running" });
        const stopSpy = jest
            .spyOn(previewHost, "stopPullRequestPreview")
            .mockResolvedValue({ number: 335, status: "stopped" });
        const statusSpy = jest
            .spyOn(previewHost, "getPullRequestPreviewStatus")
            .mockResolvedValue({ status: "stopped" });
        const runningPreview = {
            commitSha: COMMIT,
            number: 335,
            status: "running" as const,
        };
        const protectFromCancellation = jest.fn();
        const context: ScheduledJobActionContext = {
            executionId: "execution",
            pauseWorkerClaims: pausePreviewWorkerClaims,
            protectFromCancellation,
            updateOutput: () => {},
        };

        try {
            await expect(prepareAndStartPullRequestPreview(335)).resolves.toMatchObject({
                commitSha: COMMIT,
                number: 335,
                status: "starting",
                title: "Trusted preview",
                updatedAt: expect.any(String),
            });
            statusSpy.mockResolvedValueOnce({
                number: 334,
                status: "running",
            });
            await expect(prepareAndStartPullRequestPreview(335)).rejects.toMatchObject({
                statusCode: 409,
            });
            await expect(prepareAndStopPullRequestPreview(335)).resolves.toEqual({
                number: 335,
                status: "stopped",
            });
            await expect(prepareAndStopPullRequestPreview()).resolves.toEqual({
                number: 335,
                status: "stopped",
            });
            expect(enqueueSpy).toHaveBeenNthCalledWith(
                1,
                expect.objectContaining({
                    actionKey: "dashboard.preview.start",
                    payload: { commitSha: COMMIT, number: 335 },
                    resourceClass: "exclusive",
                    timeoutMs: 30 * 60 * 1000,
                })
            );
            expect(enqueueSpy).toHaveBeenNthCalledWith(
                2,
                expect.objectContaining({
                    actionKey: "dashboard.preview.stop",
                    timeoutMs: 6 * 60 * 1000,
                })
            );
            expect(enqueueSpy).toHaveBeenNthCalledWith(
                3,
                expect.objectContaining({
                    actionKey: "dashboard.preview.stop",
                    displayName: "Stop PR preview",
                    payload: { number: undefined },
                    timeoutMs: 6 * 60 * 1000,
                })
            );
            expect(waitSpy).toHaveBeenCalledTimes(2);

            const { pullRequestRoutes } =
                await import("../src/routes/pullRequestRoutes.ts");
            const startResponse = await pullRequestRoutes[
                "/api/pull-requests/:number/preview/start"
            ].POST(previewRouteRequest("335"));
            expect(startResponse.status).toBe(202);
            await expect(startResponse.json()).resolves.toMatchObject({
                isOk: true,
                preview: {
                    commitSha: COMMIT,
                    number: 335,
                    status: "starting",
                    title: "Trusted preview",
                    updatedAt: expect.any(String),
                },
            });

            const stopResponse = await pullRequestRoutes[
                "/api/pull-requests/:number/preview/stop"
            ].POST(previewRouteRequest("335"));
            expect(stopResponse.status).toBe(200);
            await expect(stopResponse.json()).resolves.toEqual({
                isOk: true,
                preview: { number: 335, status: "stopped" },
            });

            statusSpy.mockResolvedValue(runningPreview);
            executionsSpy.mockReturnValueOnce([queuedStart]);
            const statusResponse =
                await pullRequestRoutes["/api/pull-requests/preview"].GET();
            expect(statusResponse.status).toBe(200);
            await expect(statusResponse.json()).resolves.toMatchObject({
                preview: {
                    commitSha: COMMIT,
                    number: 335,
                    status: "starting",
                    updatedAt: queuedStart.queuedAt,
                },
            });

            for (const route of [
                "/api/pull-requests/:number/preview/start",
                "/api/pull-requests/:number/preview/stop",
            ] as const) {
                const invalidResponse = await pullRequestRoutes[route].POST(
                    previewRouteRequest("invalid")
                );
                expect(invalidResponse.status).toBe(400);
                await expect(invalidResponse.json()).resolves.toEqual({
                    error: "Invalid pull request number",
                });
            }

            listSpy.mockRejectedValueOnce(
                Object.assign(new Error("preview startup unavailable"), {
                    statusCode: 503,
                })
            );
            const failedStartResponse = await pullRequestRoutes[
                "/api/pull-requests/:number/preview/start"
            ].POST(previewRouteRequest("335"));
            expect(failedStartResponse.status).toBe(503);
            await expect(failedStartResponse.json()).resolves.toEqual({
                error: "preview startup unavailable",
            });

            waitSpy.mockRejectedValueOnce(
                Object.assign(new Error("preview stop unavailable"), {
                    statusCode: 503,
                })
            );
            const failedStopResponse = await pullRequestRoutes[
                "/api/pull-requests/:number/preview/stop"
            ].POST(previewRouteRequest("335"));
            expect(failedStopResponse.status).toBe(503);
            await expect(failedStopResponse.json()).resolves.toEqual({
                error: "preview stop unavailable",
            });

            statusSpy.mockRejectedValueOnce(
                Object.assign(new Error("preview status unavailable"), {
                    statusCode: 503,
                })
            );
            const failedStatusResponse =
                await pullRequestRoutes["/api/pull-requests/preview"].GET();
            expect(failedStatusResponse.status).toBe(503);
            await expect(failedStatusResponse.json()).resolves.toEqual({
                error: "preview status unavailable",
            });

            registerPullRequestPreviewExecutionActions();
            const startHandler = handlers.get("dashboard.preview.start");
            const stopHandler = handlers.get("dashboard.preview.stop");
            expect(startHandler).toBeDefined();
            expect(stopHandler).toBeDefined();
            if (!startHandler || !stopHandler) {
                throw new Error("Preview handlers were not registered");
            }
            await expect(
                startHandler(
                    previewScheduledJob("335"),
                    new AbortController().signal,
                    context
                )
            ).resolves.toEqual({
                preview: { number: 335, status: "running" },
            });
            expect(startSpy).toHaveBeenCalledWith(
                expect.objectContaining({
                    authorLogin: "mira-2026",
                    commitSha: COMMIT,
                    number: 335,
                }),
                expect.objectContaining({
                    protectFromCancellation: expect.any(Function),
                    signal: expect.any(AbortSignal),
                })
            );
            startSpy.mock.calls[0]?.[1]?.protectFromCancellation?.();
            expect(protectFromCancellation).toHaveBeenCalledTimes(1);
            await expect(
                stopHandler(previewScheduledJob(undefined), undefined, context)
            ).resolves.toEqual({
                preview: { number: 335, status: "stopped" },
            });
            expect(stopSpy).toHaveBeenCalledWith(
                undefined,
                expect.objectContaining({
                    protectFromCancellation: expect.any(Function),
                })
            );

            listSpy.mockResolvedValue([{ ...pullRequest, headRefOid: "b".repeat(40) }]);
            await expect(
                startHandler(previewScheduledJob(335, COMMIT), undefined, context)
            ).rejects.toMatchObject({ statusCode: 409 });
            expect(startSpy).toHaveBeenCalledTimes(1);

            listSpy.mockResolvedValue([]);
            await expect(
                startHandler(previewScheduledJob(336), undefined, context)
            ).rejects.toMatchObject({ statusCode: 404 });
        } finally {
            enqueueSpy.mockRestore();
            executionsSpy.mockRestore();
            waitSpy.mockRestore();
            registerSpy.mockRestore();
            listSpy.mockRestore();
            startSpy.mockRestore();
            stopSpy.mockRestore();
            statusSpy.mockRestore();
        }
    });

    it("parses unit status and rejects untrusted PR metadata before host work", async () => {
        expect(
            parsePreviewUnitState(
                "ActiveState=active\nSubState=running\nResult=success\n"
            )
        ).toEqual({
            activeState: "active",
            result: "success",
            subState: "running",
        });

        const root = mkdtempSync(path.join(tmpdir(), "mira-preview-guard-"));
        const config = previewConfig(root);
        try {
            expect(await getPullRequestPreviewStatus(config)).toEqual({
                status: "stopped",
            });
            expect(await stopPullRequestPreview(undefined, { config })).toEqual({
                status: "stopped",
            });
            await expect(
                startPullRequestPreview(
                    {
                        authorLogin: "external",
                        baseRefName: "main",
                        commitSha: COMMIT,
                        number: 335,
                        title: "Untrusted PR",
                    },
                    { config }
                )
            ).rejects.toThrow("Pull request author is not allowed to run host previews");
            await expect(
                startPullRequestPreview(
                    {
                        authorLogin: "mira-2026",
                        baseRefName: "release",
                        commitSha: COMMIT,
                        number: 335,
                        title: "Wrong base",
                    },
                    { config }
                )
            ).rejects.toThrow("Only main-targeted pull requests can be previewed");
        } finally {
            rmSync(root, { force: true, recursive: true });
        }
    });
});
