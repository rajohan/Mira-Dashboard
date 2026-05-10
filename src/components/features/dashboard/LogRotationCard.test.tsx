import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { LogRotationCard } from "./LogRotationCard";

const hooks = vi.hoisted(() => ({
    useLogRotationStatus: vi.fn(),
    useRunLogRotationDryRun: vi.fn(),
    useRunLogRotationNow: vi.fn(),
}));

vi.mock("../../../hooks/useLogRotation", () => ({
    useLogRotationStatus: hooks.useLogRotationStatus,
    useRunLogRotationDryRun: hooks.useRunLogRotationDryRun,
    useRunLogRotationNow: hooks.useRunLogRotationNow,
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

        render(<LogRotationCard />);

        expect(screen.getByText("Log rotation")).toBeInTheDocument();
        expect(screen.getByText("3 rotated · 0 errors")).toBeInTheDocument();
        expect(screen.getByText("Last dry-run output")).toBeInTheDocument();

        await userEvent.click(screen.getByRole("button", { name: "Run dry-run now" }));
        await userEvent.click(screen.getByRole("button", { name: "Run real now" }));

        expect(dryRunMutate).toHaveBeenCalledTimes(1);
        expect(realRunMutate).toHaveBeenCalledTimes(1);
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
});
