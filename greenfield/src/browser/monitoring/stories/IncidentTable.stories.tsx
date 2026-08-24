import type { Meta, StoryObj } from "@storybook/tanstack-react";
import { expect, fn, userEvent, within } from "storybook/test";
import * as v from "valibot";

import { listIncidentsResultSchema } from "../../../contracts/incidents.ts";
import type { IncidentSummary } from "../../../contracts/monitoring.ts";
import { expectVirtualizedList } from "../../storySupport/virtualizationAssertions.ts";
import { IncidentTable } from "../IncidentTable.tsx";

const timestampMs = 1_800_000_000_000;

const incidents = Object.freeze(
    v.parse(listIncidentsResultSchema, {
        incidents: [
            {
                fingerprint: "a".repeat(64),
                firstSeenAtMs: timestampMs - 90 * 60_000,
                generation: 3,
                id: "019fe400-0000-7000-8000-000000000004",
                kind: "filesystem",
                lastSeenAtMs: timestampMs - 2 * 60_000,
                monitorKey: "host.disk-capacity",
                occurrenceCount: 8,
                severity: "critical",
                state: "active",
                title: "Production disk capacity is critically low",
            },
            {
                fingerprint: "b".repeat(64),
                firstSeenAtMs: timestampMs - 45 * 60_000,
                generation: 1,
                id: "019fe400-0000-7000-8000-000000000003",
                kind: "worker",
                lastSeenAtMs: timestampMs - 5 * 60_000,
                monitorKey: "jobs.worker-heartbeat",
                occurrenceCount: 2,
                severity: "warning",
                state: "active",
                title: "A background worker has not checked in",
            },
            {
                fingerprint: "c".repeat(64),
                firstSeenAtMs: timestampMs - 4 * 60 * 60_000,
                generation: 2,
                id: "019fe400-0000-7000-8000-000000000002",
                kind: "cache",
                lastSeenAtMs: timestampMs - 3 * 60 * 60_000,
                monitorKey: "cache.freshness",
                occurrenceCount: 4,
                resolvedAtMs: timestampMs - 2 * 60 * 60_000,
                severity: "error",
                state: "resolved",
                title: "Host status is out of date",
            },
            {
                fingerprint: "d".repeat(64),
                firstSeenAtMs: timestampMs - 86_400_000,
                generation: 1,
                id: "019fe400-0000-7000-8000-000000000001",
                kind: "release",
                lastSeenAtMs: timestampMs - 86_000_000,
                monitorKey: "release.qualification",
                occurrenceCount: 1,
                resolvedAtMs: timestampMs - 85_000_000,
                severity: "info",
                state: "resolved",
                title: "Release qualification completed",
            },
        ] satisfies readonly IncidentSummary[],
    }).incidents
);

const virtualizedIncidents = Object.freeze(
    v.parse(listIncidentsResultSchema, {
        incidents: Array.from({ length: 50 }, (_, index) => {
            const lastSeenAtMs = timestampMs - index * 1000;
            const suffix = index.toString().padStart(12, "0");
            return {
                fingerprint: index.toString(16).padStart(64, "0"),
                firstSeenAtMs: lastSeenAtMs - 60_000,
                generation: 1,
                id: `019fe410-0000-7000-8000-${suffix}`,
                kind: "catalog",
                lastSeenAtMs,
                monitorKey: `catalog.monitor-${index.toString().padStart(2, "0")}`,
                occurrenceCount: 1,
                severity: "warning",
                state: "active",
                title: `Catalog incident ${index.toString().padStart(2, "0")}`,
            } satisfies IncidentSummary;
        }),
    }).incidents
);

const meta = {
    args: {
        incidents,
        onSelect: fn(),
        selectedId: incidents[0]?.id,
    },
    component: IncidentTable,
    parameters: {
        layout: "padded",
    },
} satisfies Meta<typeof IncidentTable>;

export default meta;

type Story = StoryObj<typeof meta>;

export const LifecycleAndSeverity: Story = {
    play: async ({ args, canvasElement }) => {
        const incident = incidents[1];
        if (incident === undefined) throw new Error("The incident fixture is missing.");

        await userEvent.click(
            within(canvasElement).getByRole("button", {
                name: `${incident.title}; ${incident.severity}; ${incident.state}`,
            })
        );
        await expect(args.onSelect).toHaveBeenCalledWith(incident.id);
    },
};

export const VirtualizedInventory: Story = {
    args: {
        incidents: virtualizedIncidents,
        selectedId: virtualizedIncidents[0]?.id,
    },
    play: async ({ canvasElement }) => {
        await expectVirtualizedList({
            canvasElement,
            label: "Incidents",
            itemCount: virtualizedIncidents.length,
        });
    },
};

export const Empty: Story = {
    args: {
        incidents: [],
        selectedId: undefined,
    },
};
