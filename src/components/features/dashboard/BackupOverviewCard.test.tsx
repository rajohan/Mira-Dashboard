import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { BackupOverviewCard } from "./BackupOverviewCard";

const hooks = vi.hoisted(() => ({
    runKopiaBackup: vi.fn(),
    runWalgBackup: vi.fn(),
    useCacheEntry: vi.fn(),
    useKopiaBackup: vi.fn(),
    useRunKopiaBackup: vi.fn(),
    useRunWalgBackup: vi.fn(),
    useWalgBackup: vi.fn(),
}));

vi.mock("../../../hooks", () => ({
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
    hooks.useKopiaBackup.mockReturnValue({ data: { job: null } });
    hooks.useWalgBackup.mockReturnValue({ data: { job: null } });
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
                            latest: null,
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

        render(<BackupOverviewCard />);

        expect(screen.getByText("Postgres backup is running")).toBeInTheDocument();
        expect(screen.getByText("Backup is running")).toBeInTheDocument();
        expect(screen.getByText("walg uploading base backup")).toBeInTheDocument();
        expect(screen.getByText("kopia scanning files")).toBeInTheDocument();
        for (const button of screen.getAllByRole("button", { name: "Running..." })) {
            expect(button).toBeDisabled();
        }
    });

    it("renders loading and empty states", () => {
        hooks.useCacheEntry.mockImplementation((key: string) => ({
            data: key === "backup.walg.status" ? { data: {}, status: "missing" } : null,
            isLoading: key === "backup.kopia.status",
        }));

        render(<BackupOverviewCard />);

        expect(screen.getByText("No Postgres backup cache data yet")).toBeInTheDocument();
        expect(screen.getByText("Loading backup status...")).toBeInTheDocument();
    });
});
