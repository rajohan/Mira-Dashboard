import { describe, expect, it, jest } from "bun:test";
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

import type { PullRequestSummary } from "../../contracts/delivery.ts";
import type { ScheduledJob } from "../../contracts/jobs.ts";
import { isPlainRecord } from "../../contracts/runtime.ts";
import { parseJsonText } from "../../test/support/fetch.ts";
import * as developmentStack from "../src/development/developmentState.ts";
import * as processModule from "../src/lib/processes.ts";
import { type JobExecutionRecord } from "../src/services/jobExecutionQueue/repository.ts";
import * as jobExecutionQueue from "../src/services/jobExecutionQueue/repository.ts";
import { resolvePullRequestPreviewConfig } from "../src/services/pullRequestPreviews/config.ts";
import * as previewHost from "../src/services/pullRequestPreviews/host.ts";
import {
    buildPullRequestPreviewSandboxCommand,
    cleanupClosedPullRequestPreview,
    getPullRequestPreviewStatus,
    listManagedPullRequestPreviewStateNumbers,
    parsePreviewUnitState,
    startPullRequestPreview,
    stopPullRequestPreview,
} from "../src/services/pullRequestPreviews/host.ts";
import {
    getPullRequestPreviewStatus as getDeliveryPullRequestPreviewStatus,
    prepareAndStartPullRequestPreview,
    prepareAndStopPullRequestPreview,
    reconcileClosedPullRequestPreview,
    registerPullRequestPreviewExecutionActions,
} from "../src/services/pullRequestPreviews/service.ts";
import type { PullRequestPreviewConfig } from "../src/services/pullRequestPreviews/types.ts";
import * as pullRequests from "../src/services/pullRequests/githubPullRequestListing.ts";
import * as queuedJobExecution from "../src/services/queuedJobExecution.ts";
import {
    type ScheduledJobActionContext,
    type ScheduledJobActionHandler,
} from "../src/services/scheduledJobs/actionRegistry.ts";
import * as scheduledJobActions from "../src/services/scheduledJobs/actionRegistry.ts";
import * as scheduledJobRepository from "../src/services/scheduledJobs/repository.ts";
import { apiErrorExpectation } from "./support/apiErrorExpectation.ts";
import { captureRejection } from "./support/rejections.ts";
import { captureStructuredLogs } from "./support/structuredLogCapture.ts";

const COMMIT = "a".repeat(40);

function noOperation(): void {}

function readJsonRecord(filePath: string): Record<string, unknown> {
    const value = parseJsonText(readFileSync(filePath, "utf8"));
    if (!isPlainRecord(value)) {
        throw new TypeError(`Expected a JSON object in ${filePath}`);
    }
    return value;
}

function previewRouteRequest(number: string, expectedHeadSha?: string) {
    return Object.assign(
        new Request(`https://dashboard.test/api/pull-requests/${number}/preview`, {
            body:
                expectedHeadSha === undefined
                    ? undefined
                    : JSON.stringify({ expectedHeadSha }),
            headers:
                expectedHeadSha === undefined
                    ? undefined
                    : { "Content-Type": "application/json" },
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
        bunExecutable: process.execPath,
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
        managedWorktreePath: path.join(root, "managed-preview"),
        previewRoot: path.join(root, "preview"),
        projectRoot: root,
        stateFile: path.join(root, "preview", "active-preview.json"),
        unitName: "mira-dashboard-pr-preview.service",
    };
}

function previewExecution(
    id: string,
    status: "queued" | "success",
    previewStatus: "running" | "stopped"
): JobExecutionRecord {
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

function previewScheduledJob(
    number?: unknown,
    commitSha: unknown = COMMIT
): ScheduledJob {
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
    it("keeps host preview controls out of isolated Dashboard dev", async () => {
        const previousSafeMode = process.env.MIRA_DASHBOARD_DEV_SAFE_MODE;
        const statusSpy = jest.spyOn(previewHost, "getPullRequestPreviewStatus");
        const enqueueSpy = jest.spyOn(jobExecutionQueue, "enqueueJobExecution");
        const executionsSpy = jest.spyOn(jobExecutionQueue, "listJobExecutions");
        const pullRequestsSpy = jest.spyOn(pullRequests, "listDashboardPullRequests");
        const stateNumbersSpy = jest.spyOn(
            previewHost,
            "listManagedPullRequestPreviewStateNumbers"
        );
        process.env.MIRA_DASHBOARD_DEV_SAFE_MODE = "1";

        try {
            expect(await getDeliveryPullRequestPreviewStatus()).toEqual({
                controlsAvailable: false,
                message:
                    "PR dev controls are available only from the production Dashboard.",
                status: "stopped",
            });
            expect(await prepareAndStartPullRequestPreview(342, COMMIT)).toEqual({
                controlsAvailable: false,
                message:
                    "PR dev controls are available only from the production Dashboard.",
                status: "stopped",
            });
            expect(await prepareAndStopPullRequestPreview(342)).toEqual({
                controlsAvailable: false,
                message:
                    "PR dev controls are available only from the production Dashboard.",
                status: "stopped",
            });
            await reconcileClosedPullRequestPreview([]);
            expect(statusSpy).not.toHaveBeenCalled();
            expect(enqueueSpy).not.toHaveBeenCalled();
            expect(executionsSpy).not.toHaveBeenCalled();
            expect(pullRequestsSpy).not.toHaveBeenCalled();
            expect(stateNumbersSpy).not.toHaveBeenCalled();
        } finally {
            if (previousSafeMode === undefined) {
                delete process.env.MIRA_DASHBOARD_DEV_SAFE_MODE;
            } else {
                process.env.MIRA_DASHBOARD_DEV_SAFE_MODE = previousSafeMode;
            }
            statusSpy.mockRestore();
            enqueueSpy.mockRestore();
            executionsSpy.mockRestore();
            pullRequestsSpy.mockRestore();
            stateNumbersSpy.mockRestore();
        }
    });

    it("uses the running Bun executable when the service PATH does not expose Bun", () => {
        const root = mkdtempSync(path.join(tmpdir(), "mira-preview-bun-path-"));
        try {
            const config = resolvePullRequestPreviewConfig({
                HOME: root,
                MIRA_DASHBOARD_PROJECT_ROOT: root,
                PATH: path.join(root, "empty-bin"),
            });

            expect(config.bunExecutable).toBe(process.execPath);
            expect(path.isAbsolute(config.bunExecutable)).toBe(true);
        } finally {
            rmSync(root, { force: true, recursive: true });
        }
    });

    it("derives the fixed single-slot host contract from the project root", () => {
        const root = mkdtempSync(path.join(tmpdir(), "mira-preview-config-"));
        try {
            const config = resolvePullRequestPreviewConfig({
                HOME: root,
                MIRA_DASHBOARD_PROJECT_ROOT: root,
                OPENCLAW_GATEWAY_URL: "wss://gateway.example/ws",
            });
            expect(config).toMatchObject({
                backendPort: 3101,
                dashboardRoot: path.join(root, "production", "checkout"),
                databaseTemplate: path.join(
                    root,
                    "production",
                    "state",
                    "mira-dashboard.db"
                ),
                frontendPort: 5173,
                gatewayProxyPort: 18_790,
                gatewayProxyUnitName: "mira-dashboard-pr-preview-gateway.service",
                gatewayTokenFile: path.join(
                    root,
                    "development",
                    "state",
                    "preview",
                    "gateway.token"
                ),
                gatewayUrl: "wss://gateway.example/ws",
                managedWorktreePath: path.join(root, "development", "preview"),
                previewRoot: path.join(root, "development", "state", "preview"),
                projectRoot: root,
                releaseSource: path.join(root, "production", "releases"),
                unitName: "mira-dashboard-pr-preview.service",
            });
            expect(config.allowedAuthors).toEqual(new Set(["mira-2026", "rajohan"]));
            expect(() =>
                resolvePullRequestPreviewConfig({
                    HOME: root,
                    MIRA_DASHBOARD_PROJECT_ROOT: root,
                    OPENCLAW_GATEWAY_URL: "https://gateway.example/ws",
                })
            ).toThrow(
                "OPENCLAW_GATEWAY_URL must be ws:// or wss:// without credentials or a fragment"
            );
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
            const worktreePath = config.managedWorktreePath;
            const stateRoot = path.join(config.previewRoot, "states", "pr-335");
            const command = buildPullRequestPreviewSandboxCommand({
                config,
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
                "MIRA_DASHBOARD_PROJECT_ROOT",
                config.projectRoot,
                "MIRA_DASHBOARD_DEV_GATEWAY_TOKEN_FILE",
                "/run/mira-dashboard-preview/gateway.token",
                "MIRA_DASHBOARD_DEV_GATEWAY_URL",
                "ws://127.0.0.1:18790/gateway",
                "MIRA_DASHBOARD_DEV_HOT_RELOAD",
                "0",
                "MIRA_DASHBOARD_WEBAUTHN_RP_ID",
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
        const structuredLogs = captureStructuredLogs();

        try {
            expect(await getPullRequestPreviewStatus(config)).toEqual({
                status: "stopped",
            });
            expect(existsSync(config.stateFile)).toBe(false);
            expect(
                readdirSync(config.previewRoot).filter((entry) =>
                    entry.startsWith("active-preview.corrupt-")
                )
            ).toHaveLength(1);
            expect(structuredLogs.entries).toContainEqual(
                expect.objectContaining({
                    component: "pull-request-preview-host",
                    event: "preview.invalid_state_quarantined",
                    level: "error",
                    quarantinePath: expect.stringContaining("active-preview.corrupt-"),
                })
            );
        } finally {
            structuredLogs.stop();
            rmSync(root, { force: true, recursive: true });
        }
    });

    it("does not quarantine a preview record that cannot be safely read", () => {
        const root = mkdtempSync(path.join(tmpdir(), "mira-preview-unreadable-state-"));
        const config = previewConfig(root);
        mkdirSync(config.previewRoot, { recursive: true });
        writeFileSync(config.stateFile, "x".repeat(256 * 1024 + 1), {
            mode: 0o600,
        });

        try {
            expect(getPullRequestPreviewStatus(config)).rejects.toThrow(
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

    it("returns a warning when closed-PR cleanup cannot read its preview record", () => {
        const root = mkdtempSync(path.join(tmpdir(), "mira-preview-cleanup-warning-"));
        const config = previewConfig(root);
        mkdirSync(config.previewRoot, { recursive: true });
        writeFileSync(config.stateFile, "x".repeat(256 * 1024 + 1), {
            mode: 0o600,
        });

        try {
            expect(
                cleanupClosedPullRequestPreview(335, { config })
            ).resolves.toMatchObject({
                message: expect.stringContaining("Dashboard preview state is too large"),
                number: 335,
                status: "warning",
            });
            expect(existsSync(config.stateFile)).toBe(true);
        } finally {
            rmSync(root, { force: true, recursive: true });
        }
    });

    it("preserves preview state after a transient read failure", () => {
        const root = mkdtempSync(path.join(tmpdir(), "mira-preview-read-failure-"));
        const config = previewConfig(root);
        mkdirSync(config.previewRoot, { recursive: true });
        writeFileSync(config.stateFile, "{}\n", { mode: 0o000 });

        try {
            expect(getPullRequestPreviewStatus(config)).rejects.toThrow();
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

    it("rejects a symlinked preview record without quarantining its target", () => {
        const root = mkdtempSync(path.join(tmpdir(), "mira-preview-symlink-state-"));
        const config = previewConfig(root);
        const target = path.join(root, "outside-preview-state.json");
        mkdirSync(config.previewRoot, { recursive: true });
        writeFileSync(target, "{}\n", { mode: 0o600 });
        symlinkSync(target, config.stateFile);

        try {
            expect(getPullRequestPreviewStatus(config)).rejects.toThrow(
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

    it("removes closed PR state without touching a shared checkout owned by another PR", () => {
        const root = mkdtempSync(path.join(tmpdir(), "mira-preview-closed-state-"));
        const config = previewConfig(root);
        const managedStatePath = path.join(config.previewRoot, "states", "pr-335");
        mkdirSync(managedStatePath, { recursive: true });
        writeFileSync(path.join(managedStatePath, "state.txt"), "managed\n");
        mkdirSync(config.managedWorktreePath, { recursive: true });
        writeFileSync(path.join(config.managedWorktreePath, "other-pr.txt"), "keep\n");

        try {
            expect(
                cleanupClosedPullRequestPreview(335, { config })
            ).resolves.toMatchObject({
                number: 335,
                status: "removed",
            });
            expect(existsSync(managedStatePath)).toBe(false);
            expect(existsSync(config.managedWorktreePath)).toBe(true);
        } finally {
            rmSync(root, { force: true, recursive: true });
        }
    });

    it("lists only real isolated managed PR state directories", () => {
        const root = mkdtempSync(path.join(tmpdir(), "mira-preview-state-list-"));
        const config = previewConfig(root);
        const statesRoot = path.join(config.previewRoot, "states");
        const outsideState = path.join(root, "outside-state");
        mkdirSync(path.join(statesRoot, "pr-341"), { recursive: true });
        mkdirSync(path.join(statesRoot, "pr-335"), { recursive: true });
        mkdirSync(path.join(statesRoot, "pr-0"), { recursive: true });
        mkdirSync(path.join(statesRoot, "notes"), { recursive: true });
        mkdirSync(outsideState, { recursive: true });
        symlinkSync(outsideState, path.join(statesRoot, "pr-999"));

        try {
            expect(listManagedPullRequestPreviewStateNumbers(config)).toEqual([335, 341]);
        } finally {
            rmSync(root, { force: true, recursive: true });
        }
    });

    it("starts, reuses, updates, reports, and stops one trusted preview slot", async () => {
        const originalGatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN;
        const root = mkdtempSync(path.join(tmpdir(), "mira-preview-lifecycle-"));
        const config = {
            ...previewConfig(root),
            recentAuthMinutes: "10",
            sessionIdleMinutes: "60",
        };
        const worktreePath = config.managedWorktreePath;
        let expectedCommit = COMMIT;
        let shouldFailServeDisable = false;
        let shouldFailServeInspectionWhenEnabled = false;
        let isServeEnabled = false;
        let isPreviewUnitCollected = false;
        let didProxyReceiveDisposableToken = false;
        let didProxyReceiveUpstreamToken = false;
        let expectedUpstreamToken = "environment-gateway-token";
        let didProxyStartWithStartingRecord = false;
        let isMissingWorktreeRegistered = false;
        const activeUnits = new Set<string>();
        const commands: string[] = [];
        mkdirSync(config.dashboardRoot, { recursive: true });
        mkdirSync(config.gitCommonDirectory, { recursive: true });
        mkdirSync(worktreePath, { recursive: true });
        chmodSync(root, 0o755);

        const processSpy = jest
            .spyOn(processModule, "runProcess")
            .mockImplementation((executable, arguments_) => {
                return Promise.try(() => {
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
                            commandArguments.includes(
                                `--unit=${config.gatewayProxyUnitName}`
                            )
                        ) {
                            didProxyStartWithStartingRecord =
                                readJsonRecord(config.stateFile).status === "starting";
                            didProxyReceiveDisposableToken =
                                readFileSync(config.gatewayTokenFile, "utf8").trim() !==
                                "persisted-gateway-token";
                            didProxyReceiveUpstreamToken =
                                readFileSync(
                                    config.gatewayUpstreamTokenFile,
                                    "utf8"
                                ).trim() === expectedUpstreamToken;
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
                        if (readdirSync(worktreePath).length === 0) {
                            return {
                                code: 128,
                                stderr: "fatal: not a git repository (or any of the parent directories): .git",
                                stdout: "",
                            };
                        }
                        return { code: 0, stderr: "", stdout: `${worktreePath}\n` };
                    }
                    if (executable === "git" && commandArguments.includes("status")) {
                        return { code: 0, stderr: "", stdout: "" };
                    }
                    if (
                        executable === "git" &&
                        commandArguments.includes("worktree") &&
                        commandArguments.includes("list")
                    ) {
                        return {
                            code: 0,
                            stderr: "",
                            stdout: isMissingWorktreeRegistered
                                ? `worktree ${worktreePath}\nHEAD ${expectedCommit}\ndetached\n\n`
                                : "",
                        };
                    }
                    if (
                        executable === "git" &&
                        commandArguments.includes("worktree") &&
                        commandArguments.includes("add")
                    ) {
                        if (isMissingWorktreeRegistered) {
                            throw new Error(
                                "stale worktree registration was not cleared"
                            );
                        }
                        mkdirSync(path.join(worktreePath, "backend"), {
                            recursive: true,
                        });
                    }
                    if (
                        executable === "git" &&
                        commandArguments.includes("worktree") &&
                        commandArguments.includes("remove")
                    ) {
                        isMissingWorktreeRegistered = false;
                        rmSync(worktreePath, { force: true, recursive: true });
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
            process.env.OPENCLAW_GATEWAY_TOKEN = "environment-gateway-token";
            const candidate = {
                authorLogins: ["mira-2026"],
                commitSha: COMMIT,
                number: 335,
                rootBaseRefName: "main",
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
            expect(statSync(root).mode & 0o777).toBe(0o755);
            const worktreeAddIndex = commands.findIndex((command) =>
                command.includes(`worktree add --detach ${config.managedWorktreePath}`)
            );
            expect(worktreeAddIndex).toBeGreaterThanOrEqual(0);
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
            delete process.env.OPENCLAW_GATEWAY_TOKEN;
            expectedUpstreamToken = "persisted-gateway-token";
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
            expect(getPullRequestPreviewStatus(config)).resolves.toMatchObject({
                number: 335,
                status: "running",
            });
            expect(startPullRequestPreview(candidate, { config })).resolves.toMatchObject(
                {
                    commitSha: COMMIT,
                    status: "running",
                }
            );
            const interruptedRecord = readJsonRecord(config.stateFile);
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
            expect(getPullRequestPreviewStatus(config)).resolves.toMatchObject({
                commitSha: COMMIT,
                status: "starting",
            });
            expect(
                startPullRequestPreview(candidate, {
                    config,
                    readGatewayToken: () => "persisted-gateway-token",
                })
            ).resolves.toMatchObject({
                commitSha: COMMIT,
                status: "running",
            });
            expect(prepareStateSpy).toHaveBeenCalledTimes(2);

            const interruptedAfterServeRecord = readJsonRecord(config.stateFile);
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
            expect(getPullRequestPreviewStatus(config)).resolves.toMatchObject({
                commitSha: COMMIT,
                status: "stopped",
            });
            expect(isServeEnabled).toBe(false);
            expect(existsSync(config.gatewayTokenFile)).toBe(false);
            expect(existsSync(config.gatewayUpstreamTokenFile)).toBe(false);
            expect(readJsonRecord(config.stateFile)).toMatchObject({
                ownsTailscaleServe: false,
                status: "stopped",
            });

            rmSync(worktreePath, { force: true, recursive: true });
            isMissingWorktreeRegistered = true;
            expect(
                startPullRequestPreview(candidate, {
                    config,
                    readGatewayToken: () => "persisted-gateway-token",
                })
            ).resolves.toMatchObject({
                commitSha: COMMIT,
                status: "running",
            });
            const staleRemovalIndex = commands.findIndex((command) =>
                command.includes(
                    `worktree remove --force --force ${config.managedWorktreePath}`
                )
            );
            const recreatedWorktreeIndex = commands.findLastIndex((command) =>
                command.includes(`worktree add --detach ${config.managedWorktreePath}`)
            );
            expect(staleRemovalIndex).toBeGreaterThanOrEqual(0);
            expect(recreatedWorktreeIndex).toBeGreaterThan(staleRemovalIndex);
            expect(prepareStateSpy).toHaveBeenCalledTimes(3);
            expect(
                startPullRequestPreview(
                    { ...candidate, number: 336, title: "Other trusted preview" },
                    { config }
                )
            ).rejects.toMatchObject({ statusCode: 409 });
            expect(stopPullRequestPreview(336, { config })).rejects.toMatchObject({
                statusCode: 409,
            });
            expect(
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
            expect(existsSync(worktreePath)).toBe(true);

            isServeEnabled = true;
            expect(startPullRequestPreview(candidate, { config })).rejects.toMatchObject({
                statusCode: 409,
            });
            isServeEnabled = false;

            expectedCommit = "b".repeat(40);
            expect(
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
            expect(getPullRequestPreviewStatus(config)).resolves.toMatchObject({
                number: 335,
                status: "stopped",
            });
            expect(isServeEnabled).toBe(false);
            expect(existsSync(config.gatewayTokenFile)).toBe(false);
            expect(existsSync(config.gatewayUpstreamTokenFile)).toBe(false);

            expectedCommit = "c".repeat(40);
            shouldFailServeDisable = true;
            shouldFailServeInspectionWhenEnabled = true;
            expect(
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
            expect(readJsonRecord(config.stateFile)).toMatchObject({
                commitSha: expectedCommit,
                ownsTailscaleServe: true,
                status: "failed",
            });
            expect(getPullRequestPreviewStatus(config)).resolves.toMatchObject({
                commitSha: expectedCommit,
                message: expect.stringContaining(
                    "Tailscale Serve activation failed and its route could not be removed"
                ),
                status: "failed",
            });
            expect(stopPullRequestPreview(335, { config })).rejects.toThrow(
                "PR dev stop cleanup failed"
            );
            expect(readJsonRecord(config.stateFile)).toMatchObject({
                ownsTailscaleServe: true,
                status: "failed",
            });
            shouldFailServeDisable = false;
            shouldFailServeInspectionWhenEnabled = false;
            expect(stopPullRequestPreview(335, { config })).resolves.toMatchObject({
                status: "stopped",
            });
            expect(isServeEnabled).toBe(false);

            const stoppedRecord = readJsonRecord(config.stateFile);
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
            expect(getPullRequestPreviewStatus(config)).resolves.toMatchObject({
                status: "stopped",
            });
            expect(activeUnits.size).toBe(0);
            expect(isServeEnabled).toBe(false);
            expect(readJsonRecord(config.stateFile)).toMatchObject({
                ownsTailscaleServe: false,
                status: "stopped",
            });
            const managedStatePath = path.join(config.previewRoot, "states", "pr-335");
            mkdirSync(managedStatePath, { recursive: true });
            writeFileSync(path.join(managedStatePath, "state.txt"), "managed\n");
            expect(
                cleanupClosedPullRequestPreview(335, { config })
            ).resolves.toMatchObject({
                number: 335,
                status: "removed",
            });
            expect(existsSync(worktreePath)).toBe(false);
            expect(existsSync(managedStatePath)).toBe(false);
            expect(existsSync(config.stateFile)).toBe(false);
            expect(
                commands.some((command) =>
                    command.includes(
                        `worktree remove --force ${config.managedWorktreePath}`
                    )
                )
            ).toBe(true);
        } finally {
            if (originalGatewayToken === undefined) {
                delete process.env.OPENCLAW_GATEWAY_TOKEN;
            } else {
                process.env.OPENCLAW_GATEWAY_TOKEN = originalGatewayToken;
            }
            processSpy.mockRestore();
            prepareStateSpy.mockRestore();
            fetchSpy.mockRestore();
            rmSync(root, { force: true, recursive: true });
        }
    });

    it("queues preview operations and registers guarded worker actions", async () => {
        const queuedStart = previewExecution("preview-start", "queued", "running");
        const queuedStop = previewExecution("preview-stop", "queued", "stopped");
        const queuedCleanup = {
            ...queuedStop,
            actionKey: "dashboard.preview.cleanup",
            id: "preview-cleanup",
            payload: { number: 335 },
        };
        const completedStart = previewExecution("preview-start", "success", "running");
        const completedStop = previewExecution("preview-stop", "success", "stopped");
        const enqueueSpy = jest
            .spyOn(jobExecutionQueue, "enqueueJobExecution")
            .mockImplementation((input) => {
                if (input.actionKey === "dashboard.preview.start") return queuedStart;
                if (input.actionKey === "dashboard.preview.cleanup") {
                    return queuedCleanup;
                }
                return queuedStop;
            });
        const executionsSpy = jest
            .spyOn(jobExecutionQueue, "listJobExecutions")
            .mockReturnValue([]);
        const waitSpy = jest
            .spyOn(queuedJobExecution, "waitForJobExecution")
            .mockImplementation((id) =>
                Promise.try(() =>
                    id === queuedStart.id ? completedStart : completedStop
                )
            );
        const handlers = new Map<string, ScheduledJobActionHandler>();
        const registerSpy = jest
            .spyOn(scheduledJobActions, "registerScheduledJobAction")
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
        const isOpenSpy = jest
            .spyOn(pullRequests, "isDashboardPullRequestOpen")
            .mockResolvedValue(false);
        const startSpy = jest
            .spyOn(previewHost, "startPullRequestPreview")
            .mockResolvedValue({ number: 335, status: "running" });
        const stopSpy = jest
            .spyOn(previewHost, "stopPullRequestPreview")
            .mockResolvedValue({ number: 335, status: "stopped" });
        const cleanupSpy = jest
            .spyOn(previewHost, "cleanupClosedPullRequestPreview")
            .mockResolvedValue({
                message: "Removed managed PR dev data for #335",
                number: 335,
                status: "removed",
            });
        const stateNumbersSpy = jest
            .spyOn(previewHost, "listManagedPullRequestPreviewStateNumbers")
            .mockReturnValue([]);
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
            expect(await prepareAndStartPullRequestPreview(335, COMMIT)).toMatchObject({
                commitSha: COMMIT,
                number: 335,
                status: "starting",
                title: "Trusted preview",
                updatedAt: expect.any(String),
            });
            expect(
                await captureRejection(() =>
                    prepareAndStartPullRequestPreview(335, "b".repeat(40))
                )
            ).toMatchObject({ statusCode: 409 });
            statusSpy.mockResolvedValueOnce({
                number: 334,
                status: "running",
            });
            expect(
                await captureRejection(() =>
                    prepareAndStartPullRequestPreview(335, COMMIT)
                )
            ).toMatchObject({ statusCode: 409 });
            expect(await prepareAndStopPullRequestPreview(335)).toEqual({
                number: 335,
                status: "stopped",
            });
            expect(await prepareAndStopPullRequestPreview()).toEqual({
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
            ].POST(previewRouteRequest("335", COMMIT));
            expect(startResponse.status).toBe(202);
            expect(startResponse.json()).resolves.toMatchObject({
                isOk: true,
                preview: {
                    commitSha: COMMIT,
                    number: 335,
                    status: "starting",
                    title: "Trusted preview",
                    updatedAt: expect.any(String),
                },
            });
            const missingHeadResponse = await pullRequestRoutes[
                "/api/pull-requests/:number/preview/start"
            ].POST(previewRouteRequest("335", ""));
            expect(missingHeadResponse.status).toBe(400);
            expect(await missingHeadResponse.json()).toMatchObject({
                error: {
                    code: "invalid_request",
                    details: {
                        issues: [
                            {
                                path: "body.expectedHeadSha",
                            },
                        ],
                    },
                },
            });

            const stopResponse = await pullRequestRoutes[
                "/api/pull-requests/:number/preview/stop"
            ].POST(previewRouteRequest("335"));
            expect(stopResponse.status).toBe(200);
            expect(stopResponse.json()).resolves.toEqual({
                isOk: true,
                preview: { number: 335, status: "stopped" },
            });

            statusSpy.mockResolvedValue(runningPreview);
            executionsSpy.mockReturnValueOnce([queuedStart]);
            const statusResponse =
                await pullRequestRoutes["/api/pull-requests/preview"].GET();
            expect(statusResponse.status).toBe(200);
            expect(statusResponse.json()).resolves.toMatchObject({
                preview: {
                    commitSha: COMMIT,
                    number: 335,
                    status: "starting",
                    updatedAt: queuedStart.queuedAt,
                },
            });
            const enqueueCallsBeforeReconciliation = enqueueSpy.mock.calls.length;
            executionsSpy.mockReturnValue([]);
            isOpenSpy.mockResolvedValueOnce(true);
            await reconcileClosedPullRequestPreview([]);
            expect(enqueueSpy).toHaveBeenCalledTimes(enqueueCallsBeforeReconciliation);
            await reconcileClosedPullRequestPreview([]);
            expect(enqueueSpy).toHaveBeenLastCalledWith(
                expect.objectContaining({
                    actionKey: "dashboard.preview.cleanup",
                    payload: { number: 335 },
                    resourceClass: "exclusive",
                })
            );
            expect(enqueueSpy).toHaveBeenCalledTimes(
                enqueueCallsBeforeReconciliation + 1
            );
            stateNumbersSpy.mockReturnValueOnce([334]);
            await reconcileClosedPullRequestPreview([pullRequest]);
            expect(enqueueSpy).toHaveBeenLastCalledWith(
                expect.objectContaining({
                    actionKey: "dashboard.preview.cleanup",
                    payload: { number: 334 },
                    resourceClass: "exclusive",
                })
            );
            expect(enqueueSpy).toHaveBeenCalledTimes(
                enqueueCallsBeforeReconciliation + 2
            );
            executionsSpy.mockReturnValue([queuedCleanup]);
            await reconcileClosedPullRequestPreview([]);
            expect(enqueueSpy).toHaveBeenCalledTimes(
                enqueueCallsBeforeReconciliation + 2
            );
            executionsSpy.mockReturnValue([]);
            statusSpy.mockRejectedValueOnce(new Error("preview status unavailable"));
            expect(reconcileClosedPullRequestPreview([])).rejects.toThrow(
                "preview status unavailable"
            );
            expect(enqueueSpy).toHaveBeenCalledTimes(
                enqueueCallsBeforeReconciliation + 2
            );

            for (const route of [
                "/api/pull-requests/:number/preview/start",
                "/api/pull-requests/:number/preview/stop",
            ] as const) {
                const invalidResponse = await pullRequestRoutes[route].POST(
                    previewRouteRequest("invalid", COMMIT)
                );
                expect(invalidResponse.status).toBe(400);
                expect(invalidResponse.json()).resolves.toEqual(
                    apiErrorExpectation("Invalid pull request number")
                );
            }

            listSpy.mockRejectedValueOnce(
                Object.assign(new Error("preview startup unavailable"), {
                    statusCode: 503,
                })
            );
            const failedStartResponse = await pullRequestRoutes[
                "/api/pull-requests/:number/preview/start"
            ].POST(previewRouteRequest("335", COMMIT));
            expect(failedStartResponse.status).toBe(503);
            expect(failedStartResponse.json()).resolves.toEqual(
                apiErrorExpectation("preview startup unavailable")
            );

            waitSpy.mockRejectedValueOnce(
                Object.assign(new Error("preview stop unavailable"), {
                    statusCode: 503,
                })
            );
            const failedStopResponse = await pullRequestRoutes[
                "/api/pull-requests/:number/preview/stop"
            ].POST(previewRouteRequest("335"));
            expect(failedStopResponse.status).toBe(503);
            expect(failedStopResponse.json()).resolves.toEqual(
                apiErrorExpectation("preview stop unavailable")
            );

            statusSpy.mockRejectedValueOnce(
                Object.assign(new Error("preview status unavailable"), {
                    statusCode: 503,
                })
            );
            const failedStatusResponse =
                await pullRequestRoutes["/api/pull-requests/preview"].GET();
            expect(failedStatusResponse.status).toBe(503);
            expect(failedStatusResponse.json()).resolves.toEqual(
                apiErrorExpectation("preview status unavailable")
            );

            registerPullRequestPreviewExecutionActions();
            const cleanupHandler = handlers.get("dashboard.preview.cleanup");
            const reconcileHandler = handlers.get("dashboard.preview.reconcile");
            const startHandler = handlers.get("dashboard.preview.start");
            const stopHandler = handlers.get("dashboard.preview.stop");
            expect(cleanupHandler).toBeDefined();
            expect(reconcileHandler).toBeDefined();
            expect(startHandler).toBeDefined();
            expect(stopHandler).toBeDefined();
            if (!cleanupHandler || !reconcileHandler || !startHandler || !stopHandler) {
                throw new Error("Preview handlers were not registered");
            }
            expect(
                scheduledJobRepository.getScheduledJob("dashboard.preview.reconcile")
            ).toMatchObject({
                actionKey: "dashboard.preview.reconcile",
                enabled: true,
                intervalSeconds: 6 * 60 * 60,
                scheduleType: "interval",
            });
            scheduledJobRepository.updateScheduledJob("dashboard.preview.reconcile", {
                enabled: false,
                intervalSeconds: 12 * 60 * 60,
            });
            registerPullRequestPreviewExecutionActions();
            expect(
                scheduledJobRepository.getScheduledJob("dashboard.preview.reconcile")
            ).toMatchObject({
                enabled: false,
                intervalSeconds: 12 * 60 * 60,
                scheduleType: "interval",
            });
            listSpy.mockResolvedValue([pullRequest]);
            statusSpy.mockResolvedValue({ status: "stopped" });
            expect(
                reconcileHandler(previewScheduledJob(), undefined, context)
            ).resolves.toEqual({ openPullRequestCount: 1 });
            expect(
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
                    authorLogins: ["mira-2026"],
                    commitSha: COMMIT,
                    number: 335,
                    rootBaseRefName: "main",
                }),
                expect.objectContaining({
                    protectFromCancellation: expect.any(Function),
                    signal: expect.any(AbortSignal),
                })
            );
            startSpy.mock.calls[0]?.[1]?.protectFromCancellation?.();
            expect(protectFromCancellation).toHaveBeenCalledTimes(1);
            expect(
                stopHandler(previewScheduledJob(), undefined, context)
            ).resolves.toEqual({
                preview: { number: 335, status: "stopped" },
            });
            expect(stopSpy).toHaveBeenCalledWith(
                undefined,
                expect.objectContaining({
                    protectFromCancellation: expect.any(Function),
                })
            );
            isOpenSpy.mockResolvedValueOnce(true);
            expect(
                cleanupHandler(previewScheduledJob(335), undefined, context)
            ).resolves.toMatchObject({
                cleanup: {
                    number: 335,
                    status: "skipped",
                },
            });
            expect(cleanupSpy).not.toHaveBeenCalled();
            listSpy.mockResolvedValue([]);
            statusSpy.mockResolvedValue({ status: "stopped" });
            expect(
                cleanupHandler(previewScheduledJob(335), undefined, context)
            ).resolves.toEqual({
                cleanup: {
                    message: "Removed managed PR dev data for #335",
                    number: 335,
                    status: "removed",
                },
                preview: { status: "stopped" },
            });
            expect(cleanupSpy).toHaveBeenCalledWith(335);
            expect(protectFromCancellation).toHaveBeenCalledTimes(2);

            listSpy.mockResolvedValue([{ ...pullRequest, headRefOid: "b".repeat(40) }]);
            expect(
                startHandler(previewScheduledJob(335, COMMIT), undefined, context)
            ).rejects.toMatchObject({ statusCode: 409 });
            expect(startSpy).toHaveBeenCalledTimes(1);

            listSpy.mockResolvedValue([]);
            expect(
                startHandler(previewScheduledJob(336), undefined, context)
            ).rejects.toMatchObject({ statusCode: 404 });
        } finally {
            enqueueSpy.mockRestore();
            executionsSpy.mockRestore();
            waitSpy.mockRestore();
            registerSpy.mockRestore();
            listSpy.mockRestore();
            isOpenSpy.mockRestore();
            startSpy.mockRestore();
            stopSpy.mockRestore();
            cleanupSpy.mockRestore();
            stateNumbersSpy.mockRestore();
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
            expect(
                await captureRejection(() =>
                    startPullRequestPreview(
                        {
                            authorLogins: ["mira-2026", "external"],
                            commitSha: COMMIT,
                            number: 335,
                            rootBaseRefName: "main",
                            title: "Untrusted PR",
                        },
                        { config }
                    )
                )
            ).toMatchObject({
                message:
                    "Every pull request included in a host preview must have an allowed author",
            });
            expect(
                await captureRejection(() =>
                    startPullRequestPreview(
                        {
                            authorLogins: ["mira-2026"],
                            commitSha: COMMIT,
                            number: 335,
                            rootBaseRefName: "release",
                            title: "Wrong base",
                        },
                        { config }
                    )
                )
            ).toMatchObject({
                message: "Only main-rooted pull requests can be previewed",
            });
        } finally {
            rmSync(root, { force: true, recursive: true });
        }
    });
});
