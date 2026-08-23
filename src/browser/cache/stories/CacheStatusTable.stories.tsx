import type { Meta, StoryObj } from "@storybook/tanstack-react";
import { expect, fn, userEvent, within } from "storybook/test";
import * as v from "valibot";

import {
    type CacheEntryStatus,
    cacheStatusResultSchema,
} from "../../../contracts/cache.ts";
import { expectVirtualizedList } from "../../storySupport/virtualizationAssertions.ts";
import { CacheStatusTable } from "../CacheStatusTable.tsx";

const timestampMs = 1_800_000_000_000;
const lastAttemptRunId = "019fe200-0000-7000-8000-000000000001";

function cacheStatus(
    key: string,
    overrides: Partial<CacheEntryStatus> = {}
): CacheEntryStatus {
    return {
        consecutiveFailures: 0,
        expiresAtMs: timestampMs + 86_400_000,
        freshness: "fresh",
        key,
        lastAttemptAtMs: timestampMs,
        lastAttemptDurationMs: 842,
        lastAttemptNumber: 1,
        lastAttemptRunId,
        lastAttemptStatus: "succeeded",
        lastSuccessAtMs: timestampMs,
        manualRunAvailable: true,
        metadata: {},
        schemaId: `${key}.v1`,
        source: key,
        updatedAtMs: timestampMs,
        ...overrides,
    };
}

function validatedEntries(candidateEntries: readonly CacheEntryStatus[]) {
    return Object.freeze(
        v.parse(cacheStatusResultSchema, {
            entries: candidateEntries,
            generatedAtMs: timestampMs,
            totalCount: candidateEntries.length,
            truncated: false,
        }).entries
    );
}

const entries = validatedEntries([
    cacheStatus("openclaw.status", {
        consecutiveFailures: 2,
        expiresAtMs: undefined,
        failureCode: "openclaw.unavailable",
        failureMessage: "OpenClaw status is unavailable.",
        freshness: "missing",
        lastAttemptStatus: "failed",
        lastSuccessAtMs: undefined,
        manualRunAvailable: false,
        metadata: undefined,
        schemaId: undefined,
        source: undefined,
    }),
    cacheStatus("system.host"),
    cacheStatus("weather.spydeberg", {
        consecutiveFailures: 1,
        expiresAtMs: timestampMs - 1,
        failureCode: "weather.upstream-unavailable",
        failureMessage: "The latest weather refresh failed.",
        freshness: "stale",
        lastAttemptStatus: "failed",
        lastSuccessAtMs: timestampMs - 2 * 86_400_000,
    }),
]);

const largeInventoryEntries = validatedEntries(
    Array.from({ length: 50 }, (_, index) =>
        cacheStatus(`provider.${index.toString().padStart(3, "0")}`)
    )
);

const meta = {
    args: {
        entries,
        onSelect: fn(),
        selectedKey: "system.host",
    },
    component: CacheStatusTable,
    parameters: {
        layout: "padded",
    },
} satisfies Meta<typeof CacheStatusTable>;

export default meta;

type Story = StoryObj<typeof meta>;

export const FreshStaleAndMissing: Story = {
    play: async ({ args, canvasElement }) => {
        await userEvent.click(
            within(canvasElement).getByRole("button", {
                name: "View weather.spydeberg",
            })
        );
        await expect(args.onSelect).toHaveBeenCalledWith("weather.spydeberg");
    },
};

export const VirtualizedInventory: Story = {
    args: {
        entries: largeInventoryEntries,
        selectedKey: largeInventoryEntries[0]?.key,
    },
    play: async ({ canvasElement }) => {
        await expectVirtualizedList({
            canvasElement,
            itemCount: largeInventoryEntries.length,
            label: "Saved data sources",
        });
    },
};

export const Empty: Story = {
    args: {
        entries: [],
        selectedKey: undefined,
    },
};
