import type { Meta, StoryObj } from "@storybook/tanstack-react";
import { expect, userEvent, within } from "storybook/test";

import type { TaskDetail, TaskSummary } from "../../../contracts/taskModel.ts";
import { DashboardPageStory } from "../../storySupport/dashboardPageStoryHarness.tsx";
import {
    dashboardStoryFailure,
    dashboardStoryResolver,
    dashboardStoryValue,
    type DashboardStoryFixtures,
} from "../../storySupport/dashboardStoryTransport.ts";

const observedAtMs = 1_800_000_000_000;
const taskId = "019fe900-0000-7000-8000-000000000020";
const task = {
    assignee: "mira-2026",
    createdAtMs: observedAtMs - 86_400_000,
    id: taskId,
    labels: ["frontend", "storybook"],
    priority: "high",
    status: "todo",
    title: "Review every full-page Dashboard story",
    updatedAtMs: observedAtMs,
    version: 3,
} as const satisfies TaskSummary;
const taskDetail = {
    ...task,
    bodyMarkdown:
        "Verify the populated, empty, loading, failure, confirmation and mobile states.",
} as const satisfies TaskDetail;
const taskPage = { tasks: [task] } as const;
const emptyTaskPage = { tasks: [] } as const;
const notifications = { notifications: [], readCount: 0, unreadCount: 0 } as const;

function taskFixtures({
    list = dashboardStoryValue(taskPage),
    mutations = {},
}: {
    readonly list?: ReturnType<typeof dashboardStoryValue>;
    readonly mutations?: DashboardStoryFixtures["mutations"];
} = {}): DashboardStoryFixtures {
    return {
        mutations,
        queries: {
            "notifications.list": dashboardStoryValue(notifications),
            "tasks.get": dashboardStoryValue(taskDetail),
            "tasks.list": list,
            "tasks.listUpdates": dashboardStoryValue({ updates: [] }),
        },
    };
}

const pending = dashboardStoryResolver(
    () =>
        new Promise<never>(() => {
            // Intentionally pending to preserve a loading or mutation-busy state.
        })
);

async function moveFirstTask(canvasElement: HTMLElement) {
    const moveHandle = await within(canvasElement).findByRole("button", {
        name: `Move task: ${task.title}`,
    });
    moveHandle.focus();
    await userEvent.keyboard("[Space]");
    await userEvent.keyboard("{Shift>}{ArrowRight}{/Shift}");
    await userEvent.keyboard("[Space]");
}

const meta = {
    component: DashboardPageStory,
    parameters: { layout: "fullscreen" },
    title: "Pages/Tasks",
} satisfies Meta<typeof DashboardPageStory>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Loading: Story = {
    args: { fixtures: taskFixtures({ list: pending }), route: "/tasks" },
};

export const Board: Story = {
    args: { fixtures: taskFixtures(), route: "/tasks" },
};

export const Empty: Story = {
    args: {
        fixtures: taskFixtures({ list: dashboardStoryValue(emptyTaskPage) }),
        route: "/tasks",
    },
};

export const FilteredEmpty: Story = {
    args: {
        fixtures: taskFixtures({
            list: dashboardStoryResolver((input) =>
                typeof input === "object" &&
                input !== null &&
                "filters" in input &&
                input.filters !== undefined
                    ? emptyTaskPage
                    : taskPage
            ),
        }),
        route: "/tasks",
    },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        await userEvent.type(
            await canvas.findByRole("searchbox", { name: "Search tasks" }),
            "no-match"
        );
        await expect(
            await canvas.findByRole("heading", { name: "No matching tasks" })
        ).toBeVisible();
    },
};

export const InitialError: Story = {
    args: {
        fixtures: taskFixtures({
            list: dashboardStoryFailure(new TypeError("Safe task story failure")),
        }),
        route: "/tasks",
    },
};

export const Busy: Story = {
    args: {
        fixtures: taskFixtures({ mutations: { "tasks.move": pending } }),
        route: "/tasks",
    },
    play: async ({ canvasElement }) => {
        await moveFirstTask(canvasElement);
        await expect(
            within(canvasElement).getByRole("button", {
                name: `Move task: ${task.title}`,
            })
        ).toBeDisabled();
    },
};

export const Error: Story = {
    args: {
        fixtures: taskFixtures({
            mutations: {
                "tasks.move": dashboardStoryFailure(
                    new TypeError("Safe task mutation story failure")
                ),
            },
        }),
        route: "/tasks",
    },
    play: async ({ canvasElement }) => {
        await moveFirstTask(canvasElement);
        await expect(
            await within(canvasElement).findByText(
                "The request could not be completed. Try again."
            )
        ).toBeVisible();
    },
};

export const CreateModal: Story = {
    args: { fixtures: taskFixtures(), route: "/tasks" },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        await userEvent.click(await canvas.findByRole("button", { name: "Create task" }));
        await expect(
            await canvas.findByRole("dialog", { name: "New task" })
        ).toBeVisible();
    },
};

export const DetailModal: Story = {
    args: { fixtures: taskFixtures(), route: "/tasks" },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        await userEvent.click(
            await canvas.findByRole("button", { name: `Open task: ${task.title}` })
        );
        await expect(
            await canvas.findByRole("dialog", { name: task.title })
        ).toBeVisible();
    },
};

export const Mobile: Story = {
    args: Board.args,
    parameters: { viewport: { defaultViewport: "mobile1" } },
};
