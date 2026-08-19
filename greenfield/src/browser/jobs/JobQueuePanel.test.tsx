import { describe, expect, jest, test } from "bun:test";

import type { JobRunSummary } from "../../contracts/jobModel.ts";
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
    test("keeps compact run metadata hidden until the table container is wide", () => {
        const recentRun = {
            actionKey: "system.worker-smoke",
            attemptCount: 1,
            attemptLimit: 1,
            availableAtMs: timestampMs - 1000,
            cancellationPolicy: "cooperative",
            displayName: "Recent worker smoke",
            eventCount: 1,
            id: "019fdd00-0000-7000-8000-000000000002",
            priority: 0,
            queuedAtMs: timestampMs - 1000,
            resourceClass: "light",
            resourceKeys: [],
            retrySafe: true,
            state: "succeeded",
            stateVersion: 1,
            timeoutMs: 60_000,
            triggerType: "manual",
            updatedAtMs: timestampMs,
        } as const satisfies JobRunSummary;

        render(
            <JobQueuePanel
                controlBusy={false}
                onSelectRun={() => {}}
                onSetClaimingPaused={() => {}}
                runs={[recentRun]}
                summary={summary}
            />
        );

        expect(screen.getByRole("table", { name: "Recent jobs" })).toHaveClass(
            "[&_td:nth-child(n+4)]:hidden",
            "@min-[66rem]:[&_td:nth-child(n+4)]:table-cell"
        );
        expect(screen.getByRole("table", { name: "Job workers" })).toHaveClass(
            "[&_td:nth-child(n+4)]:hidden",
            "@min-[66rem]:[&_td:nth-child(n+4)]:table-cell"
        );
    });

    test("presents queue and worker state and requests a versioned pause direction", async () => {
        const onSetClaimingPaused = jest.fn();
        render(
            <JobQueuePanel
                controlBusy={false}
                onSelectRun={() => {}}
                onSetClaimingPaused={onSetClaimingPaused}
                runs={[]}
                summary={summary}
            />
        );
        const user = userEvent.setup();

        expect(screen.getByRole("status")).toHaveTextContent("Accepting new jobs");
        expect(screen.getByRole("table", { name: "Job workers" })).toBeTruthy();
        expect(screen.getByText(summary.workers[0]!.id)).toBeTruthy();
        expect(screen.queryByText("version 4", { exact: false })).toBeNull();
        expect(screen.getByText("queued job runs")).toBeTruthy();
        expect(screen.getByText("No queued or running jobs.")).toBeTruthy();
        expect(screen.getByText("No recent jobs.")).toBeTruthy();

        await user.click(
            screen.getByRole("button", {
                name: "Pause new jobs",
            })
        );
        expect(onSetClaimingPaused).toHaveBeenCalledWith(true);
    });

    test("disables and labels a pending resume without dispatching another action", async () => {
        const onSetClaimingPaused = jest.fn();
        render(
            <JobQueuePanel
                controlBusy
                onSelectRun={() => {}}
                onSetClaimingPaused={onSetClaimingPaused}
                runs={[]}
                summary={{
                    ...summary,
                    control: { ...summary.control, claimingPaused: true },
                }}
            />
        );
        const user = userEvent.setup();
        const control = screen.getByRole("button", {
            name: "Resume new jobs",
        });

        expect(control).toBeDisabled();
        expect(control).toHaveAttribute("aria-busy", "true");
        expect(control).toHaveTextContent("Resuming new jobs...");
        await user.click(control);
        expect(onSetClaimingPaused).not.toHaveBeenCalled();
    });
});
