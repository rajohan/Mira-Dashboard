import type { Meta, StoryObj } from "@storybook/tanstack-react";
import { expect, within } from "storybook/test";

import type { IncidentRecord, IncidentSummary } from "../../../contracts/monitoring.ts";
import { liveHistoryArchiveQueryKey } from "../../api/liveHistory.ts";
import { DashboardPageStory } from "../../storySupport/dashboardPageStoryHarness.tsx";
import {
    dashboardStoryFailure,
    dashboardStoryResolver,
    dashboardStoryValue,
    type DashboardStoryFixtureValue,
    type DashboardStoryFixtures,
} from "../../storySupport/dashboardStoryTransport.ts";
import { incidentListQueryKey } from "../monitoringQueries.ts";

const observedAtMs = 1_800_000_000_000;
const incidentId = "019fe900-0000-7000-8000-000000000001";
const incident = {
    fingerprint: "a".repeat(64),
    firstSeenAtMs: observedAtMs - 300_000,
    generation: 2,
    id: incidentId,
    kind: "database-maintenance",
    lastSeenAtMs: observedAtMs,
    monitorKey: "database-observability",
    occurrenceCount: 4,
    severity: "warning",
    state: "active",
    title: "PostgreSQL maintenance needs attention",
} as const satisfies IncidentSummary;
const incidentDetail = {
    ...incident,
    details: {
        database: "media",
        recommendation: "Review dead tuples before the next maintenance window",
    },
} as const satisfies IncidentRecord;
const incidentPage = { incidents: [incident] } as const;
const emptyIncidentPage = { incidents: [] } as const;
const notifications = { notifications: [], readCount: 0, unreadCount: 0 } as const;

function incidentFixtures({
    detail = dashboardStoryValue(incidentDetail),
    list = dashboardStoryValue(incidentPage),
}: {
    readonly detail?: DashboardStoryFixtureValue;
    readonly list?: DashboardStoryFixtureValue;
} = {}): DashboardStoryFixtures {
    return {
        queries: {
            "incidents.get": detail,
            "incidents.list": list,
            "notifications.list": dashboardStoryValue(notifications),
        },
    };
}

const pending = dashboardStoryResolver(
    () =>
        new Promise<never>(() => {
            // Intentionally pending to preserve the loading state.
        })
);

const meta = {
    component: DashboardPageStory,
    parameters: { layout: "fullscreen" },
    render: (args, context) => <DashboardPageStory {...args} key={context.id} />,
} satisfies Meta<typeof DashboardPageStory>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Loading: Story = {
    args: { fixtures: incidentFixtures({ list: pending }), route: "/incidents" },
};

export const List: Story = {
    args: { fixtures: incidentFixtures(), route: "/incidents" },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        await expect(
            await canvas.findByRole("button", {
                name: "PostgreSQL maintenance needs attention; warning; active",
            })
        ).toBeVisible();
    },
};

export const Empty: Story = {
    args: {
        fixtures: incidentFixtures({ list: dashboardStoryValue(emptyIncidentPage) }),
        route: "/incidents",
    },
};

export const InitialError: Story = {
    args: {
        fixtures: incidentFixtures({
            list: dashboardStoryFailure(new TypeError("Safe incident story failure")),
        }),
        route: "/incidents",
    },
};

export const BrowserRetained: Story = {
    args: {
        fixtures: incidentFixtures({
            list: dashboardStoryFailure(
                new TypeError("Safe retained incident refresh failure")
            ),
        }),
        querySeeds: [
            {
                key: liveHistoryArchiveQueryKey(incidentListQueryKey(undefined)),
                updatedAtMs: 1,
                value: { pageParams: [undefined], pages: [incidentPage] },
            },
        ],
        route: "/incidents",
    },
};

export const SelectedDetail: Story = {
    args: {
        fixtures: incidentFixtures(),
        route: `/incidents?incidentId=${incidentId}`,
    },
};

export const DetailWithListUnavailable: Story = {
    args: {
        fixtures: incidentFixtures({
            list: dashboardStoryFailure(
                new TypeError("Safe incident list story failure")
            ),
        }),
        route: `/incidents?incidentId=${incidentId}`,
    },
};
