import { afterEach, beforeEach, describe, expect, it, jest } from "bun:test";

import { QueryClient } from "@tanstack/react-query";
import { act, waitFor } from "@testing-library/react";

import type { OpenClawConfig } from "../../../../contracts/openClawConfig";
import { parseWeatherData } from "../../../../contracts/weather";
import { requestBodyText, requestUrl } from "../../../../test/support/fetch";
import {
    useAgentsConfig,
    useAgentsStatus,
    useAgentStatus,
    useAgentTaskHistory,
} from "../../hooks/useAgents";
import { useKopiaBackup, useRunKopiaBackup, useWalgBackup } from "../../hooks/useBackups";
import {
    cacheKeys,
    useCacheEntry,
    useCacheHeartbeat,
    useCacheStatus,
    useRefreshCacheEntry,
} from "../../hooks/useCache";
import {
    useConfig,
    useCreateBackup,
    useRestartGateway,
    useSkills,
    useToggleSkill,
    useUpdateConfig,
} from "../../hooks/useConfig";
import {
    useCronJobs,
    useDeleteCronJob,
    useRunCronJobNow,
    useToggleCronJob,
    useUpdateCronJob,
} from "../../hooks/useCron";
import { useDatabaseOverview } from "../../hooks/useDatabase";
import {
    deliveryKeys,
    useApprovePullRequest,
    useApprovePullRequestReview,
    useCreatePullRequestStack,
    useDashboardDeployments,
    useDashboardReleaseStatus,
    useDeployDashboard,
    useProductionCheckout,
    usePullRequestPreview,
    usePullRequests,
    useRejectPullRequest,
    useRollbackDashboard,
    useStartPullRequestPreview,
    useStopPullRequestPreview,
    useUpdatePullRequestBranch,
} from "../../hooks/useDelivery";
import { useDockerContainers } from "../../hooks/useDocker";
import { useFileContent, useFiles, useSaveFile } from "../../hooks/useFiles";
import { useHealth } from "../../hooks/useHealth";
import {
    jobExecutionKeys,
    refreshJobExecutionQueueWhilePending,
} from "../../hooks/useJobExecutions";
import { useLogContent, useLogFiles } from "../../hooks/useLogs";
import { useMetrics } from "../../hooks/useMetrics";
import { useMoltbookData } from "../../hooks/useMoltbook";
import { OPS_ACTIONS, useExecJob, useStartOpsAction } from "../../hooks/useOpsActions";
import { useQuotas } from "../../hooks/useQuotas";
import {
    scheduledJobKeys,
    useRunScheduledJobNow,
    useScheduledJobRuns,
    useScheduledJobs,
    useUpdateScheduledJob,
} from "../../hooks/useScheduledJobs";
import { useDeleteSession, useSessionAction } from "../../hooks/useSessions";
import {
    taskKeys,
    useAssignTask,
    useCreateTaskUpdate,
    useDeleteTask,
    useDeleteTaskUpdate,
    useMoveTask,
    useTaskUpdates,
    useUpdateTask,
    useUpdateTaskUpdate,
} from "../../hooks/useTasks";
import {
    changeDirectory,
    getCompletions,
    stopTerminalJob,
    useStartTerminalCommand,
    useTerminalHistory,
    useTerminalJob,
} from "../../hooks/useTerminal";
import { useWeather } from "../../hooks/useWeather";
import { uninstallAuthSessionRotationSync } from "../../lib/authBoundary";
import { resetUserActivityForTests } from "../../lib/userActivity";
import { authActions } from "../../stores/authStore";
import { createFrontendBehaviorHarness } from "../support/frontendBehaviorHarness";
describe("Dashboard data hooks", () => {
    const {
        cacheEnvelopeFixture,
        dashboardDiagnostics,
        dashboardMetrics,
        databaseOverviewFixture,
        renderHookWithQueryClient,
        task,
    } = createFrontendBehaviorHarness();
    beforeEach(() => {
        authActions.clearSession();
        resetUserActivityForTests();
    });
    afterEach(() => {
        uninstallAuthSessionRotationSync();
        authActions.clearSession();
        resetUserActivityForTests();
    });
    it("fetches log, file, job, backup, and pull request APIs through dashboard hooks", async () => {
        const fetchMock = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
            return Promise.try(() => {
                const url = requestUrl(input);
                const method = init?.method ?? "GET";
                if (url === "/api/logs/openclaw/files" && method === "GET") {
                    return Response.json({
                        logs: [
                            {
                                modified: "2026-07-28T12:00:00.000Z",
                                name: "openclaw.log",
                                size: 123,
                            },
                        ],
                    });
                }
                if (
                    url === "/api/logs/openclaw/content?file=openclaw.log&lines=50" &&
                    method === "GET"
                ) {
                    return Response.json({
                        content: "info line\nerror line",
                        file: "openclaw.log",
                        lineIds: ["10", "20"],
                    });
                }
                if (url === "/api/files?path=src" && method === "GET") {
                    return Response.json({
                        files: [
                            {
                                path: "src/main.tsx",
                                name: "main.tsx",
                                type: "file",
                            },
                        ],
                    });
                }
                if (url === "/api/files/src%2Fmain.tsx" && method === "GET") {
                    return Response.json({
                        content: "render app",
                        isBinary: false,
                        modified: "2026-07-28T12:00:00.000Z",
                        path: "src/main.tsx",
                        size: 10,
                    });
                }
                if (url === "/api/config-files/openclaw.json" && method === "GET") {
                    return Response.json({
                        content: "{}",
                        isBinary: false,
                        modified: "2026-07-28T12:00:00.000Z",
                        path: "config:openclaw.json",
                        size: 2,
                    });
                }
                if (url === "/api/agents/status" && method === "GET") {
                    return Response.json({
                        agents: [
                            {
                                currentTask: "Expanding tests",
                                id: "main",
                                model: "codex",
                                status: "active",
                            },
                        ],
                        timestamp: 1_782_475_200_000,
                    });
                }
                if (url === "/api/agents/config" && method === "GET") {
                    return Response.json({
                        defaults: {
                            model: {
                                primary: "codex",
                                fallbacks: ["kimi"],
                            },
                        },
                        list: [
                            {
                                default: true,
                                id: "main",
                                model: {
                                    primary: "codex",
                                    fallbacks: ["kimi"],
                                },
                                subagents: {
                                    allowAgents: ["coder"],
                                },
                            },
                        ],
                    });
                }
                if (url === "/api/agents/tasks/history?limit=3" && method === "GET") {
                    return Response.json({
                        tasks: [
                            {
                                agentId: "main",
                                id: 1,
                                lastActivityAt: "2026-06-23T08:00:00.000Z",
                                startedAt: "2026-06-23T07:00:00.000Z",
                                status: "done",
                                task: "Finished a coverage batch",
                            },
                        ],
                        timestamp: 1_782_475_201_000,
                    });
                }
                if (url === "/api/agents/main/status" && method === "GET") {
                    return Response.json({
                        currentTask: "Expanding tests",
                        id: "main",
                        model: "codex",
                        status: "active",
                    });
                }
                if (url === "/api/files/src%2Fmain.tsx" && method === "PUT") {
                    expect(JSON.parse(requestBodyText(init?.body))).toEqual({
                        content: "updated",
                    });
                    return Response.json({
                        isSuccess: true,
                        modified: "2026-07-28T12:01:00.000Z",
                        path: "src/main.tsx",
                        size: 7,
                    });
                }
                if (url === "/api/jobs" && method === "GET") {
                    return Response.json({
                        jobs: [
                            {
                                id: "job-1",
                                name: "Job One",
                                description: "Runs things",
                                enabled: true,
                                scheduleType: "interval",
                                intervalSeconds: 60,
                                actionKey: "test",
                                actionPayload: {},
                                createdAt: "2026-06-23T08:00:00.000Z",
                                updatedAt: "2026-06-23T08:00:00.000Z",
                                isQueued: false,
                                isRunning: false,
                                resourceClass: "light",
                                timeoutMs: 60_000,
                            },
                        ],
                    });
                }
                if (url === "/api/jobs/job-1/runs" && method === "GET") {
                    return Response.json({
                        runs: [
                            {
                                id: 1,
                                jobId: "job-1",
                                cancellable: false,
                                queuedAt: "2026-06-23T08:00:00.000Z",
                                resourceClass: "light",
                                status: "success",
                                triggerType: "manual",
                                startedAt: "2026-06-23T08:00:00.000Z",
                                output: {
                                    ok: true,
                                },
                            },
                        ],
                    });
                }
                if (url === "/api/jobs/job-1" && method === "PATCH") {
                    expect(JSON.parse(requestBodyText(init?.body))).toEqual({
                        patch: {
                            enabled: false,
                            disableIntent: {
                                mode: "indefinite",
                                comment: "Paused for hook coverage",
                            },
                        },
                    });
                    return Response.json({
                        isOk: true,
                        job: {
                            actionKey: "test",
                            actionPayload: {},
                            createdAt: "2026-06-23T08:00:00.000Z",
                            description: "Runs things",
                            disableIntent: {
                                comment: "Paused for hook coverage",
                                mode: "indefinite",
                            },
                            enabled: false,
                            id: "job-1",
                            intervalSeconds: 60,
                            isQueued: false,
                            isRunning: false,
                            name: "Job One",
                            resourceClass: "light",
                            scheduleType: "interval",
                            timeoutMs: 60_000,
                            updatedAt: "2026-06-23T08:00:00.000Z",
                        },
                    });
                }
                if (url === "/api/jobs/job-1/run" && method === "POST") {
                    return Response.json({
                        isOk: true,
                        run: {
                            id: 2,
                            jobId: "job-1",
                            cancellable: false,
                            queuedAt: "2026-06-23T08:00:00.000Z",
                            resourceClass: "light",
                            status: "success",
                            triggerType: "manual",
                            startedAt: "2026-06-23T08:00:00.000Z",
                            output: {},
                        },
                    });
                }
                if (url === "/api/backups/kopia" && method === "GET") {
                    return Response.json({
                        job: {
                            endedAt: 1_782_475_200_000,
                            id: "kopia-1",
                            startedAt: 1_782_475_199_000,
                            status: "done",
                            stderr: "",
                            stdout: "snapshot complete",
                            type: "kopia",
                        },
                    });
                }
                if (url === "/api/backups/walg" && method === "GET") {
                    return Response.json({});
                }
                if (url === "/api/backups/kopia/run" && method === "POST") {
                    return Response.json({
                        isOk: true,
                        job: {
                            id: "kopia-2",
                            startedAt: 1_782_475_200_000,
                            status: "running",
                            stderr: "",
                            stdout: "",
                            type: "kopia",
                        },
                    });
                }
                if (url === "/api/pull-requests" && method === "GET") {
                    return Response.json({
                        pullRequests: [
                            {
                                number: 189,
                                title: "Functional tests",
                                url: "/pull/189",
                                headRefName: "tests",
                                baseRefName: "main",
                                author: {
                                    login: "mira-2026",
                                },
                                createdAt: "2026-06-23T08:00:00.000Z",
                                updatedAt: "2026-06-23T08:00:00.000Z",
                                isDraft: false,
                            },
                        ],
                    });
                }
                if (url === "/api/pull-requests/deployments" && method === "GET") {
                    return Response.json({
                        deployments: [
                            {
                                id: "deploy-1",
                                status: "isOk",
                                startedAt: "2026-06-23T08:00:00.000Z",
                                updatedAt: "2026-06-23T08:01:00.000Z",
                            },
                        ],
                    });
                }
                if (
                    url === "/api/pull-requests/production-checkout" &&
                    method === "GET"
                ) {
                    return Response.json({
                        checkout: {
                            root: "/srv/app",
                            expectedRoot: "/srv/app",
                            worktreeRoot: "/srv/app",
                            branch: "main",
                            expectedBranch: "main",
                            head: "abc123",
                            headCommit: "abc123",
                            isClean: true,
                            isProductionRoot: true,
                            isSafeForDeploy: true,
                        },
                    });
                }
                if (url === "/api/pull-requests/releases" && method === "GET") {
                    return Response.json({
                        release: {
                            current: {
                                builtAt: "2026-06-23T08:00:00.000Z",
                                commitSha: "a".repeat(40),
                                commitTitle: "Current release",
                                commitUrl: `https://github.com/rajohan/Mira-Dashboard/commit/${"a".repeat(40)}`,
                                schema: {
                                    maximumCompatible: 31,
                                    minimumCompatible: 1,
                                    target: 31,
                                },
                            },
                            previous: {
                                builtAt: "2026-06-22T08:00:00.000Z",
                                commitSha: "b".repeat(40),
                                commitTitle: "Previous release",
                                commitUrl: `https://github.com/rajohan/Mira-Dashboard/commit/${"b".repeat(40)}`,
                                schema: {
                                    maximumCompatible: 31,
                                    minimumCompatible: 1,
                                    target: 31,
                                },
                            },
                            rollback: {
                                available: true,
                            },
                        },
                    });
                }
                if (url === "/api/pull-requests/preview" && method === "GET") {
                    return Response.json({
                        preview: {
                            number: 189,
                            status: "running",
                            url: "https://dashboard.test:5173",
                        },
                    });
                }
                throw new Error(`Unexpected hook API call: ${method} ${url}`);
            });
        });
        Object.defineProperty(globalThis, "fetch", {
            configurable: true,
            value: fetchMock,
            writable: true,
        });
        const logFiles = renderHookWithQueryClient(() => useLogFiles());
        await waitFor(() => expect(logFiles.result.current.data).toHaveLength(1));
        expect(logFiles.result.current.data?.[0]?.name).toBe("openclaw.log");
        const logContent = renderHookWithQueryClient(() =>
            useLogContent("openclaw.log", 50)
        );
        await waitFor(() =>
            expect(logContent.result.current.data).toEqual({
                content: "info line\nerror line",
                file: "openclaw.log",
                lineIds: ["10", "20"],
            })
        );
        const files = renderHookWithQueryClient(() => useFiles("src"));
        await waitFor(() =>
            expect(files.result.current.data?.[0]?.path).toBe("src/main.tsx")
        );
        const fileContent = renderHookWithQueryClient(() =>
            useFileContent("src/main.tsx")
        );
        await waitFor(() =>
            expect(fileContent.result.current.data?.content).toBe("render app")
        );
        const configContent = renderHookWithQueryClient(() =>
            useFileContent("config:openclaw.json")
        );
        await waitFor(() =>
            expect(configContent.result.current.data?.content).toBe("{}")
        );
        const agentsStatus = renderHookWithQueryClient(() => useAgentsStatus());
        await waitFor(() =>
            expect(agentsStatus.result.current.data?.agents[0]?.currentTask).toBe(
                "Expanding tests"
            )
        );
        const agentsConfig = renderHookWithQueryClient(() => useAgentsConfig());
        await waitFor(() =>
            expect(agentsConfig.result.current.data?.defaults.model?.primary).toBe(
                "codex"
            )
        );
        const agentTaskHistory = renderHookWithQueryClient(() => useAgentTaskHistory(3));
        await waitFor(() =>
            expect(agentTaskHistory.result.current.data?.tasks[0]?.task).toBe(
                "Finished a coverage batch"
            )
        );
        const agentStatus = renderHookWithQueryClient(() => useAgentStatus("main"));
        await waitFor(() =>
            expect(agentStatus.result.current.data?.currentTask).toBe("Expanding tests")
        );
        const saveFile = renderHookWithQueryClient(() => useSaveFile());
        await saveFile.result.current.mutateAsync({
            path: "src/main.tsx",
            content: "updated",
        });
        const jobs = renderHookWithQueryClient(() => useScheduledJobs());
        await waitFor(() => expect(jobs.result.current.data?.[0]?.id).toBe("job-1"));
        const jobRuns = renderHookWithQueryClient(() => useScheduledJobRuns("job-1"));
        await waitFor(() =>
            expect(jobRuns.result.current.data?.[0]?.status).toBe("success")
        );
        const updateJob = renderHookWithQueryClient(() => useUpdateScheduledJob());
        await updateJob.result.current.mutateAsync({
            id: "job-1",
            patch: {
                enabled: false,
                disableIntent: {
                    mode: "indefinite",
                    comment: "Paused for hook coverage",
                },
            },
        });
        const runJob = renderHookWithQueryClient(() => useRunScheduledJobNow());
        runJob.queryClient.setQueryData(jobExecutionKeys.list(), {
            executions: [],
            summary: {
                activeResourceClasses: [],
                queued: 0,
                running: 0,
                workerCapacity: 1,
                workerCount: 1,
                workerOnline: true,
            },
        });
        expect(
            runJob.result.current.mutateAsync({
                id: "job-1",
            })
        ).resolves.toEqual(
            expect.objectContaining({
                isOk: true,
            })
        );
        expect(
            runJob.queryClient.getQueryState(jobExecutionKeys.list())?.isInvalidated
        ).toBe(true);
        const kopia = renderHookWithQueryClient(() => useKopiaBackup());
        await waitFor(() => expect(kopia.result.current.data?.job?.id).toBe("kopia-1"));
        const walg = renderHookWithQueryClient(() => useWalgBackup());
        await waitFor(() => expect(walg.result.current.data?.job).toBeUndefined());
        const runKopia = renderHookWithQueryClient(() => useRunKopiaBackup());
        runKopia.queryClient.setQueryData(scheduledJobKeys.list(), {
            jobs: [],
        });
        runKopia.queryClient.setQueryData(scheduledJobKeys.runs("backup.kopia"), {
            runs: [],
        });
        expect(runKopia.result.current.mutateAsync()).resolves.toEqual(
            expect.objectContaining({
                isOk: true,
            })
        );
        expect(
            runKopia.queryClient.getQueryState(scheduledJobKeys.list())?.isInvalidated
        ).toBe(true);
        expect(
            runKopia.queryClient.getQueryState(scheduledJobKeys.runs("backup.kopia"))
                ?.isInvalidated
        ).toBe(true);
        const pullRequests = renderHookWithQueryClient(() => usePullRequests());
        await waitFor(() =>
            expect(pullRequests.result.current.data?.[0]?.number).toBe(189)
        );
        const deployments = renderHookWithQueryClient(() => useDashboardDeployments());
        await waitFor(() =>
            expect(deployments.result.current.data?.[0]?.id).toBe("deploy-1")
        );
        const production = renderHookWithQueryClient(() => useProductionCheckout());
        await waitFor(() =>
            expect(production.result.current.data?.isSafeForDeploy).toBe(true)
        );
        const releases = renderHookWithQueryClient(() => useDashboardReleaseStatus());
        await waitFor(() =>
            expect(releases.result.current.data?.previous?.commitSha).toBe("b".repeat(40))
        );
        const preview = renderHookWithQueryClient(() => usePullRequestPreview());
        await waitFor(() =>
            expect(preview.result.current.data).toMatchObject({
                number: 189,
                status: "running",
            })
        );
    });
    it("fetches health and metrics through dashboard hooks", async () => {
        const fetchMock = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
            return Promise.try(() => {
                const url = requestUrl(input);
                const method = init?.method ?? "GET";
                if (url === "/api/health/diagnostics" && method === "GET") {
                    return Response.json(
                        dashboardDiagnostics({
                            backendCommit: "abc123",
                            frontendCommit: "abc123",
                            sessionCount: 2,
                        })
                    );
                }
                if (url === "/api/metrics" && method === "GET") {
                    return Response.json(dashboardMetrics());
                }
                throw new Error(`Unexpected health API call: ${method} ${url}`);
            });
        });
        Object.defineProperty(globalThis, "fetch", {
            configurable: true,
            value: fetchMock,
            writable: true,
        });
        const health = renderHookWithQueryClient(() => useHealth());
        await waitFor(() => expect(health.result.current.data?.status).toBe("isReady"));
        const metrics = renderHookWithQueryClient(() => useMetrics());
        await waitFor(() => expect(metrics.result.current.data?.tokens.total).toBe(42));
    });
    it("fetches and refreshes cache-backed dashboard data through hooks", async () => {
        const fetchMock = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
            return Promise.try(() => {
                const url = requestUrl(input);
                const method = init?.method ?? "GET";
                if (url === "/api/cache/heartbeat" && method === "GET") {
                    return Response.json({
                        count: 1,
                        entries: [
                            cacheEnvelopeFixture(
                                "weather.spydeberg",
                                {
                                    location: "Spydeberg",
                                },
                                {
                                    source: "weather",
                                }
                            ),
                        ],
                        cronJobs: {
                            dataAvailable: true,
                            items: [],
                        },
                        dashboardJobs: [],
                        generatedAt: "2026-06-23T08:00:00.000Z",
                        schemaVersion: 3,
                        tasks: [],
                    });
                }
                if (url === "/api/cache/status" && method === "GET") {
                    return Response.json({
                        generatedAt: "2026-06-23T08:00:00.000Z",
                        count: 1,
                        entries: [
                            cacheEnvelopeFixture("weather.spydeberg", null, {
                                expiresAt: "2026-06-23T09:00:00.000Z",
                                source: "weather",
                            }),
                        ],
                    });
                }
                if (url === "/api/cache/weather.spydeberg" && method === "GET") {
                    return Response.json(
                        cacheEnvelopeFixture(
                            "weather.spydeberg",
                            {
                                location: "Spydeberg",
                                temperatureC: 20,
                                description: "Clear",
                                forecast: [],
                                fetchedAt: "2026-06-23T08:00:00.000Z",
                            },
                            {
                                source: "weather",
                            }
                        )
                    );
                }
                if (url === "/api/cache/quotas.summary" && method === "GET") {
                    return Response.json(
                        cacheEnvelopeFixture(
                            "quotas.summary",
                            {
                                checkedAt: 123,
                                cacheAgeMs: 100,
                                openrouter: {
                                    usage: 1,
                                    totalCredits: 10,
                                    remaining: 9,
                                    limit: 10,
                                    limitRemaining: 9,
                                    limitReset: "monthly",
                                    usageMonthly: 1,
                                    percentUsed: 10,
                                },
                                elevenlabs: {
                                    status: "not_configured",
                                },
                                synthetic: {
                                    status: "error",
                                    note: "offline",
                                },
                                openai: {
                                    fiveHourLeftPercent: 90,
                                    weeklyLeftPercent: 80,
                                    percentUsed: 10,
                                },
                            },
                            {
                                source: "quota",
                            }
                        )
                    );
                }
                if (url === "/api/cache/moltbook.home" && method === "GET") {
                    return Response.json(
                        cacheEnvelopeFixture(
                            "moltbook.home",
                            {
                                pendingRequestCount: 1,
                                unreadMessageCount: 2,
                                activityOnYourPostsCount: 0,
                                activityOnYourPosts: [],
                                postsFromAccountsYouFollowCount: 1,
                                exploreCount: 1,
                                nextActions: ["reply"],
                                fetchedAt: "2026-06-23T08:00:00.000Z",
                            },
                            {
                                source: "moltbook",
                            }
                        )
                    );
                }
                if (url === "/api/cache/moltbook.feed.hot" && method === "GET") {
                    return Response.json(
                        cacheEnvelopeFixture(
                            "moltbook.feed.hot",
                            {
                                hasMore: false,
                                posts: [
                                    {
                                        post_id: "post-1",
                                        title: "Hello",
                                        content_preview: "Preview",
                                        author_name: "mira",
                                        upvotes: 3,
                                        downvotes: 0,
                                        comment_count: 1,
                                        created_at: "2026-06-23T08:00:00.000Z",
                                        submolt_name: "agents",
                                    },
                                ],
                            },
                            {
                                source: "moltbook",
                            }
                        )
                    );
                }
                if (url === "/api/cache/moltbook.feed.new" && method === "GET") {
                    return Response.json(
                        cacheEnvelopeFixture(
                            "moltbook.feed.new",
                            {
                                hasMore: false,
                                posts: [
                                    {
                                        id: "post-2",
                                        title: "Nested author",
                                        content: "Full post",
                                        author: {
                                            name: "raymond",
                                            display_name: "Raymond",
                                            avatar_url: null,
                                        },
                                        created_at: "2026-06-23T08:30:00.000Z",
                                        submolt_name: "dashboard",
                                        you_follow_author: true,
                                    },
                                ],
                            },
                            {
                                source: "moltbook",
                            }
                        )
                    );
                }
                if (url === "/api/cache/moltbook.profile" && method === "GET") {
                    return Response.json(
                        cacheEnvelopeFixture(
                            "moltbook.profile",
                            {
                                agent: {
                                    comments_count: 0,
                                    description: "Dashboard agent",
                                    display_name: "Mira",
                                    follower_count: 0,
                                    following_count: 0,
                                    karma: 0,
                                    name: "Mira",
                                    posts_count: 0,
                                },
                            },
                            {
                                source: "moltbook",
                            }
                        )
                    );
                }
                if (url === "/api/cache/moltbook.my-content" && method === "GET") {
                    return Response.json(
                        cacheEnvelopeFixture(
                            "moltbook.my-content",
                            {
                                posts: [],
                                comments: [],
                            },
                            {
                                source: "moltbook",
                            }
                        )
                    );
                }
                if (url === "/api/cache/weather.spydeberg/refresh" && method === "POST") {
                    return Response.json({
                        isOk: true,
                        entry: cacheEnvelopeFixture(
                            "weather.spydeberg",
                            {
                                location: "Spydeberg",
                            },
                            {
                                source: "weather",
                            }
                        ),
                    });
                }
                throw new Error(`Unexpected cache API call: ${method} ${url}`);
            });
        });
        Object.defineProperty(globalThis, "fetch", {
            configurable: true,
            value: fetchMock,
            writable: true,
        });
        const cacheHeartbeat = renderHookWithQueryClient(() => useCacheHeartbeat());
        await waitFor(() => expect(cacheHeartbeat.result.current.data?.count).toBe(1));
        expect(cacheHeartbeat.result.current.data?.entries[0]?.data).toEqual({
            location: "Spydeberg",
        });
        const cacheStatus = renderHookWithQueryClient(() => useCacheStatus());
        await waitFor(() => expect(cacheStatus.result.current.data?.count).toBe(1));
        expect(cacheStatus.result.current.data?.entries[0]?.data).toBeNull();
        const weatherEntry = renderHookWithQueryClient(() =>
            useCacheEntry("weather.spydeberg", parseWeatherData)
        );
        await waitFor(() =>
            expect(weatherEntry.result.current.data?.data.location).toBe("Spydeberg")
        );
        const weather = renderHookWithQueryClient(() => useWeather());
        await waitFor(() =>
            expect(weather.result.current.data?.location).toBe("Spydeberg")
        );
        const quotas = renderHookWithQueryClient(() => useQuotas());
        await waitFor(() =>
            expect(quotas.result.current.data?.openrouter).toMatchObject({
                remaining: 9,
            })
        );
        const moltbook = renderHookWithQueryClient(() => useMoltbookData("hot"));
        await waitFor(() => expect(moltbook.result.current.posts[0]?.id).toBe("post-1"));
        await waitFor(() => expect(moltbook.result.current.profile?.name).toBe("Mira"));
        await act(async () => {
            await moltbook.result.current.refetch();
        });
        await waitFor(() =>
            expect(fetchMock).toHaveBeenCalledWith(
                "/api/cache/moltbook.home",
                expect.objectContaining({
                    credentials: "include",
                })
            )
        );
        const newestMoltbook = renderHookWithQueryClient(() => useMoltbookData("new"));
        await waitFor(() =>
            expect(newestMoltbook.result.current.posts[0]).toMatchObject({
                id: "post-2",
                content: "Full post",
                author: {
                    name: "raymond",
                    display_name: "Raymond",
                    avatar_url: undefined,
                },
                upvotes: 0,
                you_follow_author: true,
            })
        );
        const refreshCache = renderHookWithQueryClient(() => useRefreshCacheEntry());
        refreshCache.queryClient.setQueryData(scheduledJobKeys.list(), {
            jobs: [],
        });
        expect(
            refreshCache.result.current.mutateAsync(" weather.spydeberg ,, ")
        ).resolves.toMatchObject({
            keys: ["weather.spydeberg"],
        });
        expect(
            refreshCache.queryClient.getQueryState(scheduledJobKeys.list())?.isInvalidated
        ).toBe(true);
    });
    it("attempts every requested cache refresh and retains partial successes", () => {
        const originalFetch = fetch;
        const fetchMock = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
            return Promise.try(() => {
                const url = requestUrl(input);
                if (init?.method !== "POST") {
                    throw new Error(`Unexpected cache API call: ${init?.method} ${url}`);
                }
                if (url === "/api/cache/cache.fail/refresh") {
                    return Response.json(
                        {
                            error: {
                                code: "internal_error",
                                message: "refresh failed",
                                requestId: "cache-refresh-failed",
                            },
                        },
                        {
                            status: 500,
                        }
                    );
                }
                const key = url.replace("/api/cache/", "").replace("/refresh", "");
                return Response.json({
                    entry: cacheEnvelopeFixture(
                        key,
                        {
                            key,
                        },
                        {
                            source: "test",
                        }
                    ),
                    isOk: true,
                });
            });
        });
        Object.defineProperty(globalThis, "fetch", {
            configurable: true,
            value: fetchMock,
            writable: true,
        });
        try {
            const refreshCache = renderHookWithQueryClient(() => useRefreshCacheEntry());
            expect(
                refreshCache.result.current.mutateAsync(
                    "cache.first,cache.fail,cache.last"
                )
            ).rejects.toThrow("refresh failed");
            expect(fetchMock.mock.calls.map(([input]) => requestUrl(input))).toEqual([
                "/api/cache/cache.first/refresh",
                "/api/cache/cache.fail/refresh",
                "/api/cache/cache.last/refresh",
            ]);
            expect(
                refreshCache.queryClient.getQueryData(cacheKeys.entry("cache.first"))
            ).toMatchObject({
                key: "cache.first",
            });
            expect(
                refreshCache.queryClient.getQueryData(cacheKeys.entry("cache.last"))
            ).toMatchObject({
                key: "cache.last",
            });
        } finally {
            Object.defineProperty(globalThis, "fetch", {
                configurable: true,
                value: originalFetch,
                writable: true,
            });
        }
    });
    it("refreshes the execution queue before dashboard job requests settle", async () => {
        const originalFetch = fetch;
        const cacheResponse = Promise.withResolvers<Response>();
        const backupResponse = Promise.withResolvers<Response>();
        const scheduledResponse = Promise.withResolvers<Response>();
        const actionResponse = Promise.withResolvers<Response>();
        const fetchMock = jest.fn(
            (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
                const url = requestUrl(input);
                const method = init?.method ?? "GET";
                if (method !== "POST") {
                    throw new Error(
                        `Unexpected queue refresh API call: ${method} ${url}`
                    );
                }
                if (url === "/api/cache/quotas.summary/refresh") {
                    return cacheResponse.promise;
                }
                if (url === "/api/backups/kopia/run") {
                    return backupResponse.promise;
                }
                if (url === "/api/jobs/ops.log-rotation/run") {
                    return scheduledResponse.promise;
                }
                if (url === "/api/exec/start") {
                    return actionResponse.promise;
                }
                throw new Error(`Unexpected queue refresh API call: ${method} ${url}`);
            }
        );
        Object.defineProperty(globalThis, "fetch", {
            configurable: true,
            value: fetchMock,
            writable: true,
        });
        try {
            const cache = renderHookWithQueryClient(() => useRefreshCacheEntry());
            const cacheInvalidations = jest.spyOn(cache.queryClient, "invalidateQueries");
            let cacheRequest!: Promise<unknown>;
            act(() => {
                cacheRequest = cache.result.current.mutateAsync("quotas.summary");
            });
            await waitFor(() =>
                expect(fetchMock).toHaveBeenCalledWith(
                    "/api/cache/quotas.summary/refresh",
                    expect.objectContaining({
                        method: "POST",
                    })
                )
            );
            expect(cacheInvalidations).toHaveBeenCalledWith({
                queryKey: jobExecutionKeys.all,
            });
            cacheResponse.resolve(
                Response.json({
                    entry: cacheEnvelopeFixture("quotas.summary", {}),
                    isOk: true,
                })
            );
            await act(async () => {
                await cacheRequest;
            });
            cache.unmount();
            cache.queryClient.clear();
            const backup = renderHookWithQueryClient(() => useRunKopiaBackup());
            const backupInvalidations = jest.spyOn(
                backup.queryClient,
                "invalidateQueries"
            );
            let backupRequest!: Promise<unknown>;
            act(() => {
                backupRequest = backup.result.current.mutateAsync();
            });
            await waitFor(() =>
                expect(fetchMock).toHaveBeenCalledWith(
                    "/api/backups/kopia/run",
                    expect.objectContaining({
                        method: "POST",
                    })
                )
            );
            expect(backupInvalidations).toHaveBeenCalledWith({
                queryKey: jobExecutionKeys.all,
            });
            backupResponse.resolve(
                Response.json({
                    isOk: true,
                    job: {
                        id: "backup-1",
                        startedAt: 1,
                        status: "running",
                        stderr: "",
                        stdout: "",
                        type: "kopia",
                    },
                })
            );
            await act(async () => {
                await backupRequest;
            });
            backup.unmount();
            backup.queryClient.clear();
            const scheduled = renderHookWithQueryClient(() => useRunScheduledJobNow());
            const scheduledInvalidations = jest.spyOn(
                scheduled.queryClient,
                "invalidateQueries"
            );
            let scheduledRequest!: Promise<unknown>;
            act(() => {
                scheduledRequest = scheduled.result.current.mutateAsync({
                    id: "ops.log-rotation",
                });
            });
            await waitFor(() =>
                expect(fetchMock).toHaveBeenCalledWith(
                    "/api/jobs/ops.log-rotation/run",
                    expect.objectContaining({
                        method: "POST",
                    })
                )
            );
            expect(scheduledInvalidations).toHaveBeenCalledWith({
                queryKey: jobExecutionKeys.all,
            });
            scheduledResponse.resolve(
                Response.json({
                    isOk: true,
                    run: {
                        cancellable: true,
                        id: 1,
                        jobId: "ops.log-rotation",
                        output: {},
                        queuedAt: "2026-06-23T08:00:00.000Z",
                        resourceClass: "light",
                        startedAt: "2026-06-23T08:00:00.000Z",
                        status: "queued",
                        triggerType: "manual",
                    },
                })
            );
            await act(async () => {
                await scheduledRequest;
            });
            scheduled.unmount();
            scheduled.queryClient.clear();
            const action = renderHookWithQueryClient(() => useStartOpsAction());
            const actionInvalidations = jest.spyOn(
                action.queryClient,
                "invalidateQueries"
            );
            let actionRequest!: Promise<unknown>;
            act(() => {
                actionRequest = action.result.current.mutateAsync(OPS_ACTIONS[0]!);
            });
            await waitFor(() =>
                expect(fetchMock).toHaveBeenCalledWith(
                    "/api/exec/start",
                    expect.objectContaining({
                        method: "POST",
                    })
                )
            );
            expect(actionInvalidations).toHaveBeenCalledWith({
                queryKey: jobExecutionKeys.all,
            });
            actionResponse.resolve(
                Response.json({
                    jobId: "action-1",
                })
            );
            await act(async () => {
                await actionRequest;
            });
            action.unmount();
            action.queryClient.clear();
        } finally {
            Object.defineProperty(globalThis, "fetch", {
                configurable: true,
                value: originalFetch,
                writable: true,
            });
        }
    });
    it("refreshes the execution queue again while a job request remains pending", async () => {
        jest.useFakeTimers();
        const queryClient = new QueryClient();
        const invalidations = jest.spyOn(queryClient, "invalidateQueries");
        const request = Promise.withResolvers<void>();
        try {
            const trackedRequest = refreshJobExecutionQueueWhilePending(
                queryClient,
                request.promise
            );
            expect(invalidations).toHaveBeenCalledTimes(1);
            jest.advanceTimersByTime(500);
            expect(invalidations).toHaveBeenCalledTimes(2);
            request.resolve();
            await trackedRequest;
        } finally {
            jest.useRealTimers();
            queryClient.clear();
        }
    });
    it("clears cached Docker stats once live containers report no stats", async () => {
        const fetchMock = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
            return Promise.try(() => {
                const url = requestUrl(input);
                const method = init?.method || "GET";
                if (url === "/api/cache/docker.summary" && method === "GET") {
                    return Response.json({
                        key: "docker.summary",
                        source: "docker",
                        status: "fresh",
                        consecutiveFailures: 0,
                        data: {
                            checkedAt: "2026-07-09T18:00:00.000Z",
                            containers: [
                                {
                                    command: "server",
                                    createdAt: "2026-07-09T17:00:00.000Z",
                                    finishedAt: undefined,
                                    health: "unknown",
                                    id: "stopped123",
                                    image: "app:latest",
                                    imageId: "sha256:image",
                                    ipAddresses: {},
                                    mounts: [],
                                    name: "stopped-app",
                                    ports: [],
                                    project: undefined,
                                    restartCount: 0,
                                    runningFor: "1 hour",
                                    service: undefined,
                                    startedAt: "2026-07-09T17:00:00.000Z",
                                    state: "exited",
                                    stats: {
                                        blockIO: "0 B / 0 B",
                                        cpu: "12.3%",
                                        memory: "128 MiB / 1 GiB",
                                        memoryPercent: "12%",
                                        netIO: "0 B / 0 B",
                                        pids: "1",
                                    },
                                    status: "Exited",
                                },
                            ],
                            images: [],
                            updaterEvents: [],
                            updaterServices: [],
                            updaterSummary: {
                                autoPolicy: 0,
                                enabled: 0,
                                failed: 0,
                                notifyPolicy: 0,
                                total: 0,
                                updateAvailable: 0,
                            },
                            volumes: [],
                        },
                        meta: {},
                    });
                }
                if (url === "/api/docker/containers" && method === "GET") {
                    return Response.json({
                        containers: [
                            {
                                command: "server",
                                createdAt: "2026-07-09T17:00:00.000Z",
                                finishedAt: undefined,
                                health: "unknown",
                                id: "stopped123",
                                image: "app:latest",
                                imageId: "sha256:image",
                                ipAddresses: {},
                                mounts: [],
                                name: "stopped-app",
                                ports: [],
                                project: undefined,
                                restartCount: 0,
                                runningFor: "1 hour",
                                service: undefined,
                                startedAt: "2026-07-09T17:00:00.000Z",
                                state: "exited",
                                stats: undefined,
                                status: "Exited",
                            },
                        ],
                        mode: "live",
                    });
                }
                throw new Error(`Unexpected Docker hook API call: ${method} ${url}`);
            });
        });
        Object.defineProperty(globalThis, "fetch", {
            configurable: true,
            value: fetchMock,
            writable: true,
        });
        const containers = renderHookWithQueryClient(() => useDockerContainers());
        await waitFor(() => expect(containers.result.current.data).toHaveLength(1));
        await waitFor(() =>
            expect(containers.result.current.data?.[0]?.stats).toBeUndefined()
        );
    });
    it("fetches and mutates cron jobs through hooks", async () => {
        const fetchMock = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
            return Promise.try(() => {
                const url = requestUrl(input);
                const method = init?.method ?? "GET";
                if (url === "/api/cron/jobs" && method === "GET") {
                    return Response.json({
                        jobs: [
                            {
                                id: "cron-1",
                                name: "Cron One",
                                enabled: true,
                            },
                        ],
                    });
                }
                if (url === "/api/cron/jobs/cron-1/toggle" && method === "POST") {
                    expect(JSON.parse(requestBodyText(init?.body))).toEqual({
                        enabled: false,
                        disableIntent: {
                            mode: "indefinite",
                            comment: "Paused for hook coverage",
                        },
                    });
                    return Response.json({
                        isOk: true,
                    });
                }
                if (url === "/api/cron/jobs/cron-1/update" && method === "POST") {
                    expect(JSON.parse(requestBodyText(init?.body))).toEqual({
                        patch: {
                            schedule: {
                                kind: "interval",
                                every: "5m",
                            },
                        },
                    });
                    return Response.json({
                        isOk: true,
                    });
                }
                if (url === "/api/cron/jobs/cron-1/run" && method === "POST") {
                    return Response.json({
                        isOk: true,
                    });
                }
                if (
                    url === "/api/cron/jobs/victim%2Fdelete%3F/run" &&
                    method === "POST"
                ) {
                    return Response.json({
                        isOk: true,
                    });
                }
                if (url === "/api/cron/jobs/cron-1/delete" && method === "POST") {
                    return Response.json({
                        isOk: true,
                    });
                }
                throw new Error(`Unexpected cron API call: ${method} ${url}`);
            });
        });
        Object.defineProperty(globalThis, "fetch", {
            configurable: true,
            value: fetchMock,
            writable: true,
        });
        const cronJobs = renderHookWithQueryClient(() => useCronJobs());
        await waitFor(() => expect(cronJobs.result.current.data?.[0]?.id).toBe("cron-1"));
        const toggleCron = renderHookWithQueryClient(() => useToggleCronJob());
        await toggleCron.result.current.mutateAsync({
            id: "cron-1",
            enabled: false,
            disableIntent: {
                mode: "indefinite",
                comment: "Paused for hook coverage",
            },
        });
        const updateCron = renderHookWithQueryClient(() => useUpdateCronJob());
        await updateCron.result.current.mutateAsync({
            id: "cron-1",
            patch: {
                schedule: {
                    kind: "interval",
                    every: "5m",
                },
            },
        });
        const runCron = renderHookWithQueryClient(() => useRunCronJobNow());
        await runCron.result.current.mutateAsync({
            id: "cron-1",
        });
        await runCron.result.current.mutateAsync({
            id: "victim/delete?",
        });
        const deleteCron = renderHookWithQueryClient(() => useDeleteCronJob());
        await deleteCron.result.current.mutateAsync({
            id: "cron-1",
        });
    });
    it("fetches and mutates config, skills, and service operations through hooks", async () => {
        const fetchMock = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
            return Promise.try(() => {
                const url = requestUrl(input);
                const method = init?.method ?? "GET";
                if (url === "/api/config" && method === "GET") {
                    return Response.json({
                        __hash: "hash-1",
                        agents: {
                            defaults: {
                                model: {
                                    primary: "codex",
                                },
                            },
                        },
                    });
                }
                if (url === "/api/config" && method === "PUT") {
                    expect(JSON.parse(requestBodyText(init?.body))).toEqual({
                        __hash: "hash-1",
                        agents: {
                            defaults: {
                                model: {
                                    primary: "codex",
                                },
                            },
                        },
                    });
                    return Response.json({
                        isOk: true,
                        result: {
                            hash: "hash-2",
                        },
                    });
                }
                if (url === "/api/skills" && method === "GET") {
                    return Response.json({
                        skills: [
                            {
                                name: "weather",
                                path: "skills.entries.weather",
                                enabled: true,
                                source: "workspace",
                            },
                        ],
                    });
                }
                if (url === "/api/skills/weather" && method === "POST") {
                    expect(JSON.parse(requestBodyText(init?.body))).toEqual({
                        __hash: "hash-1",
                        enabled: false,
                    });
                    return Response.json({
                        isOk: true,
                    });
                }
                if (url === "/api/backup" && method === "POST") {
                    return Response.json({
                        createdAt: "2026-06-23T08:00:00.000Z",
                        hash: "hash-1",
                        config: {
                            agents: {},
                        },
                    });
                }
                if (url === "/api/restart" && method === "POST") {
                    return Response.json({
                        isOk: true,
                    });
                }
                throw new Error(`Unexpected config API call: ${method} ${url}`);
            });
        });
        Object.defineProperty(globalThis, "fetch", {
            configurable: true,
            value: fetchMock,
            writable: true,
        });
        const config = renderHookWithQueryClient(() => useConfig());
        await waitFor(() => expect(config.result.current.data?.__hash).toBe("hash-1"));
        const skills = renderHookWithQueryClient(() => useSkills());
        await waitFor(() =>
            expect(skills.result.current.data?.[0]?.name).toBe("weather")
        );
        const toggleSkill = renderHookWithQueryClient(() => useToggleSkill());
        toggleSkill.queryClient.setQueryData(["config"], {
            __hash: "hash-1",
        });
        await toggleSkill.result.current.mutateAsync({
            name: "weather",
            enabled: false,
        });
        const updateConfig = renderHookWithQueryClient(() => useUpdateConfig());
        await updateConfig.result.current.mutateAsync({
            __hash: "hash-1",
            agents: {
                defaults: {
                    model: {
                        primary: "codex",
                    },
                },
            },
        });
        expect(
            updateConfig.queryClient.getQueryData<{
                __hash?: string;
            }>(["config"])?.__hash
        ).toBe("hash-2");
        const restartGateway = renderHookWithQueryClient(() => useRestartGateway());
        expect(restartGateway.result.current.mutateAsync()).resolves.toBeUndefined();
        const backup = renderHookWithQueryClient(() => useCreateBackup());
        expect(backup.result.current.mutateAsync()).resolves.toMatchObject({
            hash: "hash-1",
        });
    });
    it("preserves cached nested config when update response only returns a hash", async () => {
        const fetchMock = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
            return Promise.try(() => {
                const url = requestUrl(input);
                const method = init?.method ?? "GET";
                if (url === "/api/config" && method === "GET") {
                    return Response.json({
                        __hash: "hash-1",
                        agents: {
                            defaults: {
                                model: {
                                    primary: "codex",
                                },
                            },
                            list: [
                                {
                                    id: "ops",
                                    name: "Ops",
                                },
                            ],
                        },
                    });
                }
                if (url === "/api/config" && method === "PUT") {
                    return Response.json({
                        isOk: true,
                        result: {
                            hash: "hash-2",
                        },
                    });
                }
                throw new Error(`Unexpected config API call: ${method} ${url}`);
            });
        });
        Object.defineProperty(globalThis, "fetch", {
            configurable: true,
            value: fetchMock,
            writable: true,
        });
        const updateConfig = renderHookWithQueryClient(() => useUpdateConfig());
        updateConfig.queryClient.setQueryData<OpenClawConfig>(["config"], {
            __hash: "hash-1",
            agents: {
                defaults: {
                    model: {
                        primary: "codex",
                    },
                },
                list: [
                    {
                        id: "ops",
                        name: "Ops",
                    },
                ],
            },
        });
        await updateConfig.result.current.mutateAsync({
            agents: {
                defaults: {
                    model: {
                        primary: "gpt-5.5",
                    },
                },
            },
        });
        expect(
            updateConfig.queryClient.getQueryData<OpenClawConfig>(["config"])
        ).toMatchObject({
            __hash: "hash-2",
            agents: {
                defaults: {
                    model: {
                        primary: "codex",
                    },
                },
                list: [
                    {
                        id: "ops",
                        name: "Ops",
                    },
                ],
            },
        });
    });
    it("keeps stale database overview data while mutating sessions through hooks", async () => {
        const fetchMock = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
            return Promise.try(() => {
                const url = requestUrl(input);
                const method = init?.method ?? "GET";
                if (url === "/api/cache/database.summary" && method === "GET") {
                    return Response.json(
                        cacheEnvelopeFixture(
                            "database.summary",
                            databaseOverviewFixture(),
                            {
                                status: "stale",
                            }
                        )
                    );
                }
                if (url === "/api/sessions/session-1/action" && method === "POST") {
                    expect(JSON.parse(requestBodyText(init?.body))).toEqual({
                        action: "compact",
                    });
                    return Response.json({
                        action: "compact",
                        isSuccess: true,
                    });
                }
                if (url === "/api/sessions/session-1" && method === "DELETE") {
                    return Response.json({
                        isSuccess: true,
                        result: {},
                    });
                }
                throw new Error(`Unexpected database/session API call: ${method} ${url}`);
            });
        });
        Object.defineProperty(globalThis, "fetch", {
            configurable: true,
            value: fetchMock,
            writable: true,
        });
        const database = renderHookWithQueryClient(() => useDatabaseOverview());
        await waitFor(() =>
            expect(database.result.current.data?.overview.totalBackends).toBe(2)
        );
        const sessionAction = renderHookWithQueryClient(() => useSessionAction());
        await sessionAction.result.current.mutateAsync({
            key: "session-1",
            action: "compact",
        });
        const deleteSession = renderHookWithQueryClient(() => useDeleteSession());
        await deleteSession.result.current.mutateAsync("session-1");
    });
    it("rejects invalid database summary cache payloads", async () => {
        Object.defineProperty(globalThis, "fetch", {
            configurable: true,
            value: jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
                return Promise.try(() => {
                    const url = requestUrl(input);
                    const method = init?.method ?? "GET";
                    if (url === "/api/cache/database.summary" && method === "GET") {
                        return Response.json(
                            cacheEnvelopeFixture("database.summary", "", {
                                errorCode: "invalid_payload",
                                errorMessage: "Invalid database summary",
                                status: "error",
                            })
                        );
                    }
                    if (
                        url === "/api/cache/database.summary/refresh" &&
                        method === "POST"
                    ) {
                        return Response.json(
                            {
                                error: {
                                    code: "invalid_payload",
                                    message: "Invalid database summary",
                                    requestId: "invalid-database-summary",
                                },
                            },
                            {
                                status: 502,
                            }
                        );
                    }
                    throw new Error(`Unexpected database API call: ${method} ${url}`);
                });
            }),
            writable: true,
        });
        const database = renderHookWithQueryClient(() => useDatabaseOverview());
        await waitFor(() => expect(database.result.current.isError).toBe(true));
        expect(database.result.current.data).toBeUndefined();
    });
    it("keeps valid database data from an error cache envelope", async () => {
        Object.defineProperty(globalThis, "fetch", {
            configurable: true,
            value: jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
                return Promise.try(() => {
                    const url = requestUrl(input);
                    const method = init?.method ?? "GET";
                    if (url === "/api/cache/database.summary" && method === "GET") {
                        return Response.json(
                            cacheEnvelopeFixture(
                                "database.summary",
                                databaseOverviewFixture(),
                                {
                                    errorCode: "database_unavailable",
                                    errorMessage:
                                        "Database metrics temporarily unavailable",
                                    status: "error",
                                }
                            )
                        );
                    }
                    throw new Error(`Unexpected database API call: ${method} ${url}`);
                });
            }),
            writable: true,
        });
        const database = renderHookWithQueryClient(() => useDatabaseOverview());
        await waitFor(() => expect(database.result.current.isSuccess).toBe(true));
        expect(database.result.current.data?.overview.totalBackends).toBe(2);
        expect(database.result.current.error?.message).toBe(
            "Database metrics temporarily unavailable"
        );
    });
    it("runs terminal and exec operations through hooks", async () => {
        const fetchMock = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
            return Promise.try(() => {
                const url = requestUrl(input);
                const method = init?.method ?? "GET";
                if (url === "/api/exec/start" && method === "POST") {
                    const body = JSON.parse(requestBodyText(init?.body)) as {
                        args?: string[];
                        command?: string;
                        cwd?: string;
                        shell?: boolean;
                    };
                    if (body.command === "bash") {
                        expect(body).toEqual({
                            args: ["-lc", "pwd"],
                            command: "bash",
                            cwd: "/tmp",
                        });
                    } else {
                        expect(body).toMatchObject({
                            command: OPS_ACTIONS[0]!.command,
                            shell: true,
                        });
                    }
                    return Response.json({
                        jobId: "job-1",
                    });
                }
                if (url === "/api/exec/job-1" && method === "GET") {
                    return Response.json({
                        jobId: "job-1",
                        status: "done",
                        code: 0,
                        stdout: "/tmp",
                        stderr: "",
                        startedAt: 1,
                        endedAt: 2,
                    });
                }
                if (url === "/api/exec/missing-job" && method === "GET") {
                    return Response.json(
                        {
                            error: {
                                code: "not_found",
                                message: "Exec job not found",
                                requestId: "request-missing-exec-job",
                            },
                        },
                        {
                            status: 404,
                        }
                    );
                }
                if (url === "/api/terminal/complete" && method === "POST") {
                    expect(JSON.parse(requestBodyText(init?.body))).toEqual({
                        partial: "sr",
                        cwd: "/tmp",
                    });
                    return Response.json({
                        commonPrefix: "src",
                        completions: [
                            {
                                completion: "src",
                                display: "src/",
                                type: "directory",
                            },
                        ],
                    });
                }
                if (url === "/api/terminal/cd" && method === "POST") {
                    expect(JSON.parse(requestBodyText(init?.body))).toEqual({
                        path: "src",
                        cwd: "/tmp",
                    });
                    return Response.json({
                        newCwd: "/tmp/src",
                    });
                }
                if (url === "/api/exec/job-1/stop" && method === "POST") {
                    return Response.json({
                        isSuccess: true,
                        message: "Stop signal sent",
                    });
                }
                throw new Error(`Unexpected terminal API call: ${method} ${url}`);
            });
        });
        Object.defineProperty(globalThis, "fetch", {
            configurable: true,
            value: fetchMock,
            writable: true,
        });
        const terminalStart = renderHookWithQueryClient(() => useStartTerminalCommand());
        expect(
            terminalStart.result.current.mutateAsync({
                command: "pwd",
                cwd: "/tmp",
            })
        ).resolves.toEqual({
            jobId: "job-1",
        });
        const opsStart = renderHookWithQueryClient(() => useStartOpsAction());
        expect(opsStart.result.current.mutateAsync(OPS_ACTIONS[0]!)).resolves.toEqual({
            jobId: "job-1",
        });
        const opsJob = renderHookWithQueryClient(() => useExecJob("job-1"));
        await waitFor(() => expect(opsJob.result.current.data?.status).toBe("done"));
        const terminalJob = renderHookWithQueryClient(() => useTerminalJob("job-1"));
        await waitFor(() => expect(terminalJob.result.current.data?.stdout).toBe("/tmp"));
        const missingTerminalJob = renderHookWithQueryClient(() =>
            useTerminalJob("missing-job")
        );
        await waitFor(() =>
            expect(missingTerminalJob.result.current.data).toMatchObject({
                code: 1,
                jobId: "missing-job",
                status: "done",
                stderr: "Terminal job is no longer available",
            })
        );
        expect(getCompletions("sr", "/tmp")).resolves.toMatchObject({
            commonPrefix: "src",
        });
        expect(changeDirectory("src", "/tmp")).resolves.toEqual({
            newCwd: "/tmp/src",
        });
        expect(stopTerminalJob("job-1")).resolves.toBeUndefined();
        const terminalHistory = renderHookWithQueryClient(() => useTerminalHistory());
        let historyId = "";
        act(() => {
            historyId = terminalHistory.result.current.addCommand({
                command: "pwd",
                cwd: "/tmp",
                jobId: "job-1",
                status: "running",
                stdout: "",
                stderr: "",
                startedAt: 1,
            });
        });
        expect(terminalHistory.result.current.history).toHaveLength(1);
        act(() => {
            terminalHistory.result.current.updateCommand(historyId, {
                status: "done",
                stdout: "/tmp",
            });
        });
        expect(terminalHistory.result.current.history[0]).toMatchObject({
            status: "done",
            stdout: "/tmp",
        });
        act(() => {
            terminalHistory.result.current.clearHistory();
        });
        expect(terminalHistory.result.current.history).toEqual([]);
    });
    it("mutates pull request review and deploy operations through hooks", async () => {
        const fetchMock = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
            return Promise.try(() => {
                const url = requestUrl(input);
                const method = init?.method ?? "GET";
                if (url === "/api/pull-requests/189/approve" && method === "POST") {
                    expect(JSON.parse(requestBodyText(init?.body))).toEqual({
                        deploy: true,
                        expectedHeadSha: "a".repeat(40),
                        expectedStackHeads: [
                            {
                                headSha: "9".repeat(40),
                                number: 188,
                            },
                            {
                                headSha: "a".repeat(40),
                                number: 189,
                            },
                        ],
                        mergeStack: true,
                    });
                    return Response.json({
                        isOk: true,
                        message: "approved",
                    });
                }
                if (url === "/api/pull-requests/stacks" && method === "POST") {
                    expect(JSON.parse(requestBodyText(init?.body))).toEqual({
                        pullRequests: [188, 189],
                    });
                    return Response.json({
                        isOk: true,
                        message: "stack created",
                    });
                }
                if (
                    url === "/api/pull-requests/189/review-approval" &&
                    method === "POST"
                ) {
                    return Response.json({
                        isOk: true,
                        message: "review approved",
                        pullRequest: {
                            number: 189,
                            title: "Updated review",
                            url: "/pull/189",
                            headRefName: "tests",
                            baseRefName: "main",
                            author: {},
                            createdAt: "2026-06-23T08:00:00.000Z",
                            updatedAt: "2026-06-23T09:00:00.000Z",
                            isDraft: false,
                        },
                    });
                }
                if (url === "/api/pull-requests/189/update-branch" && method === "POST") {
                    return Response.json({
                        isOk: true,
                        message: "updated",
                        pullRequest: {
                            number: 189,
                            title: "Updated branch",
                            url: "/pull/189",
                            headRefName: "tests",
                            baseRefName: "main",
                            author: {},
                            createdAt: "2026-06-23T08:00:00.000Z",
                            updatedAt: "2026-06-23T09:00:00.000Z",
                            isDraft: false,
                        },
                    });
                }
                if (url === "/api/pull-requests/189/reject" && method === "POST") {
                    expect(JSON.parse(requestBodyText(init?.body))).toEqual({
                        comment: "needs work",
                    });
                    return Response.json({
                        isOk: true,
                        message: "rejected",
                    });
                }
                if (url === "/api/pull-requests/deploy" && method === "POST") {
                    return Response.json({
                        isOk: true,
                        deployment: {
                            id: "deploy-2",
                            status: "building",
                            startedAt: "2026-06-23T08:00:00.000Z",
                            updatedAt: "2026-06-23T08:00:00.000Z",
                        },
                    });
                }
                if (url === "/api/pull-requests/releases/rollback" && method === "POST") {
                    expect(JSON.parse(requestBodyText(init?.body))).toEqual({
                        targetCommit: "b".repeat(40),
                    });
                    return Response.json({
                        isOk: true,
                        deployment: {
                            id: "rollback-1",
                            status: "building",
                            startedAt: "2026-06-23T08:00:00.000Z",
                            updatedAt: "2026-06-23T08:00:00.000Z",
                        },
                    });
                }
                if (url === "/api/pull-requests/189/preview/start" && method === "POST") {
                    expect(JSON.parse(requestBodyText(init?.body))).toEqual({
                        expectedHeadSha: "a".repeat(40),
                    });
                    return Response.json({
                        isOk: true,
                        preview: {
                            number: 189,
                            status: "running",
                            url: "https://dashboard.test:5173",
                        },
                    });
                }
                if (url === "/api/pull-requests/189/preview/stop" && method === "POST") {
                    expect(JSON.parse(requestBodyText(init?.body))).toEqual({});
                    return Response.json({
                        isOk: true,
                        preview: {
                            number: 189,
                            status: "stopped",
                        },
                    });
                }
                throw new Error(`Unexpected pull request API call: ${method} ${url}`);
            });
        });
        Object.defineProperty(globalThis, "fetch", {
            configurable: true,
            value: fetchMock,
            writable: true,
        });
        const approvePullRequest = renderHookWithQueryClient(() =>
            useApprovePullRequest()
        );
        await approvePullRequest.result.current.mutateAsync({
            expectedHeadSha: "a".repeat(40),
            expectedStackHeads: [
                {
                    headSha: "9".repeat(40),
                    number: 188,
                },
                {
                    headSha: "a".repeat(40),
                    number: 189,
                },
            ],
            mergeStack: true,
            number: 189,
            willDeploy: true,
        });
        const createStack = renderHookWithQueryClient(() => useCreatePullRequestStack());
        const createStackResponse = await createStack.result.current.mutateAsync({
            pullRequests: [188, 189],
        });
        expect(createStackResponse).toMatchObject({
            message: "stack created",
        });
        const approveReview = renderHookWithQueryClient(() =>
            useApprovePullRequestReview()
        );
        expect(
            approveReview.result.current.mutateAsync({
                number: 189,
            })
        ).resolves.toMatchObject({
            message: "review approved",
        });
        const updateBranch = renderHookWithQueryClient(() =>
            useUpdatePullRequestBranch()
        );
        expect(
            updateBranch.result.current.mutateAsync({
                number: 189,
            })
        ).resolves.toMatchObject({
            message: "updated",
        });
        const rejectPullRequest = renderHookWithQueryClient(() => useRejectPullRequest());
        await rejectPullRequest.result.current.mutateAsync({
            number: 189,
            comment: "needs work",
        });
        const deploy = renderHookWithQueryClient(() => useDeployDashboard());
        expect(deploy.result.current.mutateAsync()).resolves.toMatchObject({
            deployment: {
                id: "deploy-2",
            },
        });
        const rollback = renderHookWithQueryClient(() => useRollbackDashboard());
        expect(
            rollback.result.current.mutateAsync({
                targetCommit: "b".repeat(40),
            })
        ).resolves.toMatchObject({
            deployment: {
                id: "rollback-1",
            },
        });
        const startPreview = renderHookWithQueryClient(() =>
            useStartPullRequestPreview()
        );
        expect(
            startPreview.result.current.mutateAsync({
                expectedHeadSha: "a".repeat(40),
                number: 189,
            })
        ).resolves.toMatchObject({
            number: 189,
            status: "running",
        });
        expect(
            startPreview.queryClient.getQueryData(deliveryKeys.preview())
        ).toMatchObject({
            number: 189,
            status: "running",
        });
        const stopPreview = renderHookWithQueryClient(() => useStopPullRequestPreview());
        expect(
            stopPreview.result.current.mutateAsync({
                number: 189,
            })
        ).resolves.toMatchObject({
            number: 189,
            status: "stopped",
        });
        expect(
            stopPreview.queryClient.getQueryData(deliveryKeys.preview())
        ).toMatchObject({
            number: 189,
            status: "stopped",
        });
    });
    it("drives task update, move, assignment, deletion, and progress update hooks", async () => {
        const fetchMock = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
            return Promise.try(() => {
                const url = requestUrl(input);
                const method = init?.method ?? "GET";
                if (url === "/api/tasks/1/updates" && method === "GET") {
                    return Response.json([
                        {
                            id: 7,
                            taskId: 1,
                            author: "mira-2026",
                            messageMd: "Initial update",
                            createdAt: "2026-06-23T08:00:00.000Z",
                        },
                    ]);
                }
                if (url === "/api/tasks/1" && method === "PATCH") {
                    expect(JSON.parse(requestBodyText(init?.body))).toEqual({
                        title: "Updated task",
                        automation: null,
                    });
                    return Response.json(
                        task({
                            number: 1,
                            title: "Updated task",
                        })
                    );
                }
                if (url === "/api/tasks/1/move" && method === "POST") {
                    expect(JSON.parse(requestBodyText(init?.body))).toEqual({
                        columnLabel: "done",
                    });
                    return Response.json(
                        task({
                            number: 1,
                            title: "Moved task",
                            labels: [
                                {
                                    name: "done",
                                },
                            ],
                        })
                    );
                }
                if (url === "/api/tasks/1/assign" && method === "POST") {
                    expect(JSON.parse(requestBodyText(init?.body))).toEqual({
                        assignee: "mira-2026",
                    });
                    return Response.json(
                        task({
                            number: 1,
                            title: "Assigned task",
                            assignees: [
                                {
                                    login: "mira-2026",
                                    name: "Mira",
                                },
                            ],
                        })
                    );
                }
                if (url === "/api/tasks/1" && method === "DELETE") {
                    return Response.json({
                        isOk: true,
                    });
                }
                if (url === "/api/tasks/1/updates" && method === "POST") {
                    expect(JSON.parse(requestBodyText(init?.body))).toEqual({
                        author: "mira-2026",
                        messageMd: "Progress",
                    });
                    return Response.json({
                        id: 8,
                        taskId: 1,
                        author: "mira-2026",
                        messageMd: "Progress",
                        createdAt: "2026-06-23T09:00:00.000Z",
                    });
                }
                if (url === "/api/tasks/1/updates/7" && method === "PATCH") {
                    expect(JSON.parse(requestBodyText(init?.body))).toEqual({
                        messageMd: "Edited",
                    });
                    return Response.json({
                        id: 7,
                        taskId: 1,
                        author: "rajohan",
                        messageMd: "Edited",
                        createdAt: "2026-06-23T08:00:00.000Z",
                    });
                }
                if (url === "/api/tasks/1/updates/7" && method === "DELETE") {
                    return Response.json({
                        isOk: true,
                    });
                }
                throw new Error(`Unexpected task API call: ${method} ${url}`);
            });
        });
        Object.defineProperty(globalThis, "fetch", {
            configurable: true,
            value: fetchMock,
            writable: true,
        });
        const updates = renderHookWithQueryClient(() => useTaskUpdates(1));
        await waitFor(() =>
            expect(updates.result.current.data?.[0]?.messageMd).toBe("Initial update")
        );
        const updateTask = renderHookWithQueryClient(() => useUpdateTask());
        updateTask.queryClient.setQueryData(taskKeys.list(), [
            task({
                number: 1,
                title: "Old task",
            }),
        ]);
        expect(
            updateTask.result.current.mutateAsync({
                number: 1,
                updates: {
                    title: "Updated task",
                    automation: null,
                },
            })
        ).resolves.toMatchObject({
            title: "Updated task",
        });
        const moveTask = renderHookWithQueryClient(() => useMoveTask());
        expect(
            moveTask.result.current.mutateAsync({
                number: 1,
                columnLabel: "done",
            })
        ).resolves.toMatchObject({
            title: "Moved task",
        });
        const assignTask = renderHookWithQueryClient(() => useAssignTask());
        expect(
            assignTask.result.current.mutateAsync({
                number: 1,
                assignee: "mira-2026",
            })
        ).resolves.toMatchObject({
            title: "Assigned task",
        });
        const createUpdate = renderHookWithQueryClient(() => useCreateTaskUpdate());
        const createUpdateInvalidateQueries = jest.spyOn(
            createUpdate.queryClient,
            "invalidateQueries"
        );
        expect(
            createUpdate.result.current.mutateAsync({
                taskId: 1,
                author: "mira-2026",
                messageMd: "Progress",
            })
        ).resolves.toMatchObject({
            id: 8,
            messageMd: "Progress",
        });
        expect(createUpdateInvalidateQueries).toHaveBeenCalledWith({
            queryKey: taskKeys.updates(1),
        });
        expect(createUpdateInvalidateQueries).toHaveBeenCalledWith({
            queryKey: taskKeys.list(),
        });
        const editUpdate = renderHookWithQueryClient(() => useUpdateTaskUpdate());
        const editUpdateInvalidateQueries = jest.spyOn(
            editUpdate.queryClient,
            "invalidateQueries"
        );
        expect(
            editUpdate.result.current.mutateAsync({
                taskId: 1,
                updateId: 7,
                messageMd: "Edited",
            })
        ).resolves.toMatchObject({
            author: "rajohan",
            messageMd: "Edited",
        });
        expect(editUpdateInvalidateQueries).toHaveBeenCalledWith({
            queryKey: taskKeys.updates(1),
        });
        expect(editUpdateInvalidateQueries).toHaveBeenCalledWith({
            queryKey: taskKeys.list(),
        });
        const deleteUpdate = renderHookWithQueryClient(() => useDeleteTaskUpdate());
        const deleteUpdateInvalidateQueries = jest.spyOn(
            deleteUpdate.queryClient,
            "invalidateQueries"
        );
        expect(
            deleteUpdate.result.current.mutateAsync({
                taskId: 1,
                updateId: 7,
            })
        ).resolves.toBeUndefined();
        expect(deleteUpdateInvalidateQueries).toHaveBeenCalledWith({
            queryKey: taskKeys.updates(1),
        });
        expect(deleteUpdateInvalidateQueries).toHaveBeenCalledWith({
            queryKey: taskKeys.list(),
        });
        const deleteTask = renderHookWithQueryClient(() => useDeleteTask());
        expect(
            deleteTask.result.current.mutateAsync({
                number: 1,
            })
        ).resolves.toBeUndefined();
    });
});
