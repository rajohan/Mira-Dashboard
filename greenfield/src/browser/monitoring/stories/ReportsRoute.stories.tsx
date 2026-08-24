import type { Meta, StoryObj } from "@storybook/tanstack-react";
import { expect, userEvent, waitFor, within } from "storybook/test";

import type { ReportDetail, ReportSummary } from "../../../contracts/monitoring.ts";
import { liveHistoryArchiveQueryKey } from "../../api/liveHistory.ts";
import { DashboardPageStory } from "../../storySupport/dashboardPageStoryHarness.tsx";
import {
    dashboardStoryFailure,
    dashboardStoryResolver,
    dashboardStoryValue,
    type DashboardStoryFixtureValue,
    type DashboardStoryFixtures,
} from "../../storySupport/dashboardStoryTransport.ts";
import { reportListQueryKey } from "../monitoringQueries.ts";

const observedAtMs = 1_800_000_000_000;
const reportId = "019fe900-0000-7000-8000-000000000010";
const report = {
    id: reportId,
    kind: "heartbeat",
    occurredAtMs: observedAtMs,
    source: "openclaw",
    sourceJobId: "ops-check",
    status: "warning",
    summary: "Two operational signals need attention.",
    title: "Operations heartbeat",
} as const satisfies ReportSummary;
const reportDetail = {
    ...report,
    bodyMarkdown:
        "## Summary\n\nBackups are healthy. PostgreSQL maintenance should be reviewed.",
    metadata: { signalCount: 9 },
} as const satisfies ReportDetail;
const reportPage = { reports: [report] } as const;
const emptyReportPage = { reports: [] } as const;
const notifications = { notifications: [], readCount: 0, unreadCount: 0 } as const;

function reportFixtures({
    detail = dashboardStoryValue(reportDetail),
    list = dashboardStoryValue(reportPage),
    mutations = {},
}: {
    readonly detail?: DashboardStoryFixtureValue;
    readonly list?: DashboardStoryFixtureValue;
    readonly mutations?: DashboardStoryFixtures["mutations"];
} = {}): DashboardStoryFixtures {
    return {
        mutations,
        queries: {
            "notifications.list": dashboardStoryValue(notifications),
            "reports.get": detail,
            "reports.list": list,
        },
    };
}

const pending = dashboardStoryResolver(
    () =>
        new Promise<never>(() => {
            // Intentionally pending to preserve the loading or busy state.
        })
);

function selectedReportRoute(): string {
    return `/reports?reportId=${reportId}`;
}

async function openDeleteDialog(canvasElement: HTMLElement) {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: "Delete" }));
    const body = within(canvasElement.ownerDocument.body);
    const dialog = await body.findByRole("dialog", { name: "Delete report" });
    await expect(dialog).toBeVisible();
    return within(dialog);
}

const meta = {
    component: DashboardPageStory,
    parameters: { layout: "fullscreen" },
    render: (args, context) => <DashboardPageStory {...args} key={context.id} />,
} satisfies Meta<typeof DashboardPageStory>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Loading: Story = {
    args: { fixtures: reportFixtures({ list: pending }), route: "/reports" },
};

export const List: Story = {
    args: { fixtures: reportFixtures(), route: "/reports" },
};

export const InfiniteScroll: Story = {
    args: {
        fixtures: reportFixtures({
            list: dashboardStoryResolver((input) => {
                const hasCursor =
                    typeof input === "object" && input !== null && "cursor" in input;
                if (hasCursor) {
                    return {
                        reports: [
                            {
                                ...report,
                                id: "019fe900-0000-7000-8000-000000000099",
                                occurredAtMs: observedAtMs - 100_000,
                                title: "Older operations heartbeat",
                            },
                        ],
                    };
                }
                const reports = Array.from({ length: 50 }, (_, index) => ({
                    ...report,
                    id: `019fe900-0000-7000-8000-${index.toString().padStart(12, "0")}`,
                    occurredAtMs: observedAtMs - index * 1000,
                    title: `Operations heartbeat ${index.toString().padStart(2, "0")}`,
                }));
                const last = reports.at(-1);
                return {
                    reports,
                    nextCursor:
                        last === undefined
                            ? undefined
                            : { id: last.id, occurredAtMs: last.occurredAtMs },
                };
            }),
        }),
        route: "/reports",
    },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        const list = await canvas.findByRole("list", { name: "Reports" });
        const scrollOwner = list.parentElement;
        if (scrollOwner === null) throw new TypeError("Reports scroll owner is missing");
        scrollOwner.scrollTop = scrollOwner.scrollHeight;
        scrollOwner.dispatchEvent(new Event("scroll", { bubbles: true }));
        await waitFor(async () => {
            await expect(canvas.getByText("Older operations heartbeat")).toBeVisible();
        });
    },
};

export const Empty: Story = {
    args: {
        fixtures: reportFixtures({ list: dashboardStoryValue(emptyReportPage) }),
        route: "/reports",
    },
};

export const InitialError: Story = {
    args: {
        fixtures: reportFixtures({
            list: dashboardStoryFailure(new TypeError("Safe report story failure")),
        }),
        route: "/reports",
    },
};

export const BrowserRetained: Story = {
    args: {
        fixtures: reportFixtures({
            list: dashboardStoryFailure(
                new TypeError("Safe retained report refresh failure")
            ),
        }),
        querySeeds: [
            {
                key: liveHistoryArchiveQueryKey(reportListQueryKey(undefined)),
                updatedAtMs: 1,
                value: { pageParams: [undefined], pages: [reportPage] },
            },
        ],
        route: "/reports",
    },
};

export const SelectedReport: Story = {
    args: { fixtures: reportFixtures(), route: selectedReportRoute() },
};

export const DetailWithListUnavailable: Story = {
    args: {
        fixtures: reportFixtures({
            list: dashboardStoryFailure(new TypeError("Safe report list failure")),
        }),
        route: selectedReportRoute(),
    },
};

export const DeleteConfirmation: Story = {
    args: { fixtures: reportFixtures(), route: selectedReportRoute() },
    play: async ({ canvasElement }) => {
        await openDeleteDialog(canvasElement);
    },
};

export const DeletePrecondition: Story = {
    args: {
        fixtures: reportFixtures({
            mutations: {
                "reports.delete": dashboardStoryFailure(
                    Object.assign(new Error("Safe report conflict"), {
                        data: { code: "PRECONDITION_FAILED" },
                    })
                ),
            },
        }),
        route: selectedReportRoute(),
    },
    play: async ({ canvasElement }) => {
        const dialog = await openDeleteDialog(canvasElement);
        await userEvent.click(dialog.getByRole("button", { name: "Delete report" }));
        const body = within(canvasElement.ownerDocument.body);
        await expect(
            await body.findByText(/too many linked notifications/u)
        ).toBeVisible();
    },
};

export const DeleteError: Story = {
    args: {
        fixtures: reportFixtures({
            mutations: {
                "reports.delete": dashboardStoryFailure(
                    new TypeError("Safe report deletion story failure")
                ),
            },
        }),
        route: selectedReportRoute(),
    },
    play: async ({ canvasElement }) => {
        const dialog = await openDeleteDialog(canvasElement);
        await userEvent.click(dialog.getByRole("button", { name: "Delete report" }));
        const body = within(canvasElement.ownerDocument.body);
        await expect(
            await body.findByText("The request could not be completed. Try again.")
        ).toBeVisible();
    },
};
