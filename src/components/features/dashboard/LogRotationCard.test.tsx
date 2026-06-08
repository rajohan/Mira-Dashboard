import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { LogRotationCard } from "./LogRotationCard";

const hooks = vi.hoisted(() => ({
    useScheduledJobs: vi.fn(),
    useLogRotationStatus: vi.fn(),
    useRunLogRotationDryRun: vi.fn(),
    useRunLogRotationNow: vi.fn(),
}));

vi.mock("../../../hooks/useJobs", () => ({
    useScheduledJobs: hooks.useScheduledJobs,
}));

vi.mock("../../../hooks/useLogRotation", () => ({
    useLogRotationStatus: hooks.useLogRotationStatus,
    useRunLogRotationDryRun: hooks.useRunLogRotationDryRun,
    useRunLogRotationNow: hooks.useRunLogRotationNow,
}));

describe("LogRotationCard", () => {
    beforeEach(() => {
        hooks.useScheduledJobs.mockReturnValue({
            data: [
                {
                    cronExpression: null,
                    id: "ops.log-rotation",
                    intervalSeconds: 86_400,
                    scheduleType: "daily",
                    settings: { daily: true, keep: 3, maxSizeMb: 10 },
                    timeOfDay: "03:30",
                },
            ],
        });
    });

    it("renders log rotation status and runs dry-run/real actions", async () => {
        const dryRunMutate = vi.fn();
        const realRunMutate = vi.fn();
        hooks.useLogRotationStatus.mockReturnValue({
            data: {
                lastRun: {
                    checkedFiles: 10,
                    checkedGroups: 2,
                    compressedFiles: 1,
                    deletedArchives: 0,
                    dryRun: false,
                    errors: [],
                    finishedAt: "2026-05-10T10:00:00.000Z",
                    groups: [],
                    ok: true,
                    rotatedFiles: 3,
                    skippedFiles: 0,
                    startedAt: "2026-05-10T09:59:00.000Z",
                    warnings: [],
                },
            },
            isLoading: false,
        });
        hooks.useRunLogRotationDryRun.mockReturnValue({
            data: { result: { dryRun: true }, success: true },
            isPending: false,
            mutate: dryRunMutate,
        });
        hooks.useRunLogRotationNow.mockReturnValue({
            data: null,
            isPending: false,
            mutate: realRunMutate,
        });

        render(<LogRotationCard />);

        expect(screen.getByText("Log rotation")).toBeInTheDocument();
        expect(screen.getByText("3 rotated · 0 errors")).toBeInTheDocument();
        expect(screen.getByText("Last dry-run output")).toBeInTheDocument();

        await userEvent.click(screen.getByRole("button", { name: "Run dry-run now" }));
        await userEvent.click(screen.getByRole("button", { name: "Run real now" }));

        expect(dryRunMutate).toHaveBeenCalledTimes(1);
        expect(realRunMutate).toHaveBeenCalledTimes(1);
    });

    it("shows empty last-run state when status is loaded", () => {
        hooks.useLogRotationStatus.mockReturnValue({ data: null, isLoading: false });
        hooks.useRunLogRotationDryRun.mockReturnValue({
            isPending: false,
            mutate: vi.fn(),
        });
        hooks.useRunLogRotationNow.mockReturnValue({ isPending: false, mutate: vi.fn() });

        render(<LogRotationCard />);

        expect(screen.getByText("No recorded run yet")).toBeInTheDocument();
    });

    it("shows pending and empty states", () => {
        hooks.useLogRotationStatus.mockReturnValue({ data: null, isLoading: true });
        hooks.useRunLogRotationDryRun.mockReturnValue({
            isPending: true,
            mutate: vi.fn(),
        });
        hooks.useRunLogRotationNow.mockReturnValue({ isPending: false, mutate: vi.fn() });

        render(<LogRotationCard />);

        expect(screen.getByRole("button", { name: "Running..." })).toBeDisabled();
        expect(screen.getByRole("button", { name: "Run real now" })).toBeDisabled();
        expect(screen.getByText("Loading...")).toBeInTheDocument();
    });

    it("shows real-run pending and last real-run output states", () => {
        hooks.useLogRotationStatus.mockReturnValue({ data: null, isLoading: false });
        hooks.useRunLogRotationDryRun.mockReturnValue({
            isPending: false,
            mutate: vi.fn(),
        });
        hooks.useRunLogRotationNow.mockReturnValue({
            data: { result: { dryRun: false }, success: true },
            isPending: true,
            mutate: vi.fn(),
        });

        render(<LogRotationCard />);

        expect(screen.getByRole("button", { name: "Running..." })).toBeDisabled();
        expect(screen.getByRole("button", { name: "Run dry-run now" })).toBeDisabled();
        expect(screen.getByText("Last real run output")).toBeInTheDocument();
    });

    it("renders interval schedule values from the scheduled job", () => {
        hooks.useScheduledJobs.mockReturnValue({
            data: [
                {
                    cronExpression: null,
                    id: "ops.log-rotation",
                    intervalSeconds: 1_800,
                    scheduleType: "interval",
                    settings: { daily: false, keep: 5, maxSizeMb: 25 },
                    timeOfDay: null,
                },
            ],
        });
        hooks.useLogRotationStatus.mockReturnValue({ data: null, isLoading: false });
        hooks.useRunLogRotationDryRun.mockReturnValue({
            isPending: false,
            mutate: vi.fn(),
        });
        hooks.useRunLogRotationNow.mockReturnValue({ isPending: false, mutate: vi.fn() });

        render(<LogRotationCard />);

        expect(screen.getByText("30 min interval")).toBeInTheDocument();
        expect(screen.getByText("5 archives")).toBeInTheDocument();
        expect(screen.getByText("25 MB")).toBeInTheDocument();
    });

    it("renders cron schedule and missing setting fallbacks", () => {
        hooks.useScheduledJobs.mockReturnValue({
            data: [
                {
                    cronExpression: "0 4 * * *",
                    id: "ops.log-rotation",
                    intervalSeconds: null,
                    scheduleType: "cron",
                    settings: {},
                    timeOfDay: null,
                },
            ],
        });
        hooks.useLogRotationStatus.mockReturnValue({ data: null, isLoading: false });
        hooks.useRunLogRotationDryRun.mockReturnValue({
            isPending: false,
            mutate: vi.fn(),
        });
        hooks.useRunLogRotationNow.mockReturnValue({ isPending: false, mutate: vi.fn() });

        render(<LogRotationCard />);

        expect(screen.getByText("0 4 * * *")).toBeInTheDocument();
        expect(screen.getAllByText("—")).toHaveLength(3);
    });

    it("renders an empty schedule fallback when the job is absent", () => {
        hooks.useScheduledJobs.mockReturnValue({ data: [] });
        hooks.useLogRotationStatus.mockReturnValue({ data: null, isLoading: false });
        hooks.useRunLogRotationDryRun.mockReturnValue({
            isPending: false,
            mutate: vi.fn(),
        });
        hooks.useRunLogRotationNow.mockReturnValue({ isPending: false, mutate: vi.fn() });

        render(<LogRotationCard />);

        expect(screen.getAllByText("—")).toHaveLength(4);
    });
});
