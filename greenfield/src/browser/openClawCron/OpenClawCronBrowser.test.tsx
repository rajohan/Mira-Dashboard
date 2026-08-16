import { describe, expect, jest, test } from "bun:test";

import { QueryClientProvider } from "@tanstack/react-query";
import type { TRPCRequestOptions } from "@trpc/client";
import type { ComponentProps } from "react";

import type {
    ListOpenClawCronResult,
    ListOpenClawCronRunsResult,
    OpenClawCronJob,
} from "../../contracts/openClawCron.ts";
import { createDashboardQueryClient } from "../api/queryClient.ts";
import { DashboardRealtimeProvider } from "../api/realtimeContext.tsx";
import type { DashboardTrpcClient } from "../api/trpcClient.ts";
import { DashboardTrpcProvider } from "../api/trpcContext.tsx";
import { authStatusQueryKey } from "../auth/authQueries.ts";
import { ControlledDashboardRealtimeClient } from "../test/realtime.ts";
import { OpenClawCronBrowser } from "./OpenClawCronBrowser.tsx";
import { OpenClawCronDefinitionDialog } from "./OpenClawCronDefinitionDialog.tsx";
import {
    accumulateOpenClawCronInventoryPages,
    accumulateOpenClawCronRunPages,
    openClawCronInventoryInput,
    openClawCronQueryKey,
} from "./openClawCronQueries.ts";
import {
    openClawCronPatchJson,
    openClawCronOperationalStatus,
    parseOpenClawCronPatchJson,
} from "./presentation.ts";

const { act, fireEvent, render, screen, waitFor, within } =
    await import("@testing-library/react");
const userEventModule = await import("@testing-library/user-event");
const userEvent = userEventModule.default;

const timestampMs = 1_800_000_000_000;

function job(id: string, name: string, enabled: boolean): OpenClawCronJob {
    return {
        agentIdTruncated: false,
        configRevision: `${id}-revision`,
        createdAtMs: timestampMs - 1000,
        delivery: {
            accountId: "operations",
            bestEffort: true,
            channel: "slack",
            completionDestinationConfigured: true,
            failureDestination: {
                accountId: "alerts",
                mode: "webhook",
                targetConfigured: true,
            },
            metadataTruncated: false,
            mode: "announce",
            targetConfigured: true,
            threadId: "daily-report",
        },
        deliveryMode: "announce",
        descriptionTruncated: false,
        enabled,
        id,
        name,
        nameTruncated: false,
        payload: {
            kind: "agent-turn",
            message: `Run ${name}`,
            truncated: false,
        },
        schedule: { everyMs: 60_000, kind: "every", truncated: false },
        sessionTarget: "isolated",
        source: "openclaw",
        state: { nextRunAtMs: timestampMs + 60_000 },
        synchronization: { state: "confirmed" },
        updatedAtMs: timestampMs,
        wakeMode: "now",
    };
}

const disabledAlpha = job("alpha-disabled", "Alpha", false);
const enabledBeta = job("beta-enabled", "Beta", true);
const inventory: ListOpenClawCronResult = {
    freshness: { kind: "fresh", observedAtMs: timestampMs },
    hasMore: false,
    jobs: [disabledAlpha, enabledBeta],
    limit: 100,
    offset: 0,
    snapshotRevision: `sha256:${"A".repeat(43)}`,
    total: 2,
};
const emptyRuns: ListOpenClawCronRunsResult = {
    freshness: { kind: "fresh", observedAtMs: timestampMs },
    hasMore: false,
    limit: 100,
    offset: 0,
    runs: [],
    total: 0,
};

function runPage(
    offset: number,
    runId: string,
    summary: string
): ListOpenClawCronRunsResult {
    return {
        freshness: { kind: "fresh", observedAtMs: timestampMs },
        hasMore: offset === 0,
        limit: 100,
        ...(offset === 0 ? { nextOffset: 1 } : {}),
        offset,
        runs: [
            {
                completedAtMs: timestampMs - offset * 1000,
                deliveryStatus: "delivered",
                jobId: enabledBeta.id,
                modelTruncated: false,
                providerTruncated: false,
                runId,
                status: "ok",
                summary,
                summaryTruncated: false,
            },
        ],
        total: 2,
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

function renderBrowser(
    client: DashboardTrpcClient,
    properties: ComponentProps<typeof OpenClawCronBrowser> = {}
) {
    const queryClient = createDashboardQueryClient();
    const realtimeClient = new ControlledDashboardRealtimeClient();
    const view = render(
        <QueryClientProvider client={queryClient}>
            <DashboardTrpcProvider client={client}>
                <DashboardRealtimeProvider client={realtimeClient}>
                    <OpenClawCronBrowser {...properties} />
                </DashboardRealtimeProvider>
            </DashboardTrpcProvider>
        </QueryClientProvider>
    );
    return { queryClient, realtimeClient, view };
}

describe("OpenClaw scheduled jobs browser", () => {
    test("presents running, disabled, last-run, and scheduled status in priority order", () => {
        expect(
            openClawCronOperationalStatus({
                ...disabledAlpha,
                state: { lastRunStatus: "error", runningAtMs: timestampMs },
            })
        ).toEqual({ label: "Running", variant: "warning" });
        expect(
            openClawCronOperationalStatus({
                ...disabledAlpha,
                state: { lastRunStatus: "ok" },
            })
        ).toEqual({ label: "Disabled", variant: "default" });
        expect(
            openClawCronOperationalStatus({
                ...enabledBeta,
                state: { lastRunStatus: "ok" },
            })
        ).toEqual({ label: "Succeeded", variant: "success" });
        expect(
            openClawCronOperationalStatus({
                ...enabledBeta,
                state: { lastRunStatus: "error" },
            })
        ).toEqual({ label: "Failed", variant: "danger" });
        expect(openClawCronOperationalStatus(enabledBeta)).toEqual({
            label: "Scheduled",
            variant: "default",
        });
    });

    test("validates the full delivery patch inline and disables Save until valid", async () => {
        const onClose = jest.fn();
        const onSubmit = jest.fn(() => Promise.resolve());
        const view = render(
            <OpenClawCronDefinitionDialog
                job={enabledBeta}
                onClose={onClose}
                onSubmit={onSubmit}
            />
        );
        const user = userEvent.setup();

        try {
            const editor = screen.getByRole("dialog", { name: "Edit Beta" });
            const textarea = within(editor).getByRole("textbox", {
                name: "Job settings (JSON)",
            });
            const save = within(editor).getByRole("button", {
                name: "Save changes",
            });
            expect(within(editor).getByText("Change at least one field.")).toBeTruthy();
            expect(save.hasAttribute("disabled")).toBeTrue();
            expect((textarea as HTMLTextAreaElement).value).not.toContain('"delivery"');

            fireEvent.change(textarea, { target: { value: "{" } });
            expect(within(editor).getByText("Enter valid JSON.")).toBeTruthy();
            expect(save.hasAttribute("disabled")).toBeTrue();

            fireEvent.change(textarea, {
                target: {
                    value: JSON.stringify({
                        delivery: { bestEffort: null },
                    }),
                },
            });
            expect(
                within(editor).getByText(/Delivery supports none, announce, or webhook/u)
            ).toBeTruthy();
            expect(save.hasAttribute("disabled")).toBeTrue();

            const deliveryPatch = {
                accountId: null,
                bestEffort: false,
                channel: null,
                completionDestination: null,
                failureDestination: {
                    accountId: null,
                    channel: null,
                    mode: null,
                    to: null,
                },
                mode: "announce" as const,
                threadId: null,
                to: null,
            };
            fireEvent.change(textarea, {
                target: { value: JSON.stringify({ delivery: deliveryPatch }) },
            });
            expect(save.hasAttribute("disabled")).toBeFalse();
            await user.click(save);
            await waitFor(() =>
                expect(onSubmit).toHaveBeenCalledWith({ delivery: deliveryPatch })
            );
            expect(onClose).toHaveBeenCalledTimes(1);
        } finally {
            view.unmount();
        }
    });

    test("omits incomplete projected fields and submits only an unrelated rename", async () => {
        const onSubmit = jest.fn(() => Promise.resolve());
        const incompleteJob: OpenClawCronJob = {
            ...enabledBeta,
            description: "bounded description",
            descriptionTruncated: true,
            nameTruncated: true,
            payload: {
                kind: "agent-turn",
                message: "bounded prompt",
                truncated: true,
            },
            schedule: {
                expr: "0 7 * * *",
                kind: "cron",
                truncated: true,
            },
        };
        const view = render(
            <OpenClawCronDefinitionDialog
                job={incompleteJob}
                onClose={() => {}}
                onSubmit={onSubmit}
            />
        );
        const user = userEvent.setup();

        try {
            const dialog = screen.getByRole("dialog", { name: "Edit Beta" });
            const editor = within(dialog).getByRole<HTMLTextAreaElement>("textbox", {
                name: "Job settings (JSON)",
            });
            expect(JSON.parse(editor.value)).toEqual({ wakeMode: "now" });

            fireEvent.change(editor, {
                target: {
                    value: JSON.stringify({
                        name: "Beta renamed",
                        wakeMode: "now",
                    }),
                },
            });
            await user.click(
                within(dialog).getByRole("button", {
                    name: "Save changes",
                })
            );
            await waitFor(() =>
                expect(onSubmit).toHaveBeenCalledWith({ name: "Beta renamed" })
            );
        } finally {
            view.unmount();
        }
    });

    test("requires a replacement target for every effective webhook clear or switch", () => {
        expect(
            parseOpenClawCronPatchJson(
                JSON.stringify({ delivery: { mode: "webhook" } }),
                enabledBeta
            )
        ).toMatchObject({ success: false });
        expect(
            parseOpenClawCronPatchJson(
                JSON.stringify({ delivery: { mode: "webhook", to: null } }),
                enabledBeta
            )
        ).toMatchObject({ success: false });

        const existingWebhook: OpenClawCronJob = {
            ...enabledBeta,
            delivery: {
                bestEffort: true,
                completionDestinationConfigured: false,
                metadataTruncated: false,
                mode: "webhook",
                targetConfigured: true,
            },
            deliveryMode: "webhook",
        };
        expect(
            parseOpenClawCronPatchJson(
                JSON.stringify({ delivery: { to: null } }),
                existingWebhook
            )
        ).toMatchObject({ success: false });
        expect(
            parseOpenClawCronPatchJson(
                JSON.stringify({ delivery: { bestEffort: false } }),
                existingWebhook
            )
        ).toMatchObject({
            patch: { delivery: { bestEffort: false } },
            success: true,
        });
        expect(
            parseOpenClawCronPatchJson(
                JSON.stringify({
                    delivery: {
                        mode: "webhook",
                        to: "https://replacement.example.test/hook",
                    },
                }),
                enabledBeta
            )
        ).toMatchObject({ success: true });
    });

    test("shows heartbeat scratch in JSON and emits only its changed field", () => {
        const heartbeat: OpenClawCronJob = {
            ...enabledBeta,
            payload: { kind: "heartbeat" },
            scratch: {
                content: "Check services",
                revision: 4,
                truncated: false,
            },
        };

        expect(JSON.parse(openClawCronPatchJson(heartbeat))).toMatchObject({
            scratch: "Check services",
        });
        expect(
            parseOpenClawCronPatchJson(
                JSON.stringify({
                    ...JSON.parse(openClawCronPatchJson(heartbeat)),
                    scratch: "Check services and disk",
                }),
                heartbeat
            )
        ).toEqual({
            patch: { scratch: "Check services and disk" },
            success: true,
        });
    });

    test("locks the bounded inventory and loads runs for the enabled-first selection", async () => {
        const calls: Array<{
            input: unknown;
            name: string;
            signal: AbortSignal | undefined;
        }> = [];
        const client = {
            query(name: string, input: unknown, options?: TRPCRequestOptions) {
                calls.push({ input, name, signal: options?.signal });
                return Promise.resolve(
                    name === "openClawCron.list" ? inventory : emptyRuns
                );
            },
        } as unknown as DashboardTrpcClient;
        const rendered = renderBrowser(client);

        try {
            expect(
                await screen.findByRole("heading", { level: 3, name: "Beta" })
            ).toBeTruthy();
            await waitFor(() => expect(calls).toHaveLength(2));
            expect(calls.map(({ input, name }) => ({ input, name }))).toEqual([
                { input: openClawCronInventoryInput, name: "openClawCron.list" },
                {
                    input: {
                        id: enabledBeta.id,
                        limit: 100,
                        offset: 0,
                        sortDir: "desc",
                    },
                    name: "openClawCron.listRuns",
                },
            ]);
            expect(calls.every(({ signal }) => signal instanceof AbortSignal)).toBeTrue();
        } finally {
            rendered.view.unmount();
            rendered.queryClient.clear();
        }
    });

    test("honors controlled selection from the full card hit target and keyboard", async () => {
        const onSelectedJobChange = jest.fn();
        const client = {
            query: (name: string) =>
                Promise.resolve(name === "openClawCron.list" ? inventory : emptyRuns),
        } as unknown as DashboardTrpcClient;
        const rendered = renderBrowser(client, {
            onSelectedJobChange,
            selectedJobId: disabledAlpha.id,
        });
        const user = userEvent.setup();

        try {
            expect(
                await screen.findByRole("heading", { level: 3, name: "Alpha" })
            ).toBeTruthy();
            const selectedCardTarget = screen.getByRole("button", { name: "Alpha" });
            const nextCardTarget = screen.getByRole("button", { name: "Beta" });
            expect(selectedCardTarget).toHaveAttribute("aria-current", "true");
            expect(selectedCardTarget).toHaveAttribute("aria-pressed", "true");
            expect(nextCardTarget).toHaveAttribute("aria-pressed", "false");
            const selectedCard = selectedCardTarget.closest("li");
            const nextCard = nextCardTarget.closest("li");
            expect(selectedCard).toHaveClass(
                "border-accent-400",
                "bg-accent-500/20",
                "ring-accent-300/40",
                "ring-1",
                "ring-inset"
            );
            expect(selectedCard).toHaveTextContent("Selected");
            expect(nextCard).toHaveClass("border-primary-700", "bg-primary-900/40");
            expect(nextCard).not.toHaveClass("bg-accent-500/20");
            expect(nextCard).not.toHaveTextContent("Selected");
            expect(nextCardTarget).toHaveClass("absolute", "inset-0");
            expect(nextCardTarget.querySelector("dl")).toBeNull();
            expect(nextCardTarget.closest("li")?.querySelector("dl")).not.toBeNull();

            await user.hover(nextCardTarget);
            expect(nextCard).toHaveClass("border-primary-500", "bg-primary-800/55");
            expect(selectedCard).toHaveClass("border-accent-400", "bg-accent-500/20");
            await user.unhover(nextCardTarget);
            expect(nextCard).toHaveClass("border-primary-700", "bg-primary-900/40");

            await user.click(nextCardTarget);
            expect(onSelectedJobChange).toHaveBeenCalledWith(enabledBeta.id);

            onSelectedJobChange.mockClear();
            act(() => nextCardTarget.focus());
            await user.keyboard("[Enter]");
            expect(onSelectedJobChange).toHaveBeenCalledWith(enabledBeta.id);

            onSelectedJobChange.mockClear();
            act(() => selectedCardTarget.focus());
            await user.keyboard(" ");
            expect(onSelectedJobChange).toHaveBeenCalledWith(disabledAlpha.id);
        } finally {
            rendered.view.unmount();
            rendered.queryClient.clear();
        }
    });

    test("loads bounded additional inventory and run pages", async () => {
        const firstInventory: ListOpenClawCronResult = {
            ...inventory,
            hasMore: true,
            jobs: [enabledBeta],
            nextOffset: 1,
        };
        const secondInventory: ListOpenClawCronResult = {
            ...inventory,
            jobs: [disabledAlpha],
            offset: 1,
        };
        const client = {
            query(name: string, input: unknown) {
                const offset = (input as { offset: number }).offset;
                if (name === "openClawCron.list") {
                    return Promise.resolve(
                        offset === 0 ? firstInventory : secondInventory
                    );
                }
                return Promise.resolve(
                    offset === 0
                        ? runPage(0, "run-new", "Newest run")
                        : runPage(1, "run-old", "Older run")
                );
            },
        } as unknown as DashboardTrpcClient;
        const rendered = renderBrowser(client);
        const user = userEvent.setup();

        try {
            await screen.findByText("Newest run");
            await user.click(
                screen.getByRole("button", { name: "Load more OpenClaw jobs" })
            );
            expect(await screen.findByRole("button", { name: "Alpha" })).toBeTruthy();
            await user.click(
                screen.getByRole("button", { name: "Load older OpenClaw runs" })
            );
            expect(await screen.findByText("Older run")).toBeTruthy();
        } finally {
            rendered.view.unmount();
            rendered.queryClient.clear();
        }
    });

    test("discards a later inventory page from a changed snapshot", () => {
        const first: ListOpenClawCronResult = {
            ...inventory,
            hasMore: true,
            jobs: [enabledBeta],
            nextOffset: 1,
        };
        const changed: ListOpenClawCronResult = {
            ...inventory,
            jobs: [disabledAlpha],
            offset: 1,
            snapshotRevision: `sha256:${"B".repeat(43)}`,
        };

        expect(accumulateOpenClawCronInventoryPages([first, changed])).toEqual({
            result: {
                freshness: first.freshness,
                hasMore: true,
                jobs: [enabledBeta],
                snapshotRevision: first.snapshotRevision,
                total: 2,
            },
            stable: false,
        });

        const stale = {
            ...inventory,
            freshness: {
                kind: "last-known-good" as const,
                observedAtMs: timestampMs - 10_000,
                staleSinceMs: timestampMs - 5000,
            },
            jobs: [disabledAlpha],
            offset: 1,
        };
        expect(accumulateOpenClawCronInventoryPages([first, stale])).toMatchObject({
            result: {
                freshness: stale.freshness,
                jobs: [{ id: enabledBeta.id }, { id: disabledAlpha.id }],
            },
            stable: true,
        });
    });

    test("propagates stale run freshness and rejects duplicate run identities", () => {
        const fresh = runPage(0, "run-new", "Newest run");
        const stale = {
            ...runPage(1, "run-old", "Older run"),
            freshness: {
                kind: "last-known-good" as const,
                observedAtMs: timestampMs - 10_000,
                staleSinceMs: timestampMs - 5000,
            },
        };
        expect(accumulateOpenClawCronRunPages([fresh, stale])).toMatchObject({
            result: {
                freshness: stale.freshness,
                runs: [{ runId: "run-new" }, { runId: "run-old" }],
            },
            stable: true,
        });

        const duplicate = {
            ...stale,
            runs: [{ ...stale.runs[0]!, runId: "run-new" }],
        };
        expect(accumulateOpenClawCronRunPages([fresh, duplicate])).toMatchObject({
            result: {
                freshness: fresh.freshness,
                runs: [{ runId: "run-new" }],
            },
            stable: false,
        });

        const unidentifiedFirstRun = { ...fresh.runs[0]! };
        const unidentifiedSecondRun = { ...stale.runs[0]! };
        delete unidentifiedFirstRun.runId;
        delete unidentifiedSecondRun.runId;
        const unidentifiedFirst = { ...fresh, runs: [unidentifiedFirstRun] };
        const unidentifiedSecond = { ...stale, runs: [unidentifiedSecondRun] };
        expect(
            accumulateOpenClawCronRunPages([unidentifiedFirst, unidentifiedSecond])
        ).toMatchObject({
            result: { runs: [{ summary: "Newest run" }] },
            stable: false,
        });
    });

    test("keeps raw initial failures inside the safe browser boundary", async () => {
        const client = {
            query: () =>
                Promise.reject(
                    Object.assign(new Error("private Gateway diagnostic"), {
                        data: { code: "SERVICE_UNAVAILABLE" },
                    })
                ),
        } as unknown as DashboardTrpcClient;
        const rendered = renderBrowser(client);

        try {
            expect(
                await screen.findByRole("heading", {
                    name: "OpenClaw scheduled jobs unavailable",
                })
            ).toBeTruthy();
            expect(screen.getByRole("alert")).not.toHaveTextContent("private");
        } finally {
            rendered.view.unmount();
            rendered.queryClient.clear();
        }
    });

    test("requires a fresh inventory observation newer than the mutation boundary", async () => {
        let inventoryState: "initial" | "newer" | "same" | "stale" = "initial";
        let inventoryCalls = 0;
        const mutation = jest.fn(() => {
            inventoryState = "stale";
            return Promise.reject(unknownOutcomeError());
        });
        const query = jest.fn((name: string) => {
            if (name !== "openClawCron.list") return Promise.resolve(emptyRuns);
            inventoryCalls += 1;
            if (inventoryState === "stale") {
                return Promise.resolve({
                    ...inventory,
                    freshness: {
                        kind: "last-known-good" as const,
                        observedAtMs: timestampMs,
                        staleSinceMs: timestampMs + 1,
                    },
                });
            }
            if (inventoryState === "newer") {
                return Promise.resolve({
                    ...inventory,
                    freshness: {
                        kind: "fresh" as const,
                        observedAtMs: timestampMs + 1,
                    },
                });
            }
            return Promise.resolve(inventory);
        });
        const client = { mutation, query } as unknown as DashboardTrpcClient;
        const rendered = renderBrowser(client);
        const user = userEvent.setup();

        try {
            expect(
                await screen.findByRole("heading", { level: 3, name: "Beta" })
            ).toBeTruthy();
            await user.click(screen.getByRole("button", { name: "Run now" }));
            const dialog = screen.getByRole("dialog", {
                name: "Run OpenClaw scheduled job",
            });
            await user.click(within(dialog).getByRole("button", { name: "Run now" }));

            expect(await within(dialog).findByText(/refresh also failed/u)).toBeVisible();
            expect(mutation).toHaveBeenCalledTimes(1);
            expect(inventoryCalls).toBeGreaterThanOrEqual(2);
            expect(
                within(dialog).getByRole("button", { name: "Run now" })
            ).toBeDisabled();
            expect(screen.queryByText(/private/u)).not.toBeInTheDocument();

            const callsBeforeSameObservation = inventoryCalls;
            inventoryState = "same";
            await user.click(
                within(dialog).getByRole("button", {
                    name: "Refresh current status",
                })
            );
            await waitFor(() =>
                expect(inventoryCalls).toBeGreaterThan(callsBeforeSameObservation)
            );
            expect(
                screen.getByRole("dialog", { name: "Run OpenClaw scheduled job" })
            ).toBeVisible();
            expect(
                within(dialog).getByRole("button", { name: "Run now" })
            ).toBeDisabled();
            expect(mutation).toHaveBeenCalledTimes(1);

            inventoryState = "newer";
            await user.click(
                within(dialog).getByRole("button", {
                    name: "Refresh current status",
                })
            );
            await waitFor(() =>
                expect(
                    screen.queryByRole("dialog", {
                        name: "Run OpenClaw scheduled job",
                    })
                ).not.toBeInTheDocument()
            );
            expect(mutation).toHaveBeenCalledTimes(1);
            expect(inventoryCalls).toBeGreaterThanOrEqual(4);
        } finally {
            rendered.view.unmount();
            rendered.queryClient.clear();
        }
    });

    test("does not reconcile a newer observation into a changed auth owner", async () => {
        const reconciliation = Promise.withResolvers<ListOpenClawCronResult>();
        let reconciliationStarted = false;
        const mutation = jest.fn(() => {
            reconciliationStarted = true;
            return Promise.reject(unknownOutcomeError());
        });
        const query = jest.fn((name: string) => {
            if (name !== "openClawCron.list") return Promise.resolve(emptyRuns);
            return reconciliationStarted
                ? reconciliation.promise
                : Promise.resolve(inventory);
        });
        const client = { mutation, query } as unknown as DashboardTrpcClient;
        const rendered = renderBrowser(client);
        const user = userEvent.setup();
        rendered.queryClient.setQueryData(authStatusQueryKey, {
            state: "bootstrap-required",
        });

        try {
            expect(
                await screen.findByRole("heading", { level: 3, name: "Beta" })
            ).toBeTruthy();
            await user.click(screen.getByRole("button", { name: "Run now" }));
            const dialog = screen.getByRole("dialog", {
                name: "Run OpenClaw scheduled job",
            });
            await user.click(within(dialog).getByRole("button", { name: "Run now" }));
            await waitFor(() =>
                expect(
                    query.mock.calls.filter(([name]) => name === "openClawCron.list")
                ).toHaveLength(2)
            );

            rendered.queryClient.setQueryData(authStatusQueryKey, {
                state: "anonymous",
            });
            reconciliation.resolve({
                ...inventory,
                freshness: {
                    kind: "fresh",
                    observedAtMs: timestampMs + 1,
                },
            });

            expect(await within(dialog).findByText(/refresh also failed/u)).toBeVisible();
            expect(
                within(dialog).getByRole("button", { name: "Run now" })
            ).toBeDisabled();
            expect(mutation).toHaveBeenCalledTimes(1);
        } finally {
            reconciliation.resolve(inventory);
            rendered.view.unmount();
            rendered.queryClient.clear();
        }
    });

    test("sends exact run, disable, update, and delete controls", async () => {
        const mutations: Array<{
            input: unknown;
            name: string;
            signal: AbortSignal | undefined;
        }> = [];
        const mutation = jest.fn(
            (name: string, input: unknown, options?: TRPCRequestOptions) => {
                mutations.push({ input, name, signal: options?.signal });
                return Promise.resolve({});
            }
        );
        const query = jest.fn((name: string) =>
            Promise.resolve(name === "openClawCron.list" ? inventory : emptyRuns)
        );
        const client = { mutation, query } as unknown as DashboardTrpcClient;
        const rendered = renderBrowser(client);
        const user = userEvent.setup();
        const originalInvalidateQueries = rendered.queryClient.invalidateQueries.bind(
            rendered.queryClient
        );
        let failedRefreshAttempts = 0;

        try {
            expect(
                await screen.findByRole("heading", { level: 3, name: "Beta" })
            ).toBeTruthy();
            Reflect.set(rendered.queryClient, "invalidateQueries", () => {
                failedRefreshAttempts += 1;
                return Promise.reject(new Error("background cache refresh failed"));
            });

            await user.click(screen.getByRole("button", { name: "Run now" }));
            await user.click(
                within(
                    screen.getByRole("dialog", {
                        name: "Run OpenClaw scheduled job",
                    })
                ).getByRole("button", { name: "Run now" })
            );
            await waitFor(() => expect(mutation).toHaveBeenCalledTimes(1));

            await user.click(screen.getByRole("button", { name: "Disable" }));
            const disableDialog = screen.getByRole("dialog", { name: "Disable Beta" });
            expect(
                within(disableDialog).getByRole("radio", { name: /Indefinitely/u })
            ).toBeChecked();
            expect(
                within(disableDialog).queryByRole("group", {
                    name: "Disabled until",
                })
            ).toBeNull();
            await user.type(
                within(disableDialog).getByRole("textbox", {
                    name: "Disable reason",
                }),
                "Gateway maintenance"
            );
            await user.click(
                within(disableDialog).getByRole("button", {
                    name: "Disable job",
                })
            );
            await waitFor(() => expect(mutation).toHaveBeenCalledTimes(2));

            await user.click(screen.getByRole("button", { name: "Edit settings" }));
            const editor = screen.getByRole("dialog", { name: "Edit Beta" });
            fireEvent.change(
                within(editor).getByRole("textbox", {
                    name: "Job settings (JSON)",
                }),
                { target: { value: JSON.stringify({ name: "Beta renamed" }) } }
            );
            await user.click(
                within(editor).getByRole("button", {
                    name: "Save changes",
                })
            );
            await waitFor(() => expect(mutation).toHaveBeenCalledTimes(3));

            await user.click(screen.getByRole("button", { name: "Delete" }));
            await user.click(
                within(
                    screen.getByRole("dialog", {
                        name: "Delete OpenClaw scheduled job",
                    })
                ).getByRole("button", { name: "Delete" })
            );
            await waitFor(() => expect(mutation).toHaveBeenCalledTimes(4));

            expect(mutations.map(({ input, name }) => ({ input, name }))).toEqual([
                {
                    input: { id: enabledBeta.id },
                    name: "openClawCron.run",
                },
                {
                    input: {
                        disableIntent: { reason: "Gateway maintenance" },
                        enabled: false,
                        expectedConfigRevision: enabledBeta.configRevision,
                        id: enabledBeta.id,
                    },
                    name: "openClawCron.setEnabled",
                },
                {
                    input: {
                        expectedConfigRevision: enabledBeta.configRevision,
                        id: enabledBeta.id,
                        patch: { name: "Beta renamed" },
                    },
                    name: "openClawCron.update",
                },
                {
                    input: {
                        expectedConfigRevision: enabledBeta.configRevision,
                        id: enabledBeta.id,
                    },
                    name: "openClawCron.delete",
                },
            ]);
            expect(
                mutations.every(({ signal }) => signal instanceof AbortSignal)
            ).toBeTrue();
            await waitFor(() => expect(failedRefreshAttempts).toBe(4));
            expect(
                screen.queryByText("The OpenClaw action failed. Refresh and try again.")
            ).toBeNull();

            const queryCountBeforeRecovery = query.mock.calls.length;
            Reflect.set(
                rendered.queryClient,
                "invalidateQueries",
                originalInvalidateQueries
            );
            await originalInvalidateQueries({ queryKey: openClawCronQueryKey });
            await waitFor(() =>
                expect(query.mock.calls.length).toBeGreaterThan(queryCountBeforeRecovery)
            );
        } finally {
            Reflect.set(
                rendered.queryClient,
                "invalidateQueries",
                originalInvalidateQueries
            );
            rendered.view.unmount();
            rendered.queryClient.clear();
        }
    });
});
