import type { Meta, StoryObj } from "@storybook/tanstack-react";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";

import type {
    ListOpenClawCronResult,
    ListOpenClawCronRunsResult,
    OpenClawCronJob,
} from "../../../contracts/openClawCron.ts";
import { OpenClawCronSectionView } from "../OpenClawCronSection.tsx";

const observedAtMs = 1_800_001_000_000;
const activeJob = {
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
        lastRunAtMs: observedAtMs - 3_600_000,
        lastRunStatus: "ok",
        nextRunAtMs: observedAtMs + 82_800_000,
    },
    synchronization: { state: "confirmed" },
    updatedAtMs: observedAtMs - 60_000,
    wakeMode: "now",
} as const satisfies OpenClawCronJob;

const conflictedJob = {
    ...activeJob,
    enabled: true,
    id: "weekly-maintenance",
    name: "Weekly maintenance",
    schedule: { everyMs: 604_800_000, kind: "every", truncated: false },
    synchronization: {
        desiredEnabled: false,
        disableIntent: {
            reason: "Maintenance freeze",
            recordedAtMs: observedAtMs - 120_000,
            revision: "intent-7",
        },
        state: "conflict",
    },
} as const satisfies OpenClawCronJob;

const freshInventorySource = {
    kind: "fresh",
    observedAtMs,
} as const satisfies ListOpenClawCronResult["freshness"];

function inventory(
    jobs: readonly OpenClawCronJob[],
    freshness?: ListOpenClawCronResult["freshness"]
): ListOpenClawCronResult {
    return {
        freshness: freshness ?? freshInventorySource,
        hasMore: false,
        jobs: [...jobs],
        limit: 50,
        offset: 0,
        snapshotRevision: `sha256:${"A".repeat(43)}`,
        total: jobs.length,
    };
}

const runs = {
    freshness: { kind: "fresh", observedAtMs },
    hasMore: false,
    limit: 50,
    offset: 0,
    runs: [
        {
            completedAtMs: observedAtMs - 3_600_000,
            deliveryStatus: "delivered",
            durationMs: 32_000,
            jobId: activeJob.id,
            modelTruncated: false,
            providerTruncated: false,
            runAtMs: observedAtMs - 3_632_000,
            runId: "run-1",
            status: "ok",
            summary: "Report delivered.",
            summaryTruncated: false,
        },
    ],
    total: 1,
} as const satisfies ListOpenClawCronRunsResult;

const responsiveJob = {
    ...activeJob,
    id: `cron-${"i".repeat(251)}`,
    name: `Responsive ${"n".repeat(245)}`,
} as const satisfies OpenClawCronJob;

const responsiveRuns = {
    ...runs,
    runs: [
        {
            ...runs.runs[0],
            jobId: responsiveJob.id,
            model: "m".repeat(256),
            modelTruncated: false,
            provider: "p".repeat(128),
            providerTruncated: false,
            summary: "s".repeat(1000),
        },
    ],
} satisfies ListOpenClawCronRunsResult;

interface ResponsiveViewport {
    readonly height: number;
    readonly width: number;
}

function rectanglesOverlap(first: DOMRect, second: DOMRect): boolean {
    return (
        first.left < second.right &&
        first.right > second.left &&
        first.top < second.bottom &&
        first.bottom > second.top
    );
}

async function expectMobileDetailGeometry(
    canvasElement: HTMLElement,
    viewport: ResponsiveViewport
) {
    const canvas = within(canvasElement);
    const storyDocument = canvasElement.ownerDocument;
    const storyWindow = storyDocument.defaultView;
    if (storyWindow === null) throw new TypeError("Expected a Storybook window");
    await expect(storyWindow.innerWidth).toBe(viewport.width);
    await expect(storyWindow.innerHeight).toBe(viewport.height);

    const heading = canvas.getByRole("heading", {
        level: 3,
        name: responsiveJob.name,
    });
    const identity = heading.parentElement;
    const header = identity?.parentElement;
    if (
        identity === null ||
        identity === undefined ||
        header === null ||
        header === undefined
    ) {
        throw new TypeError("Expected the responsive detail identity and header");
    }
    const statusGroup = canvas.getByRole("region", { name: "Cron job status" });
    const identityBounds = identity.getBoundingClientRect();
    const headerBounds = header.getBoundingClientRect();
    const statusBounds = statusGroup.getBoundingClientRect();
    await expect(rectanglesOverlap(identityBounds, statusBounds)).toBe(false);
    await expect(statusBounds.top).toBeGreaterThanOrEqual(identityBounds.bottom);
    await expect(identityBounds.left).toBeGreaterThanOrEqual(headerBounds.left);
    await expect(identityBounds.right).toBeLessThanOrEqual(headerBounds.right);
    await expect(statusBounds.left).toBeGreaterThanOrEqual(headerBounds.left);
    await expect(statusBounds.right).toBeLessThanOrEqual(headerBounds.right);

    const detailCard = heading.closest("section");
    const definition = detailCard?.querySelector("dl");
    if (detailCard === null || definition === null || definition === undefined) {
        throw new TypeError("Expected the responsive cron definition card");
    }
    await expect(
        getComputedStyle(definition).gridTemplateColumns.split(" ")
    ).toHaveLength(1);
    for (const row of definition.children) {
        const rowBounds = row.getBoundingClientRect();
        const definitionBounds = definition.getBoundingClientRect();
        await expect(rowBounds.left).toBeGreaterThanOrEqual(definitionBounds.left);
        await expect(rowBounds.right).toBeLessThanOrEqual(definitionBounds.right);
    }

    const actions = canvas.getByRole("toolbar", { name: "Cron job actions" });
    const actionButtons = within(actions).getAllByRole("button");
    const actionBounds = actions.getBoundingClientRect();
    let previousBottom = 0;
    for (const action of actionButtons) {
        const bounds = action.getBoundingClientRect();
        await expect(bounds.left).toBeGreaterThanOrEqual(actionBounds.left);
        await expect(bounds.right).toBeLessThanOrEqual(actionBounds.right);
        await expect(bounds.top).toBeGreaterThanOrEqual(previousBottom);
        previousBottom = bounds.bottom;
    }

    await expect(detailCard.scrollWidth).toBeLessThanOrEqual(detailCard.clientWidth);
    await expect(storyDocument.body.scrollWidth).toBeLessThanOrEqual(
        storyDocument.body.clientWidth
    );
    await expect(storyDocument.documentElement.scrollWidth).toBeLessThanOrEqual(
        storyDocument.documentElement.clientWidth
    );
}

async function expectResponsiveLayout(canvasElement: HTMLElement) {
    const canvas = within(canvasElement);
    const section = canvas.getByRole("region", { name: "OpenClaw cron" });
    const inventoryList = canvas.getByRole("list", { name: "OpenClaw cron jobs" });
    const inventoryCanvas = within(inventoryList);
    const selectedTarget = inventoryCanvas.getByRole("button", {
        name: responsiveJob.name,
    });
    const selectedCard = selectedTarget.closest("li");
    if (selectedCard === null) throw new TypeError("Expected a selected inventory card");
    await expect(section).toBeVisible();
    await expect(inventoryList).toBeVisible();
    await expect(
        canvas.getByRole("list", {
            name: `OpenClaw runs for ${responsiveJob.name}`,
        })
    ).toBeVisible();
    for (const label of [
        "Gateway state",
        "Dashboard sync",
        "Schedule",
        "Last run",
        "Next run",
        "Last status",
    ]) {
        await expect(inventoryCanvas.getByText(label)).toBeVisible();
    }
    await expect(selectedTarget).toHaveAttribute("aria-current", "true");
    await expect(selectedTarget).toHaveAttribute("aria-pressed", "true");
    await expect(selectedCard).toHaveClass(
        "border-accent-400",
        "bg-accent-500/20",
        "ring-accent-300/40",
        "ring-inset"
    );
    await expect(within(selectedCard).getByText("Selected")).toBeVisible();
    await expect(section.scrollWidth).toBeLessThanOrEqual(section.clientWidth);

    const storyDocument = canvasElement.ownerDocument;
    const scrollOwner = storyDocument.body;
    await expect(scrollOwner.scrollHeight).toBeGreaterThan(scrollOwner.clientHeight);
    await expect(scrollOwner.scrollWidth).toBeLessThanOrEqual(scrollOwner.clientWidth);
    await expect(storyDocument.documentElement.scrollWidth).toBeLessThanOrEqual(
        storyDocument.documentElement.clientWidth
    );

    const initialScrollTop = scrollOwner.scrollTop;
    scrollOwner.scrollTop = Math.min(
        500,
        scrollOwner.scrollHeight - scrollOwner.clientHeight
    );
    await new Promise<void>((resolve) => {
        requestAnimationFrame(() => resolve());
    });
    await expect(scrollOwner.scrollTop).toBeGreaterThan(initialScrollTop);
    scrollOwner.scrollTop = initialScrollTop;
}

const meta = {
    args: {
        onDelete: fn(async () => {}),
        onRetry: fn(),
        onRun: fn(async () => {}),
        onSelectJob: fn(),
        onSetEnabled: fn(async () => {}),
        onUpdate: fn(async () => {}),
        runs,
        state: { result: inventory([activeJob, conflictedJob]), status: "ready" },
    },
    component: OpenClawCronSectionView,
    parameters: { layout: "padded" },
    title: "Jobs/OpenClawCronSection",
} satisfies Meta<typeof OpenClawCronSectionView>;

export default meta;
type Story = StoryObj<typeof meta>;

export const ActiveInventory: Story = {
    play: async ({ args, canvasElement }) => {
        const canvas = within(canvasElement);
        const cardTarget = canvas.getByRole("button", { name: activeJob.name });
        const idleTarget = canvas.getByRole("button", { name: conflictedJob.name });
        const card = cardTarget.closest("li");
        const idleCard = idleTarget.closest("li");
        if (card === null) throw new TypeError("Expected an inventory card");
        if (idleCard === null) throw new TypeError("Expected an idle inventory card");
        const selectedBackground = getComputedStyle(card).backgroundColor;
        const selectedBorder = getComputedStyle(card).borderColor;
        const idleBackground = getComputedStyle(idleCard).backgroundColor;
        await expect(selectedBackground).not.toBe(idleBackground);
        await expect(selectedBorder).not.toBe(getComputedStyle(idleCard).borderColor);
        await expect(within(card).getByText("Selected")).toBeVisible();
        await expect(within(idleCard).queryByText("Selected")).not.toBeInTheDocument();
        await userEvent.hover(idleTarget);
        await waitFor(async () => {
            await expect(getComputedStyle(idleCard).backgroundColor).not.toBe(
                idleBackground
            );
        });
        await expect(getComputedStyle(idleCard).backgroundColor).not.toBe(
            selectedBackground
        );
        await userEvent.unhover(idleTarget);
        await userEvent.hover(cardTarget);
        await waitFor(async () => {
            await expect(getComputedStyle(card).backgroundColor).toBe(selectedBackground);
        });
        await expect(getComputedStyle(card).backgroundColor).not.toBe(
            getComputedStyle(idleCard).backgroundColor
        );
        await userEvent.unhover(cardTarget);
        card.scrollIntoView({ block: "center" });
        await new Promise<void>((resolve) => {
            requestAnimationFrame(() => resolve());
        });
        const cardBounds = card.getBoundingClientRect();
        const cardBodyHitTarget = canvasElement.ownerDocument.elementFromPoint(
            cardBounds.right - 12,
            cardBounds.bottom - 12
        );
        await expect(cardBodyHitTarget).toBe(cardTarget);
        if (!(cardBodyHitTarget instanceof HTMLElement)) {
            throw new TypeError("Expected the full-card button at the card body");
        }
        await userEvent.click(cardBodyHitTarget);
        await expect(args.onSelectJob).toHaveBeenCalledWith(activeJob);
        await expect(cardTarget).toHaveAttribute("aria-current", "true");
        await expect(cardTarget).toHaveAttribute("aria-pressed", "true");

        await userEvent.click(canvas.getByRole("button", { name: "Run now" }));
        const dialog = within(document.body).getByRole("dialog", {
            name: "Run OpenClaw cron job",
        });
        await userEvent.click(within(dialog).getByRole("button", { name: "Run now" }));
        await expect(args.onRun).toHaveBeenCalledWith(activeJob);
    },
};

export const ResponsiveDesktop: Story = {
    args: {
        runs: responsiveRuns,
        state: { result: inventory([responsiveJob]), status: "ready" },
    },
    play: async ({ canvasElement }) => {
        await expectResponsiveLayout(canvasElement);
    },
};

export const ResponsiveMobile: Story = {
    args: {
        runs: responsiveRuns,
        state: { result: inventory([responsiveJob]), status: "ready" },
    },
    globals: {
        viewport: { isRotated: false, value: "mobile1" },
    },
    play: async ({ canvasElement }) => {
        await expectMobileDetailGeometry(canvasElement, { height: 568, width: 320 });
        await expectResponsiveLayout(canvasElement);
    },
};

export const ResponsiveMobile390: Story = {
    args: {
        runs: responsiveRuns,
        state: { result: inventory([responsiveJob]), status: "ready" },
    },
    globals: {
        viewport: { isRotated: false, value: "mobile390" },
    },
    parameters: {
        viewport: {
            options: {
                mobile390: {
                    name: "390 px mobile",
                    styles: { height: "844px", width: "390px" },
                    type: "mobile",
                },
            },
        },
    },
    play: async ({ canvasElement }) => {
        await expectMobileDetailGeometry(canvasElement, { height: 844, width: 390 });
        await expectResponsiveLayout(canvasElement);
    },
};

export const DisableDialogMobile: Story = {
    globals: {
        viewport: { isRotated: false, value: "mobile1" },
    },
    play: async ({ args, canvasElement }) => {
        const canvas = within(canvasElement);
        await userEvent.click(canvas.getByRole("button", { name: "Disable" }));
        const page = within(canvasElement.ownerDocument.body);
        const dialog = page.getByRole("dialog", { name: "Disable Nightly report" });
        const modal = within(dialog);

        await expect(modal.getByRole("radio", { name: /Indefinitely/u })).toBeChecked();
        await expect(
            modal.queryByRole("group", { name: "Disabled until" })
        ).not.toBeInTheDocument();
        await userEvent.click(modal.getByRole("radio", { name: /Until a date/u }));
        const picker = modal.getByRole("group", { name: "Disabled until" });
        await expect(picker).toBeVisible();
        await expect(
            within(picker).getByRole("button", {
                name: /Choose Disabled until date, selected/u,
            })
        ).toBeVisible();
        await expect(
            within(picker).getByRole("button", { name: "Time (24-hour), hour" })
        ).toBeVisible();
        await expect(dialog.scrollWidth).toBeLessThanOrEqual(dialog.clientWidth);
        await expect(canvasElement.ownerDocument.body.scrollWidth).toBeLessThanOrEqual(
            canvasElement.ownerDocument.body.clientWidth
        );

        await userEvent.click(modal.getByRole("radio", { name: /Indefinitely/u }));
        await userEvent.type(
            modal.getByRole("textbox", { name: "Disable reason" }),
            "Mobile maintenance"
        );
        const save = modal.getByRole("button", { name: "Save disabled state" });
        await expect(save).toHaveClass("w-full", "sm:w-auto");
        await userEvent.click(save);
        await expect(args.onSetEnabled).toHaveBeenCalledWith(activeJob, false, {
            reason: "Mobile maintenance",
        });
    },
};

export const LastKnownGoodConflict: Story = {
    args: {
        backgroundError: "OpenClaw refresh failed.",
        runs: undefined,
        state: {
            result: inventory([conflictedJob], {
                kind: "last-known-good",
                observedAtMs,
                staleSinceMs: observedAtMs + 30_000,
            }),
            status: "ready",
        },
    },
};

export const EmptyInventory: Story = {
    args: {
        runs: undefined,
        state: { result: inventory([]), status: "ready" },
    },
};

export const Loading: Story = {
    args: { runs: undefined, state: { status: "loading" } },
};

export const InitialFailure: Story = {
    args: {
        runs: undefined,
        state: {
            message: "OpenClaw Gateway is unavailable.",
            status: "error",
        },
    },
};
