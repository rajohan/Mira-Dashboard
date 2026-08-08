import type { Meta, StoryObj } from "@storybook/tanstack-react";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";
import * as v from "valibot";

import { type TaskSummary, taskSummarySchema } from "../../../contracts/taskModel.ts";
import { TaskBoard } from "../TaskBoard.tsx";

const storyLoadedAtMs = Date.now();

const tasks = Object.freeze(
    [
        {
            assignee: "mira-2026",
            createdAtMs: storyLoadedAtMs - 4 * 86_400_000,
            id: "019fe100-0000-7000-8000-000000000001",
            labels: ["frontend", "storybook"],
            priority: "high",
            status: "todo",
            title: "Document reusable Dashboard components",
            updatedAtMs: storyLoadedAtMs - 30 * 60_000,
            version: 3,
        },
        {
            assignee: "mira-2026",
            automation: {
                cronJobId: "heartbeat-cache-refresh",
                kind: "openclaw-cron",
                recurring: true,
                scheduleSummary: "Every hour",
            },
            createdAtMs: storyLoadedAtMs - 8 * 86_400_000,
            id: "019fe100-0000-7000-8000-000000000002",
            labels: ["cache", "operations", "realtime", "worker"],
            priority: "medium",
            status: "in-progress",
            title: "Reconcile cache freshness after worker completion",
            updatedAtMs: storyLoadedAtMs - 8 * 60_000,
            version: 5,
        },
        {
            assignee: "rajohan",
            createdAtMs: storyLoadedAtMs - 2 * 86_400_000,
            id: "019fe100-0000-7000-8000-000000000003",
            labels: ["release"],
            priority: "high",
            status: "blocked",
            title: "Approve the next greenfield stack cutover",
            updatedAtMs: storyLoadedAtMs - 3 * 60 * 60_000,
            version: 2,
        },
        {
            createdAtMs: storyLoadedAtMs - 12 * 86_400_000,
            id: "019fe100-0000-7000-8000-000000000004",
            labels: [],
            priority: "low",
            status: "done",
            title: "Lock the reviewed Storybook package versions",
            updatedAtMs: storyLoadedAtMs - 2 * 86_400_000,
            version: 7,
        },
    ].map((task) => v.parse(taskSummarySchema, task)) satisfies readonly TaskSummary[]
);

const meta = {
    args: {
        disabled: false,
        onMoveTask: fn(),
        onSelectTask: fn(),
        tasks,
    },
    component: TaskBoard,
    parameters: {
        docs: {
            canvas: {
                className: "storybook-task-board-docs",
            },
        },
        layout: "padded",
    },
    title: "Tasks/TaskBoard",
} satisfies Meta<typeof TaskBoard>;

export default meta;

type Story = StoryObj<typeof meta>;

export const DeliveryStates: Story = {
    play: async ({ args, canvasElement }) => {
        const task = tasks[0];
        if (task === undefined) throw new Error("The task fixture is missing.");

        await userEvent.click(
            within(canvasElement).getByRole("button", {
                name: `Open task: ${task.title}`,
            })
        );
        await expect(args.onSelectTask).toHaveBeenCalledWith(task.id);
    },
};

export const KeyboardMove: Story = {
    play: async ({ args, canvasElement }) => {
        const task = tasks[0];
        if (task === undefined) throw new Error("The task fixture is missing.");
        const moveHandle = within(canvasElement).getByRole("button", {
            name: `Move task: ${task.title}`,
        });
        moveHandle.focus();
        await expect(moveHandle).toHaveFocus();

        await userEvent.keyboard("[Space]");
        await userEvent.keyboard(
            "{Shift>}{ArrowRight}{ArrowRight}{ArrowRight}{ArrowRight}{ArrowRight}{ArrowRight}{/Shift}"
        );
        await userEvent.keyboard("[Space]");

        await waitFor(async () => {
            await expect(args.onMoveTask).toHaveBeenCalledWith({
                expectedVersion: task.version,
                id: task.id,
                status: "in-progress",
            });
        });
    },
};

export const Busy: Story = {
    args: {
        disabled: true,
    },
};

export const EmptyBoard: Story = {
    args: {
        tasks: [],
    },
};
