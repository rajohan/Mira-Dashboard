import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { BackupOverviewCard } from "./BackupOverviewCard";

const hooks = vi.hoisted(() => ({
    clearKopiaAttention: vi.fn(),
    clearWalgAttention: vi.fn(),
    runKopiaBackup: vi.fn(),
    runWalgBackup: vi.fn(),
    useClearKopiaBackupAttention: vi.fn(),
    useClearWalgBackupAttention: vi.fn(),
    useCacheEntry: vi.fn(),
    useKopiaBackup: vi.fn(),
    useRunKopiaBackup: vi.fn(),
    useRunWalgBackup: vi.fn(),
    useWalgBackup: vi.fn(),
}));

vi.mock("../../../hooks", () => ({
    useClearKopiaBackupAttention: hooks.useClearKopiaBackupAttention,
    useClearWalgBackupAttention: hooks.useClearWalgBackupAttention,
    useCacheEntry: hooks.useCacheEntry,
    useKopiaBackup: hooks.useKopiaBackup,
    useRunKopiaBackup: hooks.useRunKopiaBackup,
    useRunWalgBackup: hooks.useRunWalgBackup,
    useWalgBackup: hooks.useWalgBackup,
}));

function setupHooks() {
    hooks.runKopiaBackup.mockReset();
    hooks.runKopiaBackup.mockResolvedValue({});
    hooks.runWalgBackup.mockReset();
    hooks.runWalgBackup.mockResolvedValue({});
    hooks.clearKopiaAttention.mockReset();
    hooks.clearKopiaAttention.mockResolvedValue({});
    hooks.clearWalgAttention.mockReset();
    hooks.clearWalgAttention.mockResolvedValue({});
    hooks.useKopiaBackup.mockReturnValue({ data: { job: undefined } });
    hooks.useWalgBackup.mockReturnValue({ data: { job: undefined } });
    hooks.useClearKopiaBackupAttention.mockReturnValue({
        isPending: false,
        mutateAsync: hooks.clearKopiaAttention,
    });
    hooks.useClearWalgBackupAttention.mockReturnValue({
        isPending: false,
        mutateAsync: hooks.clearWalgAttention,
    });
    hooks.useRunKopiaBackup.mockReturnValue({
        isPending: false,
        mutateAsync: hooks.runKopiaBackup,
    });
    hooks.useRunWalgBackup.mockReturnValue({
        isPending: false,
        mutateAsync: hooks.runWalgBackup,
    });
    hooks.useCacheEntry.mockImplementation((key: string) => {
        if (key === "backup.walg.status") {
            return {
                data: {
                    data: {
                        backupCount: 7,
                        latest: {
                            backupName: "base_0001",
                            modified: "2026-05-10T08:30:00.000Z",
                            walFileName: "0000000100000000000000AA",
                        },
                        ok: true,
                    },
                    status: "fresh",
                },
                isLoading: false,
            };
        }

        return {
            data: {
                data: {
                    ok: false,
                    snapshotsByPath: [
                        {
                            latest: undefined,
                            path: "/source/docker",
                            snapshotCount: 2,
                            snapshots: [
                                {
                                    description: "Docker stack backup",
                                    endTime: "2026-05-10T08:00:00.000Z",
                                    errorCount: 0,
                                    fileCount: 120,
                                    id: "snap-1",
                                    ignoredErrorCount: 0,
                                    path: "/source/docker",
                                    retentionReason: ["latest"],
                                    startTime: "2026-05-10T07:59:00.000Z",
                                    totalSize: 1_048_576,
                                },
                            ],
                        },
                    ],
                    stale: [
                        { endTime: "2026-05-09T08:00:00.000Z", path: "/source/docker" },
                    ],
                },
                status: "stale",
            },
            isLoading: false,
        };
    });
}

beforeEach(() => {
    setupHooks();
});

describe("BackupOverviewCard", () => {
    it("renders Kopia and WAL-G backup status and starts backup actions", async () => {
        const user = userEvent.setup();

        render(<BackupOverviewCard />);

        expect(screen.getByText("Backups")).toBeInTheDocument();
        expect(screen.getByText("attention")).toBeInTheDocument();
        expect(screen.getByText("Sources")).toBeInTheDocument();
        expect(screen.getByText("Snapshots")).toBeInTheDocument();
        expect(screen.getByText("Docker")).toBeInTheDocument();
        expect(screen.getByText("Stale")).toBeInTheDocument();
        expect(screen.getByText("Docker stack backup")).toBeInTheDocument();
        expect(screen.getByText("latest")).toBeInTheDocument();
        expect(screen.getByText("1.0 MB")).toBeInTheDocument();
        expect(screen.getByText("base_0001")).toBeInTheDocument();
        expect(screen.getByText("0000000100000000000000AA")).toBeInTheDocument();
        expect(screen.getByText("7")).toBeInTheDocument();

        await user.click(screen.getByRole("button", { name: /Run Postgres backup/u }));
        expect(hooks.runWalgBackup).toHaveBeenCalledTimes(1);

        await user.click(screen.getByRole("button", { name: /Run filesystem backup/u }));
        expect(screen.getByText(/Start a Kopia backup now\?/u)).toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "Cancel" }));
        await waitFor(() => {
            expect(
                screen.queryByText(/Start a Kopia backup now\?/u)
            ).not.toBeInTheDocument();
        });

        await user.click(screen.getByRole("button", { name: /Run filesystem backup/u }));
        await user.click(screen.getByRole("button", { name: "Run backup" }));

        expect(hooks.runKopiaBackup).toHaveBeenCalledTimes(1);
    });

    it("shows running job output and disables matching actions", () => {
        hooks.useKopiaBackup.mockReturnValue({
            data: {
                job: {
                    startedAt: Date.now() - 30_000,
                    status: "running",
                    stdout: "kopia scanning files",
                },
            },
        });
        hooks.useWalgBackup.mockReturnValue({
            data: {
                job: {
                    startedAt: Date.now() - 45_000,
                    status: "running",
                    stdout: "walg uploading base backup",
                },
            },
        });

        const { rerender } = render(<BackupOverviewCard />);

        expect(screen.getByText("Postgres backup is running")).toBeInTheDocument();
        expect(screen.getByText("Backup is running")).toBeInTheDocument();
        expect(screen.getByText("walg uploading base backup")).toBeInTheDocument();
        expect(screen.getByText("kopia scanning files")).toBeInTheDocument();
        for (const button of screen.getAllByRole("button", { name: "Running..." })) {
            expect(button).toBeDisabled();
        }

        hooks.useKopiaBackup.mockReturnValue({
            data: {
                job: {
                    startedAt: Date.now() - 30_000,
                    status: "running",
                    stdout: "",
                },
            },
        });
        hooks.useWalgBackup.mockReturnValue({
            data: {
                job: {
                    startedAt: Date.now() - 45_000,
                    status: "running",
                    stdout: "",
                },
            },
        });
        rerender(<BackupOverviewCard />);
        expect(screen.getAllByText(/backup is running/iu).length).toBeGreaterThanOrEqual(
            2
        );
    });

    it("shows and clears backup jobs that need attention", async () => {
        const user = userEvent.setup();
        hooks.useKopiaBackup.mockReturnValue({
            data: {
                job: {
                    startedAt: Date.now() - 30_000,
                    status: "needs_attention",
                    stderr: "kopia termination was not confirmed",
                },
            },
        });
        hooks.useWalgBackup.mockReturnValue({
            data: {
                job: {
                    startedAt: Date.now() - 45_000,
                    status: "needs_attention",
                    stderr: "walg termination was not confirmed",
                },
            },
        });

        render(<BackupOverviewCard />);

        expect(screen.getByText("Postgres backup needs attention")).toBeInTheDocument();
        expect(screen.getByText("Backup needs attention")).toBeInTheDocument();
        expect(
            screen.getByText("walg termination was not confirmed")
        ).toBeInTheDocument();
        expect(
            screen.getByText("kopia termination was not confirmed")
        ).toBeInTheDocument();
        expect(
            screen.getByRole("button", { name: /Run Postgres backup/u })
        ).toBeDisabled();
        expect(
            screen.getByRole("button", { name: /Run filesystem backup/u })
        ).toBeDisabled();

        const clearButtons = screen.getAllByRole("button", { name: "Clear attention" });
        await user.click(clearButtons[0]);
        await user.click(clearButtons[1]);

        expect(hooks.clearWalgAttention).toHaveBeenCalledTimes(1);
        expect(hooks.clearKopiaAttention).toHaveBeenCalledTimes(1);
        expect(hooks.runWalgBackup).not.toHaveBeenCalled();
        expect(hooks.runKopiaBackup).not.toHaveBeenCalled();
    });

    it("disables attention clear actions while clearing", () => {
        hooks.useClearKopiaBackupAttention.mockReturnValue({
            isPending: true,
            mutateAsync: hooks.clearKopiaAttention,
        });
        hooks.useClearWalgBackupAttention.mockReturnValue({
            isPending: true,
            mutateAsync: hooks.clearWalgAttention,
        });
        hooks.useKopiaBackup.mockReturnValue({
            data: {
                job: {
                    startedAt: Date.now() - 30_000,
                    status: "needs_attention",
                    stderr: "",
                },
            },
        });
        hooks.useWalgBackup.mockReturnValue({
            data: {
                job: {
                    startedAt: Date.now() - 45_000,
                    status: "needs_attention",
                    stderr: "",
                },
            },
        });

        render(<BackupOverviewCard />);

        for (const button of screen.getAllByRole("button", {
            name: "Clear attention",
        })) {
            expect(button).toBeDisabled();
        }
        expect(
            screen.queryByText(/termination was not confirmed/u)
        ).not.toBeInTheDocument();
    });

    it("renders loading and empty states", () => {
        hooks.useCacheEntry.mockImplementation((key: string) => ({
            data:
                key === "backup.walg.status"
                    ? { data: {}, status: "missing" }
                    : undefined,
            isLoading: key === "backup.kopia.status",
        }));

        render(<BackupOverviewCard />);

        expect(screen.getByText("No Postgres backup cache data yet")).toBeInTheDocument();
        expect(screen.getByText("Loading backup status...")).toBeInTheDocument();
    });

    it("renders healthy, non-stale, and unknown backup fallbacks", () => {
        hooks.useCacheEntry.mockImplementation((key: string) => {
            if (key === "backup.walg.status") {
                return {
                    data: {
                        data: {
                            backupCount: undefined,
                            latest: {
                                backupName: undefined,
                                modified: undefined,
                                walFileName: undefined,
                            },
                            ok: false,
                        },
                        status: "fresh",
                    },
                    isLoading: false,
                };
            }

            return {
                data: {
                    data: {
                        ok: true,
                        snapshotsByPath: [
                            {
                                latest: undefined,
                                path: undefined,
                                snapshotCount: 1,
                                snapshots: [
                                    {
                                        description: undefined,
                                        endTime: "2026-05-10T10:00:00.000Z",
                                        errorCount: undefined,
                                        fileCount: undefined,
                                        id: undefined,
                                        ignoredErrorCount: undefined,
                                        path: undefined,
                                        retentionReason: ["latest"],
                                        startTime: undefined,
                                        totalSize: undefined,
                                    },
                                    {
                                        description: undefined,
                                        endTime: undefined,
                                        errorCount: undefined,
                                        fileCount: undefined,
                                        id: "snapshot-without-retention",
                                        ignoredErrorCount: undefined,
                                        path: undefined,
                                        retentionReason: [],
                                        startTime: undefined,
                                        totalSize: undefined,
                                    },
                                ],
                            },
                        ],
                        stale: [],
                    },
                    status: "fresh",
                },
                isLoading: false,
            };
        });

        render(<BackupOverviewCard />);

        expect(screen.getByText("healthy")).toBeInTheDocument();
        expect(screen.getByText("attention")).toBeInTheDocument();
        expect(screen.getByText("Unknown source")).toBeInTheDocument();
        expect(screen.getByText("1 snapshot")).toBeInTheDocument();
        expect(screen.getByText("OK")).toBeInTheDocument();
        expect(screen.getByText("Unnamed snapshot")).toBeInTheDocument();
        expect(screen.getByText("snapshot-without-retention")).toBeInTheDocument();
        expect(screen.getByText("latest")).toBeInTheDocument();
        expect(screen.getAllByText("Unknown").length).toBeGreaterThanOrEqual(4);
        expect(screen.getByText("0")).toBeInTheDocument();
    });

    it("formats known Kopia source paths and custom paths", () => {
        hooks.useCacheEntry.mockImplementation((key: string) => {
            if (key === "backup.walg.status") {
                return {
                    data: { data: { ok: true }, status: "fresh" },
                    isLoading: false,
                };
            }

            return {
                data: {
                    data: {
                        ok: true,
                        snapshotsByPath: [
                            {
                                latest: undefined,
                                path: "/source/projects",
                                snapshotCount: 1,
                                snapshots: [],
                            },
                            {
                                latest: undefined,
                                path: "/source/openclaw",
                                snapshotCount: 1,
                                snapshots: [],
                            },
                            {
                                latest: undefined,
                                path: "/mnt/custom",
                                snapshotCount: 1,
                                snapshots: [],
                            },
                        ],
                        stale: [],
                    },
                    status: "fresh",
                },
                isLoading: false,
            };
        });

        render(<BackupOverviewCard />);

        expect(screen.getByText("Projects")).toBeInTheDocument();
        expect(screen.getByText("OpenClaw")).toBeInTheDocument();
        expect(screen.getByText("/mnt/custom")).toBeInTheDocument();
    });

    it("renders backup cache errors", () => {
        hooks.useCacheEntry.mockImplementation((key: string) => ({
            data: {
                data: { ok: false, snapshotsByPath: [] },
                errorMessage:
                    key === "backup.walg.status" ? "WAL-G failed" : "Kopia failed",
                status: "error",
            },
            isLoading: false,
        }));

        render(<BackupOverviewCard />);

        expect(screen.getAllByText("error")).toHaveLength(2);
        expect(screen.getByText("WAL-G failed")).toBeInTheDocument();
        expect(screen.getByText("Kopia failed")).toBeInTheDocument();
        expect(screen.getByText("No backup cache data yet")).toBeInTheDocument();
    });
});
