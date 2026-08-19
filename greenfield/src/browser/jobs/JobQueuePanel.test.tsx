import { describe, expect, jest, test } from "bun:test";

import type { JobRunSummary } from "../../contracts/jobModel.ts";
import type { JobQueueSummary } from "../../contracts/jobs.ts";
import { JobQueuePanel } from "./JobQueuePanel.tsx";

const { fireEvent, render, screen } = await import("@testing-library/react");
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
            "@min-[66rem]:min-w-256",
            "@min-[66rem]:[&_td:nth-child(n+4)]:table-cell"
        );
        const recentTable = screen.getByRole("table", { name: "Recent jobs" });
        expect(recentTable.querySelector('col[style="width: 24%;"]')).toBeTruthy();
        expect(recentTable.querySelector('col[style="width: 25%;"]')).toBeTruthy();
        expect(screen.getByRole("table", { name: "Job workers" })).toHaveClass(
            "[&_td:nth-child(n+4)]:hidden",
            "@min-[66rem]:[&_td:nth-child(n+4)]:table-cell"
        );
    });

    test("keeps every loaded completed run browsable", () => {
        const runs = Array.from({ length: 4 }, (_, index) => ({
            actionKey: "system.worker-smoke",
            attemptCount: 1,
            attemptLimit: 1,
            availableAtMs: timestampMs - index,
            cancellationPolicy: "cooperative",
            displayName: `Completed run ${index + 1}`,
            eventCount: 1,
            id: `019fdd00-0000-7000-8000-00000000000${index + 2}`,
            priority: 0,
            queuedAtMs: timestampMs - index,
            resourceClass: "light",
            resourceKeys: [],
            retrySafe: true,
            state: "succeeded",
            stateVersion: 1,
            timeoutMs: 60_000,
            triggerType: "manual",
            updatedAtMs: timestampMs - index,
        })) satisfies JobRunSummary[];

        render(
            <JobQueuePanel
                controlBusy={false}
                onSelectRun={() => {}}
                onSetClaimingPaused={() => {}}
                runs={runs}
                summary={summary}
            />
        );

        expect(screen.getByText("Completed run 4")).toBeVisible();
    });

    test("loads older completed runs only near the recent-history scroll end", () => {
        const onLoadMoreRuns = jest.fn();
        const runs = Array.from({ length: 50 }, (_, index) => ({
            actionKey: "system.worker-smoke",
            attemptCount: 1,
            attemptLimit: 1,
            availableAtMs: timestampMs - index,
            cancellationPolicy: "cooperative",
            displayName: `Paged completed run ${index + 1}`,
            eventCount: 1,
            id: `019fdd00-0000-7000-9000-${String(index).padStart(12, "0")}`,
            priority: 0,
            queuedAtMs: timestampMs - index,
            resourceClass: "light",
            resourceKeys: [],
            retrySafe: true,
            state: "succeeded",
            stateVersion: 1,
            timeoutMs: 60_000,
            triggerType: "manual",
            updatedAtMs: timestampMs - index,
        })) satisfies JobRunSummary[];

        const { rerender } = render(
            <JobQueuePanel
                controlBusy={false}
                onLoadMoreRuns={onLoadMoreRuns}
                onSelectRun={() => {}}
                onSetClaimingPaused={() => {}}
                runs={runs}
                summary={summary}
            />
        );

        expect(onLoadMoreRuns).not.toHaveBeenCalled();
        const history = screen.getByRole("region", { name: "Recent jobs" });
        Object.defineProperties(history, {
            clientHeight: { configurable: true, value: 500 },
            scrollHeight: { configurable: true, value: 4000 },
            scrollTop: { configurable: true, value: 3200, writable: true },
        });
        fireEvent.scroll(history);
        expect(onLoadMoreRuns).toHaveBeenCalledTimes(1);

        rerender(
            <JobQueuePanel
                controlBusy={false}
                onLoadMoreRuns={onLoadMoreRuns}
                onSelectRun={() => {}}
                onSetClaimingPaused={() => {}}
                runs={runs}
                runsLoadingMore
                summary={summary}
            />
        );
        expect(screen.getByLabelText("Loading older jobs…")).toBeVisible();
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
