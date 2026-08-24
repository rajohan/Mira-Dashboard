import type { Meta, StoryObj } from "@storybook/tanstack-react";
import * as v from "valibot";

import type { AgentTaskRun } from "../../../contracts/agentModel.ts";
import { listAgentTaskHistoryResultSchema } from "../../../contracts/agents.ts";
import {
    expectResponsiveTableCards,
    expectResponsiveVirtualizedTableTransition,
    expectVirtualizedTable,
} from "../../storySupport/virtualizationAssertions.ts";
import { AgentHistoryTable } from "../AgentHistoryTable.tsx";

const timestampMs = 1_800_000_000_000;

const runs = Object.freeze(
    v.parse(listAgentTaskHistoryResultSchema, {
        runs: [
            {
                agentId: "mira-2026",
                id: "019fe000-0000-7000-8000-000000000002",
                lastActivityAtMs: timestampMs,
                startedAtMs: timestampMs - 25 * 60_000,
                status: "active",
                task: "Expand the reviewed Storybook component catalog",
            },
            {
                agentId: "coder",
                completedAtMs: timestampMs - 45 * 60_000,
                id: "019fe000-0000-7000-8000-000000000001",
                lastActivityAtMs: timestampMs - 46 * 60_000,
                startedAtMs: timestampMs - 95 * 60_000,
                status: "completed",
                task: "Verify browser typecheck and source boundaries",
            },
        ] satisfies readonly AgentTaskRun[],
    }).runs
);

function historyRun(index: number): AgentTaskRun {
    const startedAtMs = timestampMs - index * 60_000;
    const common = {
        agentId: index % 2 === 0 ? "mira-2026" : "coder",
        id: `019fe010-0000-7000-8000-${index.toString().padStart(12, "0")}`,
        startedAtMs,
        task: `Review catalog component ${index.toString().padStart(2, "0")}`,
    } as const;
    if (index % 7 === 0) {
        return {
            ...common,
            lastActivityAtMs: startedAtMs + 30_000,
            status: "active",
        };
    }
    return {
        ...common,
        completedAtMs: startedAtMs + 45_000,
        lastActivityAtMs: startedAtMs + 30_000,
        status: "completed",
    };
}

const virtualizedRuns = Object.freeze(
    v.parse(listAgentTaskHistoryResultSchema, {
        runs: Array.from({ length: 50 }, (_, index) => historyRun(index)),
    }).runs
);

const meta = {
    args: {
        runs,
    },
    component: AgentHistoryTable,
    parameters: {
        layout: "padded",
    },
} satisfies Meta<typeof AgentHistoryTable>;

export default meta;

type Story = StoryObj<typeof meta>;

export const ActiveAndCompleted: Story = {};

export const ResponsiveMobileCards: Story = {
    render: (args) => (
        <div className="w-full max-w-80">
            <AgentHistoryTable {...args} />
        </div>
    ),
    play: async ({ canvasElement }) => {
        await expectResponsiveTableCards({
            canvasElement,
            label: "Agent task history",
        });
    },
};

export const ResponsiveVirtualizedCards: Story = {
    args: {
        runs: virtualizedRuns,
    },
    render: (args) => (
        <div className="w-full max-w-80" data-testid="responsive-virtual-table">
            <AgentHistoryTable {...args} />
        </div>
    ),
    play: async ({ canvasElement }) => {
        await expectResponsiveTableCards({
            canvasElement,
            label: "Agent task history",
        });
        await expectVirtualizedTable({
            canvasElement,
            fillCanvas: false,
            label: "Agent task history",
            rowCount: virtualizedRuns.length,
        });
        const responsiveContainer = canvasElement.querySelector<HTMLElement>(
            '[data-testid="responsive-virtual-table"]'
        );
        if (responsiveContainer === null) {
            throw new Error("The responsive virtual table container is missing.");
        }
        await expectResponsiveVirtualizedTableTransition({
            canvasElement,
            container: responsiveContainer,
            label: "Agent task history",
            rowCount: virtualizedRuns.length,
        });
    },
};

export const VirtualizedInventory: Story = {
    args: {
        runs: virtualizedRuns,
    },
    play: async ({ canvasElement }) => {
        await expectVirtualizedTable({
            canvasElement,
            label: "Agent task history",
            rowCount: virtualizedRuns.length,
        });
    },
};

export const Empty: Story = {
    args: {
        runs: [],
    },
};
