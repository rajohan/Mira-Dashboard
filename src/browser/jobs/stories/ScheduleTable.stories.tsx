import type { Meta, StoryObj } from "@storybook/tanstack-react";
import { expect, fn, userEvent, within } from "storybook/test";
import * as v from "valibot";

import type { ScheduleSummary } from "../../../contracts/jobModel.ts";
import { listSchedulesResultSchema } from "../../../contracts/schedules.ts";
import { expectVirtualizedList } from "../../storySupport/virtualizationAssertions.ts";
import { ScheduleTable } from "../ScheduleTable.tsx";

const timestampMs = 1_800_000_000_000;

function schedule(
    id: string,
    name: string,
    configuration: ScheduleSummary["schedule"],
    overrides: Partial<ScheduleSummary> = {}
): ScheduleSummary {
    return {
        actionKey: "system.worker-smoke",
        attemptLimit: 2,
        cancellationPolicy: "cooperative",
        createdAtMs: timestampMs - 30 * 86_400_000,
        description: "Checks one reviewed Dashboard subsystem.",
        enabled: true,
        id,
        manualRunAvailable: true,
        name,
        nextRunAtMs: timestampMs + 60_000,
        priority: 0,
        resourceClass: "light",
        resourceKeys: [],
        retrySafe: true,
        schedule: configuration,
        timeoutMs: 60_000,
        updatedAtMs: timestampMs - 86_400_000,
        version: 4,
        ...overrides,
    };
}

const schedules = Object.freeze(
    v.parse(listSchedulesResultSchema, {
        schedules: [
            schedule("cache.weekday-refresh", "Weekday cache refresh", {
                expression: "0 6 * * 1-5",
                kind: "cron",
                timeZone: "UTC",
            }),
            schedule(
                "maintenance.disabled",
                "Release maintenance",
                { intervalMs: 86_400_000, kind: "interval" },
                {
                    activeDisableIntent: {
                        createdAtMs: timestampMs - 60_000,
                        id: "019fe300-0000-7000-8000-000000000010",
                        reason: "Paused during release cutover",
                    },
                    enabled: false,
                    nextRunAtMs: undefined,
                }
            ),
            schedule("reports.daily-brief", "Daily brief", {
                kind: "daily",
                timeOfDay: "05:30",
                timeZone: "Europe/Oslo",
            }),
            schedule("system.worker-smoke", "Worker smoke", {
                intervalMs: 3_600_000,
                kind: "interval",
            }),
        ],
    }).schedules
);

const virtualizedSchedules = Object.freeze(
    v.parse(listSchedulesResultSchema, {
        schedules: Array.from({ length: 50 }, (_, index) => {
            const suffix = index.toString().padStart(3, "0");
            return schedule(`catalog.schedule-${suffix}`, `Catalog schedule ${suffix}`, {
                intervalMs: 3_600_000,
                kind: "interval",
            });
        }),
    }).schedules
);

const meta = {
    args: {
        onSelect: fn(),
        schedules,
        selectedId: "system.worker-smoke",
    },
    component: ScheduleTable,
    parameters: {
        layout: "padded",
    },
} satisfies Meta<typeof ScheduleTable>;

export default meta;

type Story = StoryObj<typeof meta>;

export const CadenceVariants: Story = {
    play: async ({ args, canvasElement }) => {
        await userEvent.click(
            within(canvasElement).getByRole("button", {
                name: "Daily brief; reports.daily-brief",
            })
        );
        await expect(args.onSelect).toHaveBeenCalledWith("reports.daily-brief");
    },
};

export const LargeInventory: Story = {
    args: {
        schedules: virtualizedSchedules,
        selectedId: virtualizedSchedules[0]?.id,
    },
    play: async ({ canvasElement }) => {
        await expectVirtualizedList({
            canvasElement,
            itemCount: virtualizedSchedules.length,
            label: "Dashboard schedules",
        });
    },
};

export const InfiniteScrollLoading: Story = {
    args: {
        pagination: {
            hasMore: true,
            loading: true,
            loadingLabel: "Loading more schedules…",
            onLoadMore: fn(),
        },
        schedules: virtualizedSchedules,
    },
};

export const Empty: Story = {
    args: {
        schedules: [],
        selectedId: undefined,
    },
};
