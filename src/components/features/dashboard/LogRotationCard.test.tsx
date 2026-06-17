import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { LogRotationCard } from "./LogRotationCard";

const hooks = vi.hoisted(() => ({
    useLogRotationStatus: vi.fn(),
    useRunLogRotationDryRun: vi.fn(),
    useRunLogRotationNow: vi.fn(),
    useScheduledJobs: vi.fn(),
}));

vi.mock("../../../hooks/useLogRotation", () => ({
    useLogRotationStatus: hooks.useLogRotationStatus,
    useRunLogRotationDryRun: hooks.useRunLogRotationDryRun,
    useRunLogRotationNow: hooks.useRunLogRotationNow,
}));

vi.mock("../../../hooks/useScheduledJobs", () => ({
    useScheduledJobs: hooks.useScheduledJobs,
}));

describe("LogRotationCard", () => {
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
        hooks.useScheduledJobs.mockReturnValue({
            data: [
                {
                    cronExpression: null,
                    enabled: true,
                    id: "ops.log-rotation",
                    intervalSeconds: 86_400,
                    name: "Log rotation",
                    nextRunAt: "2026-05-11T03:15:00.000Z",
                    scheduleType: "daily",
                    timeOfDay: "03:15",
                },
            ],
        });

        render(<LogRotationCard />);

        expect(screen.getByText("Log rotation")).toBeInTheDocument();
        expect(screen.getByText("03:15 daily")).toBeInTheDocument();
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
        hooks.useScheduledJobs.mockReturnValue({ data: [] });

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
        hooks.useScheduledJobs.mockReturnValue({ data: undefined });

        render(<LogRotationCard />);

        expect(screen.getByRole("button", { name: "Running..." })).toBeDisabled();
        expect(screen.getByRole("button", { name: "Run real now" })).toBeDisabled();
        expect(screen.getAllByText("Loading...").length).toBeGreaterThanOrEqual(1);
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
        hooks.useScheduledJobs.mockReturnValue({
            data: [
                {
                    cronExpression: "10 2 * * *",
                    enabled: true,
                    id: "ops.log-rotation",
                    intervalSeconds: 3600,
                    name: "Log rotation",
                    nextRunAt: "2026-05-11T02:10:00.000Z",
                    scheduleType: "cron",
                    timeOfDay: null,
                },
            ],
        });

        render(<LogRotationCard />);

        expect(screen.getByRole("button", { name: "Running..." })).toBeDisabled();
        expect(screen.getByRole("button", { name: "Run dry-run now" })).toBeDisabled();
        expect(screen.getByText("10 2 * * *")).toBeInTheDocument();
        expect(screen.getByText("Last real run output")).toBeInTheDocument();
    });

    it("renders disabled and interval scheduled job labels", () => {
        hooks.useLogRotationStatus.mockReturnValue({ data: null, isLoading: false });
        hooks.useRunLogRotationDryRun.mockReturnValue({
            isPending: false,
            mutate: vi.fn(),
        });
        hooks.useRunLogRotationNow.mockReturnValue({ isPending: false, mutate: vi.fn() });
        hooks.useScheduledJobs.mockReturnValue({
            data: [
                {
                    cronExpression: null,
                    enabled: false,
                    id: "ops.log-rotation",
                    intervalSeconds: 7200,
                    name: "Log rotation",
                    nextRunAt: null,
                    scheduleType: "interval",
                    timeOfDay: null,
                },
            ],
        });

        const { rerender } = render(<LogRotationCard />);
        expect(screen.getByText("Disabled")).toBeInTheDocument();

        hooks.useScheduledJobs.mockReturnValue({
            data: [
                {
                    cronExpression: null,
                    enabled: true,
                    id: "ops.log-rotation",
                    intervalSeconds: 7200,
                    name: "Log rotation",
                    nextRunAt: "2026-05-11T02:10:00.000Z",
                    scheduleType: "interval",
                    timeOfDay: null,
                },
            ],
        });

        rerender(<LogRotationCard />);
        expect(screen.getByText("Every 2h")).toBeInTheDocument();

        hooks.useScheduledJobs.mockReturnValue({
            data: [
                {
                    cronExpression: null,
                    enabled: true,
                    id: "ops.log-rotation",
                    intervalSeconds: 900,
                    name: "Log rotation",
                    nextRunAt: "2026-05-11T02:10:00.000Z",
                    scheduleType: "interval",
                    timeOfDay: null,
                },
            ],
        });

        rerender(<LogRotationCard />);
        expect(screen.getByText("Every 15m")).toBeInTheDocument();
    });

    it("does not fall through to interval labels when typed schedules miss details", () => {
        hooks.useLogRotationStatus.mockReturnValue({ data: null, isLoading: false });
        hooks.useRunLogRotationDryRun.mockReturnValue({
            isPending: false,
            mutate: vi.fn(),
        });
        hooks.useRunLogRotationNow.mockReturnValue({ isPending: false, mutate: vi.fn() });
        hooks.useScheduledJobs.mockReturnValue({
            data: [
                {
                    cronExpression: null,
                    enabled: true,
                    id: "ops.log-rotation",
                    intervalSeconds: 7200,
                    name: "Log rotation",
                    nextRunAt: "2026-05-11T02:10:00.000Z",
                    scheduleType: "daily",
                    timeOfDay: null,
                },
            ],
        });

        const { rerender } = render(<LogRotationCard />);
        expect(screen.getByText("Daily")).toBeInTheDocument();
        expect(screen.queryByText("Every 2h")).not.toBeInTheDocument();

        hooks.useScheduledJobs.mockReturnValue({
            data: [
                {
                    cronExpression: null,
                    enabled: true,
                    id: "ops.log-rotation",
                    intervalSeconds: 7200,
                    name: "Log rotation",
                    nextRunAt: "2026-05-11T02:10:00.000Z",
                    scheduleType: "cron",
                    timeOfDay: null,
                },
            ],
        });

        rerender(<LogRotationCard />);
        expect(screen.getByText("Cron schedule")).toBeInTheDocument();
        expect(screen.queryByText("Every 2h")).not.toBeInTheDocument();
    });
});
