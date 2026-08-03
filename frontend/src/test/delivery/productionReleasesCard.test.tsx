import { describe, expect, it, jest } from "bun:test";

import { fireEvent, render, screen } from "@testing-library/react";

import type { DashboardReleaseStatus } from "../../../../contracts/delivery/deployments";
import { ProductionReleasesCard } from "../../components/features/delivery/ProductionReleasesCard";

const CURRENT_COMMIT = "a".repeat(40);
const PREVIOUS_COMMIT = "b".repeat(40);

function releaseSummary(commitSha: string, commitTitle: string) {
    return {
        builtAt: "2026-07-27T12:00:00.000Z",
        commitSha,
        commitTitle,
        commitUrl: `https://github.com/rajohan/Mira-Dashboard/commit/${commitSha}`,
        schema: {
            maximumCompatible: 6,
            minimumCompatible: 6,
            target: 6,
        },
    };
}

function releaseStatus(isAvailable: boolean): DashboardReleaseStatus {
    return {
        current: releaseSummary(CURRENT_COMMIT, "Current release"),
        previous: releaseSummary(PREVIOUS_COMMIT, "Failed previous release"),
        rollback: {
            available: isAvailable,
            ...(!isAvailable && {
                reason: "Previous release failed its latest runtime readiness check",
            }),
        },
    };
}

describe("Production releases card", () => {
    it("distinguishes an ineligible previous slot from a rollback target", () => {
        const onRollback = jest.fn();
        const view = render(
            <ProductionReleasesCard
                baseBranch="main"
                checkout={undefined}
                error={undefined}
                isActionPending={false}
                onRollback={onRollback}
                release={releaseStatus(false)}
            />
        );

        expect(screen.getByText("Previous slot")).toBeInTheDocument();
        expect(screen.getByText("Not eligible")).toBeInTheDocument();
        expect(
            screen.getByText("Previous release failed its latest runtime readiness check")
        ).toBeInTheDocument();
        const disabledRollback = screen.getByRole("button", {
            name: `Roll back to ${PREVIOUS_COMMIT.slice(0, 8)}`,
        });
        expect(disabledRollback).toBeDisabled();
        fireEvent.click(disabledRollback);
        expect(onRollback).not.toHaveBeenCalled();

        view.rerender(
            <ProductionReleasesCard
                baseBranch="main"
                checkout={undefined}
                error={undefined}
                isActionPending={false}
                onRollback={onRollback}
                release={releaseStatus(true)}
            />
        );
        expect(screen.getByText("Rollback target")).toBeInTheDocument();
        expect(screen.getByText("Previous")).toBeInTheDocument();
        const enabledRollback = screen.getByRole("button", {
            name: `Roll back to ${PREVIOUS_COMMIT.slice(0, 8)}`,
        });
        expect(enabledRollback).toBeEnabled();
        fireEvent.click(enabledRollback);
        expect(onRollback).toHaveBeenCalledWith(
            expect.objectContaining({ commitSha: PREVIOUS_COMMIT })
        );
    });
});
