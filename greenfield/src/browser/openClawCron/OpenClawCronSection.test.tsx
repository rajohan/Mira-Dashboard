import { describe, expect, mock, test } from "bun:test";

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type {
    ListOpenClawCronResult,
    ListOpenClawCronRunsResult,
    OpenClawCronJob,
} from "../../contracts/openClawCron.ts";
import { OpenClawCronSectionView } from "./OpenClawCronSection.tsx";

const job = {
    agentId: "main",
    agentIdTruncated: false,
    configRevision: "revision-1",
    createdAtMs: 1_800_000_000_000,
    delivery: {
        completionDestinationConfigured: false,
        metadataTruncated: false,
        mode: "announce",
        targetConfigured: false,
    },
    deliveryMode: "announce",
    description: "Produces the nightly operations report.",
    descriptionTruncated: false,
    enabled: true,
    id: "nightly-report",
    name: "Nightly report",
    nameTruncated: false,
    payload: {
        kind: "agent-turn",
        message: "Produce the nightly operations report.",
        model: "openai/gpt-5.6-sol",
        truncated: false,
    },
    schedule: {
        expr: "0 7 * * *",
        kind: "cron",
        truncated: false,
        tz: "Europe/Oslo",
    },
    sessionTarget: "isolated",
    source: "openclaw",
    state: {
        lastRunAtMs: 1_800_010_000_000,
        lastRunStatus: "ok",
        nextRunAtMs: 1_800_020_000_000,
    },
    synchronization: { state: "confirmed" },
    updatedAtMs: 1_800_001_000_000,
    wakeMode: "now",
} as const satisfies OpenClawCronJob;

const freshInventorySource = {
    kind: "fresh",
    observedAtMs: 1_800_001_000_000,
} as const satisfies ListOpenClawCronResult["freshness"];

function result(freshness?: ListOpenClawCronResult["freshness"]): ListOpenClawCronResult {
    return {
        freshness: freshness ?? freshInventorySource,
        hasMore: false,
        jobs: [job],
        limit: 50,
        offset: 0,
        snapshotRevision: `sha256:${"A".repeat(43)}`,
        total: 1,
    };
}

function resultWithJobs(jobs: readonly OpenClawCronJob[]): ListOpenClawCronResult {
    return {
        ...result(),
        jobs: [...jobs],
        total: jobs.length,
    };
}

const runs = {
    freshness: { kind: "fresh", observedAtMs: 1_800_011_000_000 },
    hasMore: false,
    limit: 50,
    offset: 0,
    runs: [
        {
            completedAtMs: 1_800_010_000_000,
            deliveryStatus: "delivered",
            durationMs: 3000,
            jobId: job.id,
            model: "model-preview",
            modelTruncated: true,
            provider: "provider-preview",
            providerTruncated: true,
            runAtMs: 1_800_009_997_000,
            runId: "run-1",
            status: "ok",
            summary: "Report delivered.",
            summaryTruncated: false,
        },
    ],
    total: 1,
} as const satisfies ListOpenClawCronRunsResult;

function callbacks() {
    return {
        onDelete: mock(async () => {}),
        onRetry: mock(() => {}),
        onRun: mock(async () => {}),
        onSetEnabled: mock(async () => {}),
        onUpdate: mock(async () => {}),
    };
}

function unknownOutcomeError(): Error {
    return Object.assign(new Error("private lost acknowledgement detail"), {
        data: {
            code: "SERVICE_UNAVAILABLE",
            reason: "operation_outcome_unknown",
        },
    });
}

function deferredBoolean() {
    let rejectDeferred!: (reason?: unknown) => void;
    let resolveDeferred!: (value: boolean) => void;
    const promise = new Promise<boolean>((resolve, reject) => {
        resolveDeferred = resolve;
        rejectDeferred = reject;
    });
    return { promise, reject: rejectDeferred, resolve: resolveDeferred };
}

describe("OpenClawCronSection", () => {
    test("renders explicit initial loading and safe retry states", async () => {
        const actions = callbacks();
        const { rerender } = render(
            <OpenClawCronSectionView {...actions} state={{ status: "loading" }} />
        );
        expect(screen.getByLabelText("Loading OpenClaw cron jobs…")).toBeInTheDocument();

        rerender(
            <OpenClawCronSectionView
                {...actions}
                state={{ message: "OpenClaw Gateway is unavailable.", status: "error" }}
            />
        );
        await userEvent.click(
            screen.getByRole("button", { name: "Retry OpenClaw cron" })
        );
        expect(actions.onRetry).toHaveBeenCalledTimes(1);
    });

    test("separates Gateway cron from Dashboard jobs and renders detail/history", () => {
        const actions = callbacks();
        render(
            <OpenClawCronSectionView
                {...actions}
                runs={runs}
                state={{ result: result(), status: "ready" }}
            />
        );
        expect(
            screen.getByText(/separate from Dashboard schedules, durable queues/u)
        ).toBeInTheDocument();
        expect(screen.getByRole("table", { name: "OpenClaw cron jobs" })).toBeVisible();
        expect(
            screen.getByRole("table", { name: "OpenClaw runs for Nightly report" })
        ).toBeVisible();
        expect(
            screen.getByText(
                "These are Gateway cron runs, not Dashboard durable job runs."
            )
        ).toBeVisible();
        expect(screen.getByText("model-preview (bounded)")).toBeVisible();
        expect(screen.getByText("provider-preview (bounded)")).toBeVisible();
    });

    test("marks omitted agent and delivery metadata as an incomplete definition", () => {
        const actions = callbacks();
        const incompleteJob = {
            ...job,
            agentId: undefined,
            agentIdTruncated: true,
            delivery: {
                ...job.delivery,
                metadataTruncated: true,
            },
        } satisfies OpenClawCronJob;

        render(
            <OpenClawCronSectionView
                {...actions}
                state={{ result: resultWithJobs([incompleteJob]), status: "ready" }}
            />
        );

        expect(
            screen.getByText(
                "One or more definition values are bounded or sanitized. Incomplete fields are omitted from the editor so an unrelated change cannot overwrite the authoritative Gateway value."
            )
        ).toBeVisible();
        expect(screen.queryByText("Agent")).not.toBeInTheDocument();
    });

    test("orders the bounded inventory enabled-first and then by name", () => {
        const actions = callbacks();
        const jobs = [
            { ...job, enabled: false, id: "alpha-disabled", name: "Alpha" },
            { ...job, id: "zulu-enabled", name: "Zulu" },
            { ...job, id: "beta-enabled", name: "Beta" },
        ] satisfies OpenClawCronJob[];
        render(
            <OpenClawCronSectionView
                {...actions}
                state={{ result: resultWithJobs(jobs), status: "ready" }}
            />
        );

        const rows = within(
            screen.getByRole("table", { name: "OpenClaw cron jobs" })
        ).getAllByRole("row");
        expect(rows.slice(1).map((row) => row.textContent)).toEqual([
            expect.stringContaining("Beta"),
            expect.stringContaining("Zulu"),
            expect.stringContaining("Alpha"),
        ]);
    });

    test("requires confirmation before an immediate Gateway run", async () => {
        const actions = callbacks();
        render(
            <OpenClawCronSectionView
                {...actions}
                runs={runs}
                state={{ result: result(), status: "ready" }}
            />
        );
        await userEvent.click(screen.getByRole("button", { name: "Run now" }));
        const dialog = screen.getByRole("dialog", { name: "Run OpenClaw cron job" });
        expect(actions.onRun).not.toHaveBeenCalled();
        await userEvent.click(within(dialog).getByRole("button", { name: "Run now" }));
        await waitFor(() => expect(actions.onRun).toHaveBeenCalledWith(job));
    });

    test("never retargets an open destructive confirmation after inventory refresh", async () => {
        const actions = callbacks();
        const otherJob = {
            ...job,
            id: "weekly-report",
            name: "Weekly report",
        } satisfies OpenClawCronJob;
        const { rerender } = render(
            <OpenClawCronSectionView
                {...actions}
                state={{ result: resultWithJobs([job, otherJob]), status: "ready" }}
            />
        );

        await userEvent.click(screen.getByRole("button", { name: "Delete" }));
        expect(
            screen.getByRole("dialog", { name: "Delete OpenClaw cron job" })
        ).toHaveTextContent("Nightly report");

        rerender(
            <OpenClawCronSectionView
                {...actions}
                state={{ result: resultWithJobs([otherJob]), status: "ready" }}
            />
        );

        expect(
            screen.queryByRole("dialog", { name: "Delete OpenClaw cron job" })
        ).not.toBeInTheDocument();
        expect(actions.onDelete).not.toHaveBeenCalled();
    });

    test("focuses the inventory heading after a confirmed deleted row disappears", async () => {
        const actions = callbacks();
        const otherJob = {
            ...job,
            id: "weekly-report",
            name: "Weekly report",
        } satisfies OpenClawCronJob;
        const rendered = render(
            <OpenClawCronSectionView
                {...actions}
                state={{ result: resultWithJobs([job, otherJob]), status: "ready" }}
            />
        );
        actions.onDelete.mockImplementation(() => {
            rendered.rerender(
                <OpenClawCronSectionView
                    {...actions}
                    state={{
                        result: resultWithJobs([otherJob]),
                        status: "ready",
                    }}
                />
            );
            return Promise.resolve();
        });

        await userEvent.click(screen.getByRole("button", { name: "Delete" }));
        await userEvent.click(
            within(
                screen.getByRole("dialog", {
                    name: "Delete OpenClaw cron job",
                })
            ).getByRole("button", { name: "Delete" })
        );

        expect(
            screen.queryByRole("button", { name: "Nightly report" })
        ).not.toBeInTheDocument();
        await waitFor(() =>
            expect(
                screen.getByRole("heading", { level: 2, name: "OpenClaw cron" })
            ).toHaveFocus()
        );
    });

    test("keeps raw action failures inside the classified presentation boundary", async () => {
        const actions = callbacks();
        actions.onRun.mockImplementation(() =>
            Promise.reject(new Error("raw Gateway transport detail"))
        );
        render(
            <OpenClawCronSectionView
                {...actions}
                runs={runs}
                state={{ result: result(), status: "ready" }}
            />
        );
        await userEvent.click(screen.getByRole("button", { name: "Run now" }));
        const dialog = screen.getByRole("dialog", { name: "Run OpenClaw cron job" });
        await userEvent.click(within(dialog).getByRole("button", { name: "Run now" }));
        expect(
            await screen.findByText(
                "The OpenClaw cron action failed. Refresh and try again."
            )
        ).toBeVisible();
        expect(
            screen.queryByText("raw Gateway transport detail")
        ).not.toBeInTheDocument();
    });

    test("blocks retries until an indeterminate run receives a successful authoritative refresh", async () => {
        const actions = callbacks();
        const automaticRefresh = deferredBoolean();
        const onReconcile = mock(() => automaticRefresh.promise);
        actions.onRun.mockImplementation(() => Promise.reject(unknownOutcomeError()));
        render(
            <OpenClawCronSectionView
                {...actions}
                onReconcile={onReconcile}
                runs={runs}
                state={{ result: result(), status: "ready" }}
            />
        );

        const trigger = screen.getByRole("button", { name: "Run now" });
        await userEvent.click(trigger);
        const dialog = screen.getByRole("dialog", { name: "Run OpenClaw cron job" });
        const confirm = within(dialog).getByRole("button", { name: "Run now" });
        await userEvent.click(confirm);
        await waitFor(() => expect(onReconcile).toHaveBeenCalledTimes(1));
        expect(actions.onRun).toHaveBeenCalledTimes(1);
        expect(confirm).toBeDisabled();
        fireEvent.click(confirm);
        expect(actions.onRun).toHaveBeenCalledTimes(1);

        automaticRefresh.reject(new Error("private refresh diagnostic"));

        const alert = await within(dialog).findByRole("alert");
        expect(alert).toHaveTextContent(
            "The OpenClaw cron outcome could not be confirmed. Refresh before retrying. The authoritative refresh failed; refresh successfully before another control."
        );
        await waitFor(() => expect(alert).toHaveFocus());
        expect(confirm).toBeDisabled();
        expect(
            screen.queryByText("The OpenClaw cron action failed. Refresh and try again.")
        ).not.toBeInTheDocument();
        expect(screen.queryByText(/private/u)).not.toBeInTheDocument();

        onReconcile.mockImplementation(() => Promise.resolve(true));
        await userEvent.click(
            within(dialog).getByRole("button", {
                name: "Refresh authoritative state",
            })
        );
        await waitFor(() =>
            expect(
                screen.queryByRole("dialog", { name: "Run OpenClaw cron job" })
            ).not.toBeInTheDocument()
        );
        expect(onReconcile).toHaveBeenCalledTimes(2);
        expect(actions.onRun).toHaveBeenCalledTimes(1);
        await waitFor(() => expect(trigger).toHaveFocus());
    });

    test("closes an indeterminate confirmation only after automatic reconciliation succeeds", async () => {
        const actions = callbacks();
        const onReconcile = mock(() => Promise.resolve(true));
        actions.onRun.mockImplementation(() => Promise.reject(unknownOutcomeError()));
        render(
            <OpenClawCronSectionView
                {...actions}
                onReconcile={onReconcile}
                runs={runs}
                state={{ result: result(), status: "ready" }}
            />
        );

        await userEvent.click(screen.getByRole("button", { name: "Run now" }));
        await userEvent.click(
            within(
                screen.getByRole("dialog", { name: "Run OpenClaw cron job" })
            ).getByRole("button", { name: "Run now" })
        );

        await waitFor(() =>
            expect(
                screen.queryByRole("dialog", { name: "Run OpenClaw cron job" })
            ).not.toBeInTheDocument()
        );
        expect(actions.onRun).toHaveBeenCalledTimes(1);
        expect(onReconcile).toHaveBeenCalledTimes(1);
        expect(
            screen.getByText(
                "The OpenClaw cron outcome was uncertain. Authoritative data was refreshed; review the current state before another action."
            )
        ).toBeVisible();
    });

    test("does not label a known pre-dispatch precondition failure as unknown", async () => {
        const actions = callbacks();
        actions.onRun.mockImplementation(() =>
            Promise.reject(
                Object.assign(new Error("private stale preflight detail"), {
                    data: { code: "PRECONDITION_FAILED" },
                })
            )
        );
        render(
            <OpenClawCronSectionView
                {...actions}
                runs={runs}
                state={{ result: result(), status: "ready" }}
            />
        );

        await userEvent.click(screen.getByRole("button", { name: "Run now" }));
        await userEvent.click(
            within(
                screen.getByRole("dialog", { name: "Run OpenClaw cron job" })
            ).getByRole("button", { name: "Run now" })
        );

        expect(
            await screen.findByText(
                "The OpenClaw cron action failed. Refresh and try again."
            )
        ).toBeVisible();
        expect(
            screen.queryByText(
                "The OpenClaw cron outcome could not be confirmed. Refresh before retrying."
            )
        ).not.toBeInTheDocument();
        expect(
            screen.queryByText("private stale preflight detail")
        ).not.toBeInTheDocument();
    });

    test("collects a reason and optional expiry before disabling", async () => {
        const actions = callbacks();
        render(
            <OpenClawCronSectionView
                {...actions}
                runs={runs}
                state={{ result: result(), status: "ready" }}
            />
        );
        await userEvent.click(screen.getByRole("button", { name: "Disable" }));
        const dialog = screen.getByRole("dialog", { name: "Disable Nightly report" });
        await userEvent.type(
            within(dialog).getByRole("textbox", { name: "Disable reason" }),
            "Gateway maintenance"
        );
        await userEvent.click(
            within(dialog).getByRole("button", { name: "Save disabled state" })
        );
        await waitFor(() =>
            expect(actions.onSetEnabled).toHaveBeenCalledWith(job, false, {
                reason: "Gateway maintenance",
            })
        );
    });

    test("gates another disable dispatch after an indeterminate outcome", async () => {
        const actions = callbacks();
        let refreshFails = true;
        const onReconcile = mock(() =>
            refreshFails
                ? Promise.reject(new Error("private refresh diagnostic"))
                : Promise.resolve(true)
        );
        actions.onSetEnabled.mockImplementation(() =>
            Promise.reject(unknownOutcomeError())
        );
        render(
            <OpenClawCronSectionView
                {...actions}
                onReconcile={onReconcile}
                runs={runs}
                state={{ result: result(), status: "ready" }}
            />
        );

        await userEvent.click(screen.getByRole("button", { name: "Disable" }));
        const dialog = screen.getByRole("dialog", { name: "Disable Nightly report" });
        await userEvent.type(
            within(dialog).getByRole("textbox", { name: "Disable reason" }),
            "Gateway maintenance"
        );
        const save = within(dialog).getByRole("button", {
            name: "Save disabled state",
        });
        await userEvent.click(save);

        expect(
            await within(dialog).findByText(/authoritative refresh failed/u)
        ).toBeVisible();
        expect(save).toBeDisabled();
        fireEvent.click(save);
        expect(actions.onSetEnabled).toHaveBeenCalledTimes(1);

        refreshFails = false;
        await userEvent.click(
            within(dialog).getByRole("button", {
                name: "Refresh authoritative state",
            })
        );
        await waitFor(() =>
            expect(
                screen.queryByRole("dialog", { name: "Disable Nightly report" })
            ).not.toBeInTheDocument()
        );
        expect(onReconcile).toHaveBeenCalledTimes(2);
        expect(actions.onSetEnabled).toHaveBeenCalledTimes(1);
    });

    test("shows the exact Dashboard-owned open task before disabling", async () => {
        const actions = callbacks();
        const linkedJob = {
            ...job,
            dashboardOpenLinkedTask: {
                id: "019fd984-63e8-7404-a7da-80c6f243794f",
                status: "blocked",
                title: "Resolve delivery dependency",
            },
        } satisfies OpenClawCronJob;
        render(
            <OpenClawCronSectionView
                {...actions}
                state={{ result: resultWithJobs([linkedJob]), status: "ready" }}
            />
        );

        await userEvent.click(screen.getByRole("button", { name: "Disable" }));
        const dialog = screen.getByRole("dialog", { name: "Disable Nightly report" });
        expect(within(dialog).getByText("Dashboard open linked task")).toBeVisible();
        expect(within(dialog).getByText("Resolve delivery dependency")).toBeVisible();
        expect(
            within(dialog).getByText(/comes from the Dashboard task database/u)
        ).toBeVisible();
    });

    test("rejects unreviewed fields in the JSON editor", async () => {
        const actions = callbacks();
        render(
            <OpenClawCronSectionView
                {...actions}
                runs={runs}
                state={{ result: result(), status: "ready" }}
            />
        );
        await userEvent.click(
            screen.getByRole("button", { name: "Edit reviewed fields" })
        );
        const dialog = screen.getByRole("dialog", { name: "Edit Nightly report" });
        const editor = within(dialog).getByRole("textbox", {
            name: "Reviewed definition and delivery JSON",
        });
        await userEvent.clear(editor);
        fireEvent.change(editor, { target: { value: '{"enabled":false}' } });
        expect(
            within(dialog)
                .getByRole("button", { name: "Save reviewed fields" })
                .hasAttribute("disabled")
        ).toBeTrue();
        expect(
            within(dialog).getByText(
                /Only name, description, delivery, at\/every\/cron schedule/u
            )
        ).toBeVisible();
        expect(actions.onUpdate).not.toHaveBeenCalled();
    });

    test("gates another definition update after an indeterminate outcome", async () => {
        const actions = callbacks();
        let refreshFails = true;
        const onReconcile = mock(() =>
            refreshFails
                ? Promise.reject(new Error("private refresh diagnostic"))
                : Promise.resolve(true)
        );
        actions.onUpdate.mockImplementation(() => Promise.reject(unknownOutcomeError()));
        render(
            <OpenClawCronSectionView
                {...actions}
                onReconcile={onReconcile}
                runs={runs}
                state={{ result: result(), status: "ready" }}
            />
        );

        await userEvent.click(
            screen.getByRole("button", { name: "Edit reviewed fields" })
        );
        const dialog = screen.getByRole("dialog", { name: "Edit Nightly report" });
        fireEvent.change(
            within(dialog).getByRole("textbox", {
                name: "Reviewed definition and delivery JSON",
            }),
            { target: { value: JSON.stringify({ name: "Nightly renamed" }) } }
        );
        const save = within(dialog).getByRole("button", {
            name: "Save reviewed fields",
        });
        await userEvent.click(save);

        expect(
            await within(dialog).findByText(/authoritative refresh failed/u)
        ).toBeVisible();
        expect(save).toBeDisabled();
        fireEvent.click(save);
        expect(actions.onUpdate).toHaveBeenCalledTimes(1);

        refreshFails = false;
        await userEvent.click(
            within(dialog).getByRole("button", {
                name: "Refresh authoritative state",
            })
        );
        await waitFor(() =>
            expect(
                screen.queryByRole("dialog", { name: "Edit Nightly report" })
            ).not.toBeInTheDocument()
        );
        expect(onReconcile).toHaveBeenCalledTimes(2);
        expect(actions.onUpdate).toHaveBeenCalledTimes(1);
    });

    test("keeps validated LKG data visible beside a background failure", () => {
        const actions = callbacks();
        render(
            <OpenClawCronSectionView
                {...actions}
                backgroundError="OpenClaw refresh failed."
                runs={runs}
                state={{
                    result: result({
                        kind: "last-known-good",
                        observedAtMs: 1_800_001_000_000,
                        staleSinceMs: 1_800_002_000_000,
                    }),
                    status: "ready",
                }}
            />
        );
        expect(screen.getByText("OpenClaw refresh failed.")).toBeVisible();
        expect(
            screen.getByText(/Showing last-known-good OpenClaw cron data/u)
        ).toBeVisible();
        expect(screen.getAllByText("Nightly report")).not.toHaveLength(0);
    });
});
