import { describe, expect, jest, test } from "bun:test";

import {
    jobRunResultMaximumBytes,
    type JobRunSummary,
} from "../../contracts/jobModel.ts";
import type { JobRunDetail as JobRunDetailData } from "../../contracts/jobs.ts";
import { JobRunDetail } from "./JobRunDetail.tsx";

const { render, screen, waitFor } = await import("@testing-library/react");
const userEventModule = await import("@testing-library/user-event");
const userEvent = userEventModule.default;

const timestampMs = 1_800_000_000_000;
const runId = "019fdd00-0000-7000-8000-000000000001";

function runningRun(overrides: Partial<JobRunSummary> = {}): JobRunSummary {
    return {
        actionKey: "maintenance.rotate-logs",
        attemptCount: 1,
        attemptLimit: 3,
        availableAtMs: timestampMs,
        cancellationPolicy: "cooperative",
        displayName: "Rotate durable logs",
        eventCount: 3,
        firstStartedAtMs: timestampMs + 1000,
        id: runId,
        lastAttemptStartedAtMs: timestampMs + 1000,
        priority: 10,
        queuedAtMs: timestampMs,
        resourceClass: "host-heavy",
        resourceKeys: ["host.logs"],
        retrySafe: true,
        state: "running",
        stateVersion: 2,
        timeoutMs: 3_600_000,
        triggerType: "system",
        updatedAtMs: timestampMs + 3000,
        ...overrides,
    };
}

function runningDetail(overrides: Partial<JobRunSummary> = {}): JobRunDetailData {
    return {
        events: [
            {
                attempt: 1,
                kind: "progress",
                occurredAtMs: timestampMs + 3000,
                progress: { completed: 3, label: "<strong>not markup</strong>" },
                sequence: 3,
                workerInstanceId: "019fdd00-0000-7000-8000-000000000002",
            },
            {
                attempt: 1,
                kind: "stdout",
                message: "<script>unsafe()</script>\nrotation started",
                occurredAtMs: timestampMs + 2000,
                sequence: 2,
            },
        ],
        nextEventCursor: { sequence: 2 },
        run: runningRun(overrides),
    };
}

describe("job run detail", () => {
    test("renders safe bounded event data and dispatches cooperative cancellation", async () => {
        const onCancel = jest.fn();
        render(
            <JobRunDetail
                cancelBusy={false}
                detail={runningDetail()}
                onCancel={onCancel}
            />
        );
        const user = userEvent.setup();

        expect(
            screen.getByRole("heading", { level: 2, name: "Rotate durable logs" })
        ).toBeTruthy();
        expect(
            screen.getByText("<script>unsafe()</script>", { exact: false })
        ).toBeTruthy();
        expect(
            screen.getByText("<strong>not markup</strong>", { exact: false })
        ).toBeTruthy();
        expect(document.querySelector("script")).toBeNull();
        expect(document.querySelector("strong")).toBeNull();
        const outputRegion = screen.getByRole("region", {
            name: "stdout output, event 2, attempt 1",
        });
        const progressRegion = screen.getByRole("region", {
            name: "Progress data, event 3, attempt 1",
        });
        expect(outputRegion).toHaveAttribute("tabindex", "0");
        expect(progressRegion).toHaveAttribute("tabindex", "0");
        outputRegion.focus();
        expect(outputRegion).toHaveFocus();
        progressRegion.focus();
        expect(progressRegion).toHaveFocus();
        expect(
            screen.getByText("Use “Load older events”", { exact: false })
        ).toBeTruthy();

        await user.click(
            screen.getByRole("button", {
                name: "Request cancellation: Rotate durable logs",
            })
        );
        expect(onCancel).toHaveBeenCalledWith(runId);
    });

    test("disables the cancellation control while the request is pending", () => {
        render(<JobRunDetail cancelBusy detail={runningDetail()} onCancel={() => {}} />);

        const busyControl = screen.getByRole("button", {
            name: "Request cancellation: Rotate durable logs",
        });
        expect(busyControl).toBeDisabled();
        expect(busyControl).toHaveAttribute("aria-busy", "true");
        expect(busyControl).toHaveTextContent("Requesting cancellation...");
    });

    test("keeps unsupported or already-requested cancellation unavailable", () => {
        const onCancel = jest.fn();
        const view = render(
            <JobRunDetail
                cancelBusy={false}
                detail={runningDetail({ cancellationPolicy: "queued-only" })}
                onCancel={onCancel}
            />
        );

        expect(
            screen.getByRole("button", {
                name: "Cancellation unavailable: Rotate durable logs",
            })
        ).toBeDisabled();

        view.rerender(
            <JobRunDetail
                cancelBusy={false}
                detail={runningDetail({ cancelRequestedAtMs: timestampMs + 2500 })}
                onCancel={onCancel}
            />
        );
        expect(
            screen.getByRole("button", {
                name: "Cancellation requested: Rotate durable logs",
            })
        ).toBeDisabled();
        expect(
            screen.getByText("Cancellation requested at", { exact: false })
        ).toBeTruthy();
    });

    test("announces live state atomically and restores heading focus after cancellation", async () => {
        const view = render(
            <JobRunDetail cancelBusy detail={runningDetail()} onCancel={() => {}} />
        );

        const runningStatus = screen.getByRole("status", { name: "Run state" });
        expect(runningStatus).toHaveAttribute("aria-atomic", "true");
        expect(runningStatus).toHaveAttribute("aria-live", "polite");
        expect(runningStatus).toHaveTextContent("running");

        view.rerender(
            <JobRunDetail
                cancelBusy={false}
                detail={runningDetail({
                    finishedAtMs: timestampMs + 4000,
                    state: "cancelled",
                    terminalCode: "operator-cancelled",
                    terminalMessage: "Cancelled by the operator.",
                    updatedAtMs: timestampMs + 4000,
                })}
                onCancel={() => {}}
            />
        );

        expect(screen.getByRole("status", { name: "Run state" })).toHaveTextContent(
            "cancelled"
        );
        await waitFor(() =>
            expect(
                screen.getByRole("heading", {
                    level: 2,
                    name: "Rotate durable logs",
                })
            ).toHaveFocus()
        );
    });

    test("restores heading focus when a running cancellation request is accepted", async () => {
        const view = render(
            <JobRunDetail cancelBusy detail={runningDetail()} onCancel={() => {}} />
        );
        screen
            .getByRole("button", {
                name: "Request cancellation: Rotate durable logs",
            })
            .focus();

        view.rerender(
            <JobRunDetail
                cancelBusy={false}
                detail={runningDetail({
                    cancelRequestedAtMs: timestampMs + 3500,
                    stateVersion: 3,
                    updatedAtMs: timestampMs + 3500,
                })}
                onCancel={() => {}}
            />
        );

        expect(
            screen.getByRole("button", {
                name: "Cancellation requested: Rotate durable logs",
            })
        ).toBeDisabled();
        await waitFor(() =>
            expect(
                screen.getByRole("heading", {
                    level: 2,
                    name: "Rotate durable logs",
                })
            ).toHaveFocus()
        );
    });

    test("clamps pretty-printed result text and never creates markup from JSON", () => {
        const succeededRun = runningRun({
            eventCount: 1,
            finishedAtMs: timestampMs + 4000,
            state: "succeeded",
            updatedAtMs: timestampMs + 4000,
        });
        render(
            <JobRunDetail
                cancelBusy={false}
                detail={{
                    events: [
                        {
                            attempt: 1,
                            kind: "succeeded",
                            occurredAtMs: timestampMs + 4000,
                            sequence: 1,
                        },
                    ],
                    result: {
                        output: `<img src=x onerror=unsafe()>${"x".repeat(jobRunResultMaximumBytes)}`,
                    },
                    run: succeededRun,
                }}
                onCancel={() => {}}
            />
        );

        expect(screen.getByText("display truncated", { exact: false })).toBeTruthy();
        expect(
            screen.getByText("<img src=x onerror=unsafe()>", { exact: false })
        ).toBeTruthy();
        expect(document.querySelector("img")).toBeNull();
        const resultRegion = screen.getByRole("region", {
            name: `Result for job run ${runId}`,
        });
        expect(resultRegion).toHaveAttribute("tabindex", "0");
        resultRegion.focus();
        expect(resultRegion).toHaveFocus();
        expect(screen.queryByRole("button", { name: /cancell/iu })).toBeNull();
    });
});
