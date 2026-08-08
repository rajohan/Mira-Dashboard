import { describe, expect, jest, test } from "bun:test";

import type { JobQueueSummary } from "../../contracts/jobs.ts";
import { JobQueuePanel } from "./JobQueuePanel.tsx";

const { render, screen } = await import("@testing-library/react");
const userEventModule = await import("@testing-library/user-event");
const userEvent = userEventModule.default;

const timestampMs = 1_800_000_000_000;
const summary: JobQueueSummary = {
    activeResourceClasses: ["light"],
    control: {
        claimingPaused: false,
        updatedAtMs: timestampMs,
        version: 4,
    },
    oldestQueuedAtMs: timestampMs - 60_000,
    stateCounts: {
        cancelled: 2,
        failed: 3,
        queued: 1,
        running: 1,
        succeeded: 8,
        "timed-out": 4,
    },
    workers: [
        {
            activeRunCount: 1,
            capacity: 2,
            heartbeatAtMs: timestampMs,
            id: "019fdd00-0000-7000-8000-000000000001",
            releaseId: "a".repeat(40),
            startedAtMs: timestampMs - 3_600_000,
            state: "online",
        },
    ],
};

describe("job queue panel", () => {
    test("presents queue and worker state and requests a versioned pause direction", async () => {
        const onSetClaimingPaused = jest.fn();
        render(
            <JobQueuePanel
                controlBusy={false}
                onSetClaimingPaused={onSetClaimingPaused}
                summary={summary}
            />
        );
        const user = userEvent.setup();

        expect(screen.getByRole("status")).toHaveTextContent("Claiming active");
        expect(screen.getByRole("table", { name: "Job workers" })).toBeTruthy();
        expect(screen.getByText(summary.workers[0]!.id)).toBeTruthy();
        expect(screen.getByText("version 4", { exact: false })).toBeTruthy();
        expect(screen.getByText("queued job runs")).toBeTruthy();

        await user.click(
            screen.getByRole("button", {
                name: "Pause claiming for new job runs",
            })
        );
        expect(onSetClaimingPaused).toHaveBeenCalledWith(true);
    });

    test("disables and labels a pending resume without dispatching another action", async () => {
        const onSetClaimingPaused = jest.fn();
        render(
            <JobQueuePanel
                controlBusy
                onSetClaimingPaused={onSetClaimingPaused}
                summary={{
                    ...summary,
                    control: { ...summary.control, claimingPaused: true },
                }}
            />
        );
        const user = userEvent.setup();
        const control = screen.getByRole("button", {
            name: "Resume claiming for new job runs",
        });

        expect(control).toBeDisabled();
        expect(control).toHaveAttribute("aria-busy", "true");
        expect(control).toHaveTextContent("Resuming claiming...");
        await user.click(control);
        expect(onSetClaimingPaused).not.toHaveBeenCalled();
    });
});
