import type { Meta, StoryObj } from "@storybook/tanstack-react";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";
import * as v from "valibot";

import type { OpenClawCronJob } from "../../../contracts/openClawCron.ts";
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
            number: 232,
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
            number: 233,
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
            number: 234,
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
            number: 235,
            priority: "low",
            status: "done",
            title: "Lock the reviewed Storybook package versions",
            updatedAtMs: storyLoadedAtMs - 2 * 86_400_000,
            version: 7,
        },
    ].map((task) => v.parse(taskSummarySchema, task)) satisfies readonly TaskSummary[]
);
const disabledCronJob = {
    agentIdTruncated: false,
    createdAtMs: storyLoadedAtMs - 30 * 86_400_000,
    deliveryMode: "unspecified",
    descriptionTruncated: false,
    enabled: false,
    id: "heartbeat-cache-refresh",
    name: "Heartbeat cache refresh",
    nameTruncated: false,
    payload: { kind: "heartbeat" },
    schedule: { everyMs: 3_600_000, kind: "every", truncated: false },
    sessionTarget: "main",
    source: "openclaw",
    state: { lastRunStatus: "ok", nextRunAtMs: storyLoadedAtMs + 3_600_000 },
    synchronization: { state: "confirmed" },
    updatedAtMs: storyLoadedAtMs - 8 * 60_000,
    wakeMode: "next-heartbeat",
} as const satisfies OpenClawCronJob;

const meta = {
    args: {
        cronJobsById: new Map([[disabledCronJob.id, disabledCronJob]]),
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
} satisfies Meta<typeof TaskBoard>;

export default meta;

type Story = StoryObj<typeof meta>;

export const DeliveryStates: Story = {
    play: async ({ args, canvasElement }) => {
        const task = tasks[0];
        if (task === undefined) throw new Error("The task fixture is missing.");

        await userEvent.click(
            within(canvasElement).getByRole("button", {
                name: `Open task #${task.number}: ${task.title}`,
            })
        );
        await expect(args.onSelectTask).toHaveBeenCalledWith(task.id);
        await expect(within(canvasElement).getByText("Recurring")).toBeVisible();
        await expect(within(canvasElement).getByText("Disabled")).toBeVisible();
    },
};

export const KeyboardMove: Story = {
    play: async ({ args, canvasElement }) => {
        const task = tasks[0];
        if (task === undefined) throw new Error("The task fixture is missing.");
        const taskAction = within(canvasElement).getByRole("button", {
            name: `Open task #${task.number}: ${task.title}`,
        });
        const targetColumn = within(canvasElement)
            .getByRole("heading", { name: "In progress" })
            .closest("section");
        if (targetColumn === null) throw new Error("The target column is missing.");

        const sourceBounds = taskAction.getBoundingClientRect();
        const targetBounds = targetColumn.getBoundingClientRect();
        const horizontalDistance =
            targetBounds.x +
            targetBounds.width / 2 -
            (sourceBounds.x + sourceBounds.width / 2);
        const verticalDistance =
            targetBounds.y +
            targetBounds.height / 2 -
            (sourceBounds.y + sourceBounds.height / 2);
        const horizontalMoveKey = horizontalDistance > 0 ? "{ArrowRight}" : "{ArrowLeft}";
        const verticalMoveKey = verticalDistance > 0 ? "{ArrowDown}" : "{ArrowUp}";
        const moveKey =
            Math.abs(horizontalDistance) > Math.abs(verticalDistance)
                ? horizontalMoveKey
                : verticalMoveKey;
        const moveCount = Math.ceil(
            Math.max(Math.abs(horizontalDistance), Math.abs(verticalDistance)) / 50
        );
        taskAction.focus();
        await expect(taskAction).toHaveFocus();

        await userEvent.keyboard("[Space]");
        await waitFor(async () => {
            await expect(taskAction).toHaveAttribute("aria-grabbed", "true");
        });
        await userEvent.keyboard(`{Shift>}${moveKey.repeat(moveCount)}{/Shift}`);
        await waitFor(async () => {
            await expect(
                within(canvasElement.ownerDocument.body).getByRole("status")
            ).toHaveTextContent("droppable target task-column:in-progress");
        });
        await userEvent.keyboard("[Space]");

        await waitFor(async () => {
            await expect(args.onMoveTask).toHaveBeenCalledWith({
                expectedVersion: task.version,
                id: task.id,
                status: "in-progress",
            });
        });
        await waitFor(async () => {
            await expect(taskAction).toHaveAttribute("aria-grabbed", "false");
        });
        await waitFor(
            async () => {
                await expect(
                    canvasElement.querySelector("[data-dnd-overlay]")
                ).toBeEmptyDOMElement();
            },
            { timeout: 5000 }
        );
        await expect(args.onSelectTask).not.toHaveBeenCalled();
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
