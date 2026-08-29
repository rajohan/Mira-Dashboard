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
        expect(
            screen.getByLabelText("Loading OpenClaw scheduled jobs…")
        ).toBeInTheDocument();

        rerender(
            <OpenClawCronSectionView
                {...actions}
                state={{ message: "OpenClaw Gateway is unavailable.", status: "error" }}
            />
        );
        await userEvent.click(screen.getByRole("button", { name: "Try again" }));
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
            screen.getByRole("heading", { level: 2, name: "OpenClaw scheduled jobs" })
        ).toHaveClass("sr-only");
        expect(
            screen.getByRole("list", { name: "OpenClaw scheduled jobs" })
        ).toBeVisible();
        expect(
            screen.getByRole("list", { name: "OpenClaw runs for Nightly report" })
        ).toBeVisible();
        expect(
            screen.getByText(
                "These runs belong to OpenClaw and are separate from Dashboard background jobs."
            )
        ).toBeVisible();
        expect(screen.getByText("model-preview (shortened)")).toBeVisible();
        expect(screen.getByText("provider-preview (shortened)")).toBeVisible();
        expect(
            screen.queryByRole("button", { name: "Refresh OpenClaw" })
        ).not.toBeInTheDocument();
    });

    test("shows heartbeat instructions and presents wake-request history without empty agent fields", () => {
        const actions = callbacks();
        const heartbeatJob = {
            ...job,
            payload: { kind: "heartbeat" },
            scratch: {
                content: "Collect the bounded ops snapshot and post one report.",
                revision: 5,
                truncated: false,
            },
        } satisfies OpenClawCronJob;
        render(
            <OpenClawCronSectionView
                {...actions}
                heartbeatSession={{
                    displayName: "Ops heartbeat",
                    hasActiveRun: false,
                    key: "agent:ops:main:heartbeat",
                    kind: "main",
                    model: "kimi",
                    modelProvider: "openai",
                    thinkingDefault: "high",
                    totalTokens: 12_345,
                    totalTokensFresh: true,
                    updatedAtMs: 1_800_010_000_000,
                }}
                runs={{
                    ...runs,
                    runs: runs.runs.map(({ model, provider, ...run }) => {
                        void model;
                        void provider;
                        return run;
                    }),
                }}
                state={{ result: resultWithJobs([heartbeatJob]), status: "ready" }}
            />
        );

        expect(screen.getByText("Message")).toBeVisible();
        expect(
            screen.getByText("Collect the bounded ops snapshot and post one report.")
        ).toBeVisible();
        expect(screen.getAllByText("Model")).toHaveLength(2);
        expect(screen.getAllByText("Provider")).toHaveLength(2);
        expect(screen.getByText("Thinking")).toBeVisible();
        expect(screen.getByText("high")).toBeVisible();
        expect(screen.getByText("Timeout")).toBeVisible();
        const history = screen.getByRole("list", {
            name: `OpenClaw runs for ${heartbeatJob.name}`,
        });
        expect(within(history).getByText("Completed")).toBeVisible();
        expect(within(history).getByText("Model")).toBeVisible();
        expect(within(history).getByText("Provider")).toBeVisible();
        expect(within(history).getByText("Delivery")).toBeVisible();
        expect(within(history).getByText("Report delivered.")).toBeVisible();
        expect(within(history).getAllByText("—")).toHaveLength(2);
    });

    test("does not present heartbeat session settings as defaults before observation", () => {
        const heartbeatJob = {
            ...job,
            payload: { kind: "heartbeat" },
        } satisfies OpenClawCronJob;

        render(
            <OpenClawCronSectionView
                {...callbacks()}
                heartbeatSessionStatus="unavailable"
                state={{ result: resultWithJobs([heartbeatJob]), status: "ready" }}
            />
        );

        expect(screen.getAllByText("Unavailable")).toHaveLength(3);
    });

    test("uses mobile-first cards and desktop grids without horizontal scrolling or field loss", async () => {
        const actions = callbacks();
        const longJobId = `cron-${"i".repeat(251)}`;
        const longName = `Responsive ${"n".repeat(245)}`;
        const longModel = "m".repeat(256);
        const longProvider = "p".repeat(128);
        const longSummary = "s".repeat(1000);
        const responsiveJob = {
            ...job,
            id: longJobId,
            name: longName,
        } satisfies OpenClawCronJob;
        const responsiveRuns = {
            ...runs,
            runs: [
                {
                    ...runs.runs[0],
                    jobId: longJobId,
                    model: longModel,
                    modelTruncated: false,
                    provider: longProvider,
                    providerTruncated: false,
                    summary: longSummary,
                },
            ],
        } satisfies ListOpenClawCronRunsResult;

        render(
            <OpenClawCronSectionView
                {...actions}
                runs={responsiveRuns}
                state={{ result: resultWithJobs([responsiveJob]), status: "ready" }}
            />
        );

        const section = screen.getByRole("region", { name: "OpenClaw scheduled jobs" });
        const inventory = within(section).getByRole("list", {
            name: "OpenClaw scheduled jobs",
        });
        const history = within(section).getByRole("list", {
            name: `OpenClaw runs for ${longName}`,
        });
        expect(inventory).toHaveClass("relative", "w-full");
        expect(inventory.parentElement).toHaveClass(
            "h-full",
            "max-h-128",
            "xl:max-h-none"
        );
        expect(history).toHaveClass("relative", "min-w-0", "max-w-full");
        expect(history.querySelector("dl")).toHaveClass(
            "sm:grid-cols-2",
            "lg:grid-cols-3"
        );
        expect(
            [...section.querySelectorAll<HTMLElement>("*")].some((element) =>
                /(?:^|\s)overflow-x-(?:auto|scroll)(?:\s|$)/u.test(element.className)
            )
        ).toBe(false);
        expect(section.querySelector(".min-w-224, .min-w-240")).toBeNull();

        for (const label of ["Last:", "Next:"]) {
            expect(within(inventory).getByText(label)).toBeVisible();
        }
        expect(within(inventory).getByLabelText("Last status: Succeeded")).toBeVisible();
        for (const label of [
            "Completed",
            "Status",
            "Delivery",
            "Duration",
            "Model",
            "Provider",
            "Summary",
        ]) {
            expect(within(history).getByText(label)).toBeVisible();
        }
        expect(within(inventory).getByText(longJobId)).toHaveClass("truncate");
        const detailHeading = within(section).getByRole("heading", {
            level: 3,
            name: longName,
        });
        const identity = detailHeading.parentElement;
        const detailHeader = identity?.parentElement;
        expect(identity).toHaveClass("w-full", "min-w-0", "sm:flex-1");
        expect(detailHeader).toHaveClass(
            "min-w-0",
            "flex-col",
            "sm:flex-row",
            "sm:justify-between"
        );
        const statusGroup = within(section).getByRole("region", {
            name: "Scheduled job status",
        });
        expect(statusGroup).toHaveClass(
            "w-full",
            "min-w-0",
            "flex-wrap",
            "sm:w-auto",
            "sm:shrink-0"
        );
        for (const badge of statusGroup.children) {
            expect(badge).toHaveClass("shrink-0", "whitespace-nowrap");
        }
        const definition = detailHeader?.parentElement?.querySelector("dl");
        expect(definition).toHaveClass("grid-cols-1", "sm:grid-cols-2", "lg:grid-cols-3");
        const actionGroup = within(section).getByRole("toolbar", {
            name: "Scheduled job actions",
        });
        expect(actionGroup).toHaveClass("flex-col", "sm:flex-row", "sm:flex-wrap");
        for (const action of within(actionGroup).getAllByRole("button")) {
            expect(action).toHaveClass("w-full", "sm:w-auto");
        }
        expect(within(history).getByText(longModel)).toHaveClass("wrap-anywhere");
        expect(within(history).getByText(longProvider)).toHaveClass("wrap-anywhere");
        expect(within(history).getByText(longSummary)).toHaveClass("wrap-anywhere");

        await userEvent.click(within(section).getByRole("button", { name: "Run now" }));
        const dialog = screen.getByRole("dialog", { name: "Run OpenClaw scheduled job" });
        const description = within(dialog).getByText(
            `Run ${longName} in OpenClaw now? This is separate from Dashboard background jobs.`
        );
        expect(description).toHaveClass("wrap-anywhere");
        const cancel = within(dialog).getByRole("button", { name: "Cancel" });
        expect(cancel.parentElement).toHaveClass(
            "flex-col",
            "sm:flex-row",
            "sm:flex-wrap"
        );
        for (const button of within(cancel.parentElement!).getAllByRole("button")) {
            expect(button).toHaveClass("w-full", "sm:w-auto");
        }
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
                "Some details were shortened or hidden. Hidden fields will not be changed when you edit this job."
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

        const cards = within(
            screen.getByRole("list", { name: "OpenClaw scheduled jobs" })
        ).getAllByRole("listitem");
        expect(cards.map((card) => card.textContent)).toEqual([
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
        const dialog = screen.getByRole("dialog", { name: "Run OpenClaw scheduled job" });
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
            screen.getByRole("dialog", { name: "Delete OpenClaw scheduled job" })
        ).toHaveTextContent("Nightly report");

        rerender(
            <OpenClawCronSectionView
                {...actions}
                state={{ result: resultWithJobs([otherJob]), status: "ready" }}
            />
        );

        expect(
            screen.queryByRole("dialog", { name: "Delete OpenClaw scheduled job" })
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
                    name: "Delete OpenClaw scheduled job",
                })
            ).getByRole("button", { name: "Delete" })
        );

        expect(
            screen.queryByRole("button", { name: "Nightly report" })
        ).not.toBeInTheDocument();
        await waitFor(() =>
            expect(
                screen.getByRole("heading", { level: 2, name: "OpenClaw scheduled jobs" })
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
        const dialog = screen.getByRole("dialog", { name: "Run OpenClaw scheduled job" });
        await userEvent.click(within(dialog).getByRole("button", { name: "Run now" }));
        expect(
            await screen.findByText("The OpenClaw action failed. Refresh and try again.")
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
        const dialog = screen.getByRole("dialog", { name: "Run OpenClaw scheduled job" });
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
            "Dashboard could not confirm whether OpenClaw completed the action. Refresh the current status before trying again. The refresh also failed, so actions remain unavailable."
        );
        await waitFor(() => expect(alert).toHaveFocus());
        expect(confirm).toBeDisabled();
        expect(
            screen.queryByText("The OpenClaw action failed. Refresh and try again.")
        ).not.toBeInTheDocument();
        expect(screen.queryByText(/private/u)).not.toBeInTheDocument();

        onReconcile.mockImplementation(() => Promise.resolve(true));
        const refresh = within(dialog).getByRole("button", {
            name: "Refresh current status",
        });
        expect(refresh.parentElement).toHaveClass(
            "flex-col",
            "sm:flex-row",
            "sm:flex-wrap"
        );
        for (const button of within(refresh.parentElement!).getAllByRole("button")) {
            expect(button).toHaveClass("w-full", "sm:w-auto");
        }
        await userEvent.click(refresh);
        await waitFor(() =>
            expect(
                screen.queryByRole("dialog", { name: "Run OpenClaw scheduled job" })
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
                screen.getByRole("dialog", { name: "Run OpenClaw scheduled job" })
            ).getByRole("button", { name: "Run now" })
        );

        await waitFor(() =>
            expect(
                screen.queryByRole("dialog", { name: "Run OpenClaw scheduled job" })
            ).not.toBeInTheDocument()
        );
        expect(actions.onRun).toHaveBeenCalledTimes(1);
        expect(onReconcile).toHaveBeenCalledTimes(1);
        expect(
            screen.getByText(
                "Dashboard could not confirm the result, so it refreshed the current OpenClaw status. Check the status before taking another action."
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
                screen.getByRole("dialog", { name: "Run OpenClaw scheduled job" })
            ).getByRole("button", { name: "Run now" })
        );

        expect(
            await screen.findByText("The OpenClaw action failed. Refresh and try again.")
        ).toBeVisible();
        expect(
            screen.queryByText(
                "Dashboard could not confirm whether OpenClaw completed the action. Refresh the current status before trying again."
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
        expect(
            within(dialog).getByRole("radio", { name: /Indefinitely/u })
        ).toBeChecked();
        expect(
            within(dialog).queryByRole("group", { name: "Disabled until" })
        ).not.toBeInTheDocument();
        expect(
            within(dialog).getByRole("textbox", { name: "Disable reason" })
        ).toHaveAttribute("placeholder", "Paused during database maintenance");
        await userEvent.type(
            within(dialog).getByRole("textbox", { name: "Disable reason" }),
            "Gateway maintenance"
        );
        await userEvent.click(
            within(dialog).getByRole("button", { name: "Disable job" })
        );
        await waitFor(() =>
            expect(actions.onSetEnabled).toHaveBeenCalledWith(job, false, {
                reason: "Gateway maintenance",
            })
        );
    });

    test("submits the shared picker as an exact browser-local future expiry", async () => {
        const actions = callbacks();
        render(
            <OpenClawCronSectionView
                {...actions}
                state={{ result: result(), status: "ready" }}
            />
        );
        const user = userEvent.setup();

        await user.click(screen.getByRole("button", { name: "Disable" }));
        const dialog = screen.getByRole("dialog", { name: "Disable Nightly report" });
        await user.click(within(dialog).getByRole("radio", { name: /Until a date/u }));
        const expiry = within(dialog).getByRole("group", {
            name: "Disabled until",
        });
        const selectedDateLabel = within(expiry)
            .getByRole("button", { name: /Choose Disabled until date, selected/u })
            .getAttribute("aria-label");
        const selectedDate =
            /selected (?<day>\d{2})\.(?<month>\d{2})\.(?<year>\d{4})/u.exec(
                selectedDateLabel ?? ""
            )?.groups;
        if (selectedDate === undefined) throw new Error("Missing local picker date");
        const hour = Number(
            within(expiry).getByRole("button", {
                name: "Time (24-hour), hour",
            }).textContent
        );
        const minute = Number(
            within(expiry).getByRole("button", {
                name: "Time (24-hour), minute",
            }).textContent
        );
        const expiresAtMs = new Date(
            Number(selectedDate.year),
            Number(selectedDate.month) - 1,
            Number(selectedDate.day),
            hour,
            minute
        ).getTime();
        expect(expiresAtMs).toBeGreaterThan(Date.now());

        await user.type(
            within(dialog).getByRole("textbox", { name: "Disable reason" }),
            "Temporary Gateway maintenance"
        );
        await user.click(within(dialog).getByRole("button", { name: "Disable job" }));
        await waitFor(() =>
            expect(actions.onSetEnabled).toHaveBeenCalledWith(job, false, {
                expiresAtMs,
                reason: "Temporary Gateway maintenance",
            })
        );
    });

    test("rejects a past shared-picker expiry and focuses its accessible error", async () => {
        const actions = callbacks();
        const expiredJob = {
            ...job,
            synchronization: {
                desiredEnabled: false,
                disableIntent: {
                    expiresAtMs: Date.now() - 60_000,
                    reason: "Expired maintenance window",
                    recordedAtMs: Date.now() - 120_000,
                    revision: "expired-intent",
                },
                state: "conflict",
            },
        } satisfies OpenClawCronJob;
        render(
            <OpenClawCronSectionView
                {...actions}
                state={{ result: resultWithJobs([expiredJob]), status: "ready" }}
            />
        );
        const user = userEvent.setup();

        await user.click(screen.getByRole("button", { name: "Disable" }));
        const dialog = screen.getByRole("dialog", { name: "Disable Nightly report" });
        const picker = within(dialog).getByRole("group", { name: "Disabled until" });
        const dateTrigger = within(picker).getByRole("button", {
            name: /Choose Disabled until date/u,
        });
        await user.click(within(dialog).getByRole("button", { name: "Disable job" }));

        const expiryError = within(dialog).getByText("Choose a future date and time.");
        expect(picker.getAttribute("aria-describedby")?.split(" ")).toContain(
            expiryError.id
        );
        expect(picker).toHaveAttribute("data-invalid");
        expect(actions.onSetEnabled).not.toHaveBeenCalled();
        await waitFor(() => expect(dateTrigger).toHaveFocus());
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
            name: "Disable job",
        });
        await userEvent.click(save);

        expect(await within(dialog).findByText(/refresh also failed/u)).toBeVisible();
        expect(save).toBeDisabled();
        fireEvent.click(save);
        expect(actions.onSetEnabled).toHaveBeenCalledTimes(1);

        refreshFails = false;
        await userEvent.click(
            within(dialog).getByRole("button", {
                name: "Refresh current status",
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
        expect(within(dialog).getByText("Linked Dashboard task")).toBeVisible();
        expect(within(dialog).getByText("Resolve delivery dependency")).toBeVisible();
        expect(
            within(dialog).getByText(/does not close this Dashboard task/u)
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
        await userEvent.click(screen.getByRole("button", { name: "Edit settings" }));
        const dialog = screen.getByRole("dialog", { name: "Edit Nightly report" });
        const editor = within(dialog).getByRole("textbox", {
            name: "Job settings (JSON)",
        });
        await userEvent.clear(editor);
        fireEvent.change(editor, { target: { value: '{"enabled":false}' } });
        expect(
            within(dialog)
                .getByRole("button", { name: "Save changes" })
                .hasAttribute("disabled")
        ).toBeTrue();
        expect(
            within(dialog).getByText(
                /You can edit only name, description, delivery, schedule, payload, scratch, and wakeMode/u
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

        await userEvent.click(screen.getByRole("button", { name: "Edit settings" }));
        const dialog = screen.getByRole("dialog", { name: "Edit Nightly report" });
        fireEvent.change(
            within(dialog).getByRole("textbox", {
                name: "Job settings (JSON)",
            }),
            { target: { value: JSON.stringify({ name: "Nightly renamed" }) } }
        );
        const save = within(dialog).getByRole("button", {
            name: "Save changes",
        });
        await userEvent.click(save);

        expect(await within(dialog).findByText(/refresh also failed/u)).toBeVisible();
        expect(save).toBeDisabled();
        fireEvent.click(save);
        expect(actions.onUpdate).toHaveBeenCalledTimes(1);

        refreshFails = false;
        await userEvent.click(
            within(dialog).getByRole("button", {
                name: "Refresh current status",
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
            screen.getByText(
                /The latest refresh failed, so the last available OpenClaw data is shown/u
            )
        ).toBeVisible();
        expect(screen.getAllByText("Nightly report")).not.toHaveLength(0);
    });
});
