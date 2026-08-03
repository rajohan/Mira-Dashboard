import { afterEach, beforeEach, describe, expect, it, jest } from "bun:test";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";

import {
    parseJsonText,
    requestBodyText,
    requestUrl,
} from "../../../../test/support/fetch";
import { DatabaseOverviewCard } from "../../components/features/dashboard/DatabaseOverviewCard";
import { DockerOverviewCard } from "../../components/features/dashboard/DockerOverviewCard";
import { ServiceActionsCard } from "../../components/features/dashboard/ServiceActionsCard";
import { DatabaseOverviewCards } from "../../components/features/database/DatabaseOverviewCards";
import { DockerContainersTable } from "../../components/features/docker/DockerContainersTable";
import {
    formatBytes,
    formatDockerMemory,
    formatFullVersionDisplay,
    formatTimestamp,
    formatUpdaterTransition,
    formatVersionDisplay,
} from "../../components/features/docker/dockerFormatters";
import { DockerImagesTable } from "../../components/features/docker/DockerImagesTable";
import { DockerVolumesTable } from "../../components/features/docker/DockerVolumesTable";
import { HeartbeatSection } from "../../components/features/settings/HeartbeatSection";
import { ModelSection } from "../../components/features/settings/ModelSection";
import { SessionSection } from "../../components/features/settings/SessionSection";
import { ToolSection } from "../../components/features/settings/ToolSection";
const originalFetch = fetch;
const originalAnimationFrame = {
    cancelAnimationFrame,
    requestAnimationFrame,
};
const animationFrameState = {
    id: 0,
    frames: new Map<number, FrameRequestCallback>(),
};
function requestAnimationFrameForTest(callback: FrameRequestCallback): number {
    const id = ++animationFrameState.id;
    animationFrameState.frames.set(id, callback);
    return id;
}
function cancelAnimationFrameForTest(handle: number): void {
    animationFrameState.frames.delete(handle);
}
beforeEach(() => {
    Object.defineProperties(globalThis, {
        requestAnimationFrame: {
            configurable: true,
            value: requestAnimationFrameForTest,
            writable: true,
        },
        cancelAnimationFrame: {
            configurable: true,
            value: cancelAnimationFrameForTest,
            writable: true,
        },
    });
});
afterEach(() => {
    Object.defineProperties(globalThis, {
        fetch: {
            configurable: true,
            value: originalFetch,
            writable: true,
        },
        requestAnimationFrame: {
            configurable: true,
            value: originalAnimationFrame.requestAnimationFrame,
            writable: true,
        },
        cancelAnimationFrame: {
            configurable: true,
            value: originalAnimationFrame.cancelAnimationFrame,
            writable: true,
        },
    });
    animationFrameState.frames.clear();
});
function renderWithQueryClient(children: ReactNode) {
    const queryClient = createQueryClient();
    return {
        ...render(
            <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
        ),
        queryClient,
    };
}
function createQueryClient() {
    return new QueryClient({
        defaultOptions: {
            mutations: {
                retry: false,
            },
            queries: {
                retry: false,
                staleTime: Infinity,
            },
        },
    });
}
describe("Dashboard Docker and cache components", () => {
    it("shows Docker cache unavailable when the cached payload is invalid", async () => {
        Object.defineProperty(globalThis, "fetch", {
            configurable: true,
            value: jest.fn(() =>
                Promise.try(() =>
                    Response.json({
                        consecutiveFailures: 1,
                        data: "",
                        key: "docker.summary",
                        meta: {},
                        source: "backend",
                        status: "error",
                    })
                )
            ),
            writable: true,
        });
        const view = renderWithQueryClient(<DockerOverviewCard />);
        expect(await screen.findByText("Docker cache unavailable.")).toBeInTheDocument();
        view.unmount();
        view.queryClient.clear();
    });
    it("shows database cache unavailable when the cached payload is invalid", async () => {
        Object.defineProperty(globalThis, "fetch", {
            configurable: true,
            value: jest.fn(() =>
                Promise.try(() =>
                    Response.json({
                        consecutiveFailures: 1,
                        data: "",
                        key: "database.summary",
                        meta: {},
                        source: "backend",
                        status: "error",
                    })
                )
            ),
            writable: true,
        });
        const view = renderWithQueryClient(<DatabaseOverviewCard />);
        expect(
            await screen.findByText("Database cache unavailable.")
        ).toBeInTheDocument();
        view.unmount();
        view.queryClient.clear();
    });
    it("shows compact database maintenance review status", async () => {
        Object.defineProperty(globalThis, "fetch", {
            configurable: true,
            value: jest.fn(() =>
                Promise.try(() =>
                    Response.json({
                        consecutiveFailures: 0,
                        data: {
                            overview: {
                                totalDatabaseSizeBytes: 10_737_418_240,
                                totalBackends: 2,
                                averageCacheHitRatio: 99,
                                connections: {},
                                pgStatStatementsEnabled: true,
                                torrentCounts: {
                                    comet: 1,
                                    bitmagnet: 2,
                                },
                                pgbouncer: {
                                    clientConnections: 2,
                                    serverConnections: 2,
                                    waitingClients: 0,
                                    maxWait: 0,
                                    avgQueryTime: 1,
                                    avgTransactionTime: 1,
                                },
                                maintenance: {
                                    status: "review",
                                    hintCount: 3,
                                    requiresBloatReview: true,
                                    isBloatAssessmentIncomplete: false,
                                    unassessedTableCount: 0,
                                    unassessedPhysicalBytes: 0,
                                    slowQueryCount: 1,
                                    highDeadTupleTableCount: 1,
                                    physicalTableBytes: 8_589_934_592,
                                    estimatedReclaimableBytes: 6_442_450_944,
                                    estimatedReclaimablePercent: 75,
                                    reviewThresholdBytes: 5_368_709_120,
                                    reviewMinimumBytes: 1_073_741_824,
                                    reviewThresholdPercent: 25,
                                },
                            },
                            databases: [],
                            deadTuples: [],
                            bloatEstimates: [],
                            checkedAt: "2026-06-24T08:00:00.000Z",
                            topQueries: [],
                            pgbouncerPools: [],
                            pgbouncerStats: [],
                            sqlite: {
                                attention: [
                                    "SQLite can reclaim 26 MB (72.2%). Consider a planned VACUUM",
                                    "Latest verified SQLite backup is older than 48 hours",
                                ],
                                backup: {
                                    count: 2,
                                    current: true,
                                    reviewAgeHours: 48,
                                },
                                databaseBytes: 37_748_736,
                                freeBytes: 27_238_400,
                                freePages: 6650,
                                freePercent: 72.2,
                                fileName: "mira-dashboard.db",
                                foreignKeysEnabled: true,
                                journalMode: "wal",
                                migrations: {
                                    applied: 4,
                                    current: true,
                                    latest: 4,
                                },
                                pageCount: 9215,
                                pageSize: 4096,
                                permissions: {
                                    secure: true,
                                },
                                shmBytes: 32_768,
                                status: "review",
                                storageBytes: 48_238_096,
                                walAutoCheckpointPages: 1000,
                                walBytes: 10_456_592,
                            },
                        },
                        errorCode: null,
                        errorMessage: null,
                        expiresAt: null,
                        key: "database.summary",
                        lastAttemptAt: null,
                        meta: {},
                        source: "backend",
                        status: "fresh",
                        updatedAt: "2026-06-24T08:00:00.000Z",
                    })
                )
            ),
            writable: true,
        });
        const view = renderWithQueryClient(<DatabaseOverviewCard />);
        expect(
            await screen.findByText(
                "PostgreSQL may reclaim ~6.0 GB (75.0%). Review table bloat and compaction options"
            )
        ).toBeInTheDocument();
        expect(
            screen.getByText(
                "1 large table exceeds the dead-tuple threshold. Review autovacuum"
            )
        ).toBeInTheDocument();
        expect(
            screen.getByText("1 query averages at least 500 ms. Review query performance")
        ).toBeInTheDocument();
        expect(screen.getByText("Dashboard SQLite")).toBeInTheDocument();
        expect(screen.getByText("4/4")).toBeInTheDocument();
        expect(
            screen.getByText(
                "SQLite can reclaim 26 MB (72.2%). Consider a planned VACUUM"
            )
        ).toBeInTheDocument();
        expect(
            screen.getByText("Latest verified SQLite backup is older than 48 hours")
        ).toBeInTheDocument();
        const databaseCard = screen.getByRole("heading", {
            name: "Database",
        }).parentElement?.parentElement;
        expect(databaseCard).not.toHaveClass("xl:col-span-2");
        const postgresqlSection = screen
            .getByRole("heading", {
                name: "PostgreSQL",
            })
            .closest("section");
        const sqliteSection = screen
            .getByRole("heading", {
                name: "Dashboard SQLite",
            })
            .closest("section");
        expect(postgresqlSection).not.toBeNull();
        expect(sqliteSection).not.toBeNull();
        expect(postgresqlSection?.nextElementSibling).toBe(sqliteSection);
        expect(sqliteSection).toHaveClass("border-t");
        const postgresqlText = postgresqlSection?.textContent ?? "";
        const sqliteText = sqliteSection?.textContent ?? "";
        expect(postgresqlText.indexOf("Size")).toBeLessThan(
            postgresqlText.indexOf("Databases")
        );
        expect(sqliteText.indexOf("Size")).toBeLessThan(sqliteText.indexOf("WAL"));
        view.unmount();
        view.queryClient.clear();
    });
    it("keeps total database size status scoped to bloat", () => {
        const overview = {
            totalDatabaseSizeBytes: 10_737_418_240,
            totalBackends: 2,
            averageCacheHitRatio: 99,
            connections: {},
            pgStatStatementsEnabled: true,
            torrentCounts: {
                comet: 1,
                bitmagnet: 2,
            },
            pgbouncer: {
                clientConnections: 2,
                serverConnections: 2,
                waitingClients: 0,
                maxWait: 0,
                avgQueryTime: 1,
                avgTransactionTime: 1,
            },
            maintenance: {
                status: "review" as const,
                hintCount: 1,
                requiresBloatReview: false,
                isBloatAssessmentIncomplete: false,
                unassessedTableCount: 0,
                unassessedPhysicalBytes: 0,
                slowQueryCount: 1,
                highDeadTupleTableCount: 0,
                physicalTableBytes: 8_589_934_592,
                estimatedReclaimableBytes: 1_048_576,
                estimatedReclaimablePercent: 0.01,
                reviewThresholdBytes: 5_368_709_120,
                reviewMinimumBytes: 1_073_741_824,
                reviewThresholdPercent: 25,
            },
        };
        const view = render(<DatabaseOverviewCards overview={overview} />);
        expect(screen.getByText("Healthy · ~1.0 MB reclaimable")).toBeInTheDocument();
        view.rerender(
            <DatabaseOverviewCards
                overview={{
                    ...overview,
                    maintenance: {
                        ...overview.maintenance,
                        isBloatAssessmentIncomplete: true,
                    },
                }}
            />
        );
        expect(screen.getByText("Bloat not assessed")).toBeInTheDocument();
        view.rerender(
            <DatabaseOverviewCards
                overview={{
                    ...overview,
                    maintenance: {
                        ...overview.maintenance,
                        isBloatAssessmentIncomplete: true,
                        requiresBloatReview: true,
                    },
                }}
            />
        );
        expect(screen.getByText("Review · ~1.0 MB reclaimable")).toBeInTheDocument();
    });
    it("drives service action confirmation, exec polling, and cache refresh", async () => {
        const fetchMock = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
            return Promise.try(() => {
                const url = requestUrl(input);
                const method = init?.method ?? "GET";
                if (url === "/api/cache/system.host" && method === "GET") {
                    return Response.json({
                        consecutiveFailures: 0,
                        data: {
                            checkedAt: "2026-06-24T08:00:00.000Z",
                            disk: {
                                percent: 40,
                                totalBytes: 100_000,
                                usedBytes: 40_000,
                            },
                            hostname: "openclaw",
                            memory: {
                                freeBytes: 60_000,
                                freeMb: 0.06,
                                totalBytes: 100_000,
                                usedBytes: 40_000,
                            },
                            platform: "linux",
                            uptimeSeconds: 3600,
                            version: {
                                checkedAt: 1_719_216_000_000,
                                current: "2026.6.1",
                                latest: "2026.6.2",
                                updateAvailable: true,
                            },
                        },
                        errorCode: null,
                        errorMessage: null,
                        expiresAt: null,
                        key: "system.host",
                        lastAttemptAt: null,
                        meta: {},
                        source: "system",
                        status: "fresh",
                        updatedAt: "2026-06-24T08:00:00.000Z",
                    });
                }
                if (url === "/api/exec/start" && method === "POST") {
                    expect(parseJsonText(requestBodyText(init?.body))).toEqual({
                        command: "$HOME/.local/bin/openclaw update --yes",
                        shell: true,
                    });
                    return Response.json({
                        jobId: "ops-job-1",
                    });
                }
                if (url === "/api/exec/ops-job-1" && method === "GET") {
                    return Response.json({
                        code: 0,
                        endedAt: 1_719_216_030_000,
                        jobId: "ops-job-1",
                        startedAt: 1_719_216_000_000,
                        status: "done",
                        stderr: "",
                        stdout: "updated openclaw",
                    });
                }
                if (url === "/api/cache/system.host/refresh" && method === "POST") {
                    return Response.json({
                        entry: {
                            consecutiveFailures: 0,
                            data: {
                                checkedAt: "2026-06-24T08:01:00.000Z",
                                disk: {
                                    percent: 40,
                                    totalBytes: 100_000,
                                    usedBytes: 40_000,
                                },
                                hostname: "openclaw",
                                memory: {
                                    freeBytes: 60_000,
                                    freeMb: 0.06,
                                    totalBytes: 100_000,
                                    usedBytes: 40_000,
                                },
                                platform: "linux",
                                uptimeSeconds: 3660,
                                version: {
                                    checkedAt: 1_719_216_060_000,
                                    current: "2026.6.2",
                                    latest: "2026.6.2",
                                    updateAvailable: false,
                                },
                            },
                            errorCode: null,
                            errorMessage: null,
                            expiresAt: null,
                            key: "system.host",
                            lastAttemptAt: null,
                            meta: {},
                            source: "system",
                            status: "fresh",
                            updatedAt: "2026-06-24T08:01:00.000Z",
                        },
                        isOk: true,
                    });
                }
                throw new Error(`Unexpected service action test fetch: ${method} ${url}`);
            });
        });
        Object.defineProperty(globalThis, "fetch", {
            configurable: true,
            value: fetchMock,
            writable: true,
        });
        const view = renderWithQueryClient(<ServiceActionsCard />);
        expect(
            await screen.findByText(
                "New OpenClaw version available (2026.6.1 -> 2026.6.2)."
            )
        ).toBeInTheDocument();
        fireEvent.click(
            screen.getByRole("button", {
                name: /update openclaw/i,
            })
        );
        expect(
            screen.getByText("Update OpenClaw to latest version now?")
        ).toBeInTheDocument();
        fireEvent.click(
            screen.getByRole("button", {
                name: /^update openclaw$/i,
            })
        );
        expect(await screen.findByText("updated openclaw")).toBeInTheDocument();
        expect(screen.getByText(/Last run: Update OpenClaw/i)).toBeInTheDocument();
        await waitFor(() => {
            expect(fetchMock).toHaveBeenCalledWith(
                "/api/cache/system.host/refresh",
                expect.objectContaining({
                    method: "POST",
                })
            );
        });
        view.unmount();
        view.queryClient.clear();
    });
    it("drives settings section forms, switches, and selectors", () => {
        const onSaveModel = jest.fn(async () => {});
        const onSaveTools = jest.fn(async () => {});
        const onSaveHeartbeat = jest.fn(async () => {});
        const onSaveSession = jest.fn(async () => {});
        render(
            <>
                <ModelSection
                    defaultModel="codex"
                    fallbacks={["glm51", "kimi"]}
                    imageModel={undefined}
                    imageGenerationModel="gpt-image"
                    onSave={onSaveModel}
                    saving={false}
                />
                <ToolSection
                    profile="full"
                    webSearchEnabled={true}
                    webSearchProvider="brave"
                    webFetchEnabled={false}
                    execSecurity="allowlist"
                    execAsk="on-miss"
                    elevatedEnabled={false}
                    agentToAgentEnabled={true}
                    sessionsVisibility="all"
                    onSave={onSaveTools}
                    saving={false}
                />
                <HeartbeatSection
                    every={1800}
                    target="main"
                    onSave={onSaveHeartbeat}
                    saving={false}
                />
                <SessionSection idleMinutes={60} onSave={onSaveSession} saving={false} />
                <ModelSection
                    defaultModel=""
                    fallbacks={[]}
                    onSave={jest.fn(async () => {})}
                    saving={true}
                />
                <ToolSection
                    webSearchEnabled={false}
                    webSearchProvider=""
                    webFetchEnabled={false}
                    execSecurity="deny"
                    execAsk="off"
                    elevatedEnabled={false}
                    agentToAgentEnabled={false}
                    onSave={jest.fn(async () => {})}
                    saving={true}
                />
            </>
        );
        for (const name of ["Model Configuration", "Tools", "Heartbeat", "Session"]) {
            expect(
                screen.getAllByRole("button", {
                    name,
                }).length
            ).toBeGreaterThan(0);
        }
        expect(onSaveModel).not.toHaveBeenCalled();
        expect(onSaveTools).not.toHaveBeenCalled();
        expect(onSaveHeartbeat).not.toHaveBeenCalled();
        expect(onSaveSession).not.toHaveBeenCalled();
    });
    it("drives docker image and volume table actions", async () => {
        const user = userEvent.setup();
        const onDeleteImage = jest.fn();
        const onPruneImages = jest.fn();
        const onDeleteVolume = jest.fn();
        const onPruneVolumes = jest.fn();
        const { rerender } = render(
            <DockerImagesTable
                images={[]}
                onDelete={onDeleteImage}
                onPruneUnused={onPruneImages}
            />
        );
        expect(screen.getByText("No images found.")).toBeInTheDocument();
        rerender(
            <DockerImagesTable
                images={[
                    {
                        containerName: "",
                        createdAt: "2026-06-24T10:00:00.000Z",
                        id: "img-unused",
                        inUseBy: [],
                        lastTagTime: "2026-06-24T10:00:00.000Z",
                        platform: "linux/amd64",
                        repository: "local/app",
                        size: 1024,
                        tag: "",
                    },
                    {
                        containerName: "api",
                        createdAt: "2026-06-24T10:00:00.000Z",
                        id: "img-used",
                        inUseBy: ["api"],
                        lastTagTime: "2026-06-24T10:00:00.000Z",
                        platform: "linux/amd64",
                        repository: "local/api",
                        size: 2048,
                        tag: "latest",
                    },
                ]}
                onDelete={onDeleteImage}
                onPruneUnused={onPruneImages}
            />
        );
        await user.click(
            screen.getByRole("button", {
                name: /remove unused/i,
            })
        );
        await user.click(
            screen.getAllByRole("button", {
                name: /delete local\/app/i,
            })[0]!
        );
        expect(onPruneImages).toHaveBeenCalledTimes(1);
        expect(onDeleteImage).toHaveBeenCalledWith("img-unused", "local/app:<none>");
        rerender(
            <DockerVolumesTable
                volumes={[]}
                onDelete={onDeleteVolume}
                onPruneUnused={onPruneVolumes}
            />
        );
        expect(screen.getByText("No volumes found.")).toBeInTheDocument();
        const longVolume =
            "dashboard_data_volume_with_a_very_long_name_for_middle_truncation";
        rerender(
            <DockerVolumesTable
                volumes={[
                    {
                        driver: "local",
                        labels: {},
                        mountpoint:
                            "/var/lib/docker/volumes/dashboard_data_volume_with_a_very_long_name/_data",
                        name: longVolume,
                        scope: "local",
                        size: "1 KiB",
                        usedBy: [],
                    },
                    {
                        driver: "local",
                        labels: {},
                        mountpoint: "/var/lib/docker/volumes/api/_data",
                        name: "api-data",
                        scope: "local",
                        size: "2 KiB",
                        usedBy: ["api"],
                    },
                ]}
                onDelete={onDeleteVolume}
                onPruneUnused={onPruneVolumes}
            />
        );
        await user.click(
            screen.getByRole("button", {
                name: /remove unused/i,
            })
        );
        await user.click(
            screen.getAllByRole("button", {
                name: new RegExp(`delete ${longVolume}`, "i"),
            })[0]!
        );
        expect(onPruneVolumes).toHaveBeenCalledTimes(1);
        expect(onDeleteVolume).toHaveBeenCalledWith(longVolume);
        expect(screen.getAllByText("Used").length).toBeGreaterThan(0);
    });
    it("drives docker container table sorting, mobile actions, and formatters", async () => {
        const user = userEvent.setup();
        const onDetails = jest.fn();
        const onLogs = jest.fn();
        const onConsole = jest.fn();
        const onRestart = jest.fn();
        const onRestartStack = jest.fn();
        expect(formatBytes(Number.NaN)).toBe("0 B");
        expect(formatBytes(1536)).toBe("1.5 KB");
        expect(formatDockerMemory()).toBe("—");
        expect(formatDockerMemory("bad")).toBe("bad");
        expect(formatDockerMemory("512 MiB / 1 GiB")).toBe("512 MB / 1.0 GB");
        expect(formatTimestamp()).toBe("—");
        expect(formatTimestamp("not-a-date")).toBe("not-a-date");
        expect(formatVersionDisplay(undefined, "sha256:abcdef1234567890")).toBe(
            "sha256:abcde"
        );
        expect(formatVersionDisplay()).toBe("—");
        expect(formatFullVersionDisplay("v1", "digest")).toBe("v1 (digest)");
        expect(formatFullVersionDisplay(undefined, "digest")).toBe("digest");
        expect(
            formatUpdaterTransition({
                fromDigest: "from-digest",
                fromTag: undefined,
                toDigest: undefined,
                toTag: "latest",
            })
        ).toBe("from-digest → latest");
        const { rerender } = render(
            <DockerContainersTable
                containers={[]}
                onConsole={onConsole}
                onDetails={onDetails}
                onLogs={onLogs}
                onRestart={onRestart}
                onRestartStack={onRestartStack}
            />
        );
        expect(screen.getByText("No containers found.")).toBeInTheDocument();
        rerender(
            <DockerContainersTable
                containers={[
                    {
                        command: "node server.js",
                        createdAt: "2026-06-24T08:00:00.000Z",
                        finishedAt: undefined,
                        health: "healthy",
                        id: "running",
                        image: "local/running:latest",
                        imageId: "image-running",
                        ipAddresses: {},
                        mounts: [],
                        name: "running-api",
                        ports: ["3100/tcp"],
                        project: "mira",
                        restartCount: 1,
                        runningFor: "2 hours",
                        service: "api",
                        startedAt: "2026-06-24T08:00:00.000Z",
                        state: "running",
                        stats: {
                            blockIO: "0 B / 0 B",
                            cpu: "12.5%",
                            memory: "256 MiB / 1 GiB",
                            memoryPercent: "25%",
                            netIO: "1 KB / 2 KB",
                            pids: "12",
                        },
                        status: "Up",
                    },
                    {
                        command: "sleep 1",
                        createdAt: "2026-06-24T07:00:00.000Z",
                        finishedAt: "2026-06-24T07:01:00.000Z",
                        health: "unhealthy",
                        id: "exited",
                        image: "local/exited:latest",
                        imageId: "image-exited",
                        ipAddresses: {},
                        mounts: [],
                        name: "exited-worker",
                        ports: [],
                        project: undefined,
                        restartCount: 3,
                        runningFor: "",
                        service: undefined,
                        startedAt: undefined,
                        state: "exited",
                        stats: {
                            blockIO: "0 B / 0 B",
                            cpu: "bad cpu",
                            memory: "bad memory",
                            memoryPercent: "bad percent",
                            netIO: "0 B / 0 B",
                            pids: "0",
                        },
                        status: "Exited",
                    },
                    {
                        command: "worker",
                        createdAt: "2026-06-24T06:00:00.000Z",
                        finishedAt: undefined,
                        health: "unknown",
                        id: "created",
                        image: "local/created:latest",
                        imageId: "image-created",
                        ipAddresses: {},
                        mounts: [],
                        name: "created-worker",
                        ports: [],
                        project: undefined,
                        restartCount: 0,
                        runningFor: "",
                        service: undefined,
                        startedAt: undefined,
                        state: "created",
                        stats: undefined,
                        status: "Created",
                    },
                ]}
                onConsole={onConsole}
                onDetails={onDetails}
                onLogs={onLogs}
                onRestart={onRestart}
                onRestartStack={onRestartStack}
            />
        );
        await user.click(
            screen.getByRole("button", {
                name: /restart stack/i,
            })
        );
        expect(onRestartStack).toHaveBeenCalledTimes(1);
        await user.click(
            screen.getByRole("button", {
                name: "State",
            })
        );
        await user.click(
            screen.getByRole("button", {
                name: "Health",
            })
        );
        await user.click(
            screen.getByRole("button", {
                name: "CPU",
            })
        );
        await user.click(
            screen.getByRole("button", {
                name: "Memory",
            })
        );
        const sortedDesktopRows = screen.getAllByRole("row").slice(1);
        expect(sortedDesktopRows.map((row) => row.textContent || "")).toEqual([
            expect.stringContaining("running-api"),
            expect.stringContaining("exited-worker"),
            expect.stringContaining("created-worker"),
        ]);
        await user.click(screen.getAllByLabelText(/show logs for running-api/i)[0]!);
        await user.click(screen.getAllByLabelText(/open console for running-api/i)[0]!);
        await user.click(screen.getAllByLabelText(/restart running-api/i)[0]!);
        expect(onLogs).toHaveBeenCalledWith("running");
        expect(onConsole).toHaveBeenCalledWith("running");
        expect(onRestart).toHaveBeenCalledWith("running");
        await user.click(screen.getByLabelText(/open details for running-api/i));
        expect(onDetails).toHaveBeenCalledWith("running");
        screen.getByLabelText(/open details for exited-worker/i).focus();
        await user.keyboard("{Escape}");
        expect(onDetails).not.toHaveBeenCalledWith("exited");
        await user.keyboard("{Enter}");
        screen.getByLabelText(/open details for created-worker/i).focus();
        await user.keyboard(" ");
        expect(onDetails).toHaveBeenCalledWith("exited");
        expect(onDetails).toHaveBeenCalledWith("created");
    });
});
