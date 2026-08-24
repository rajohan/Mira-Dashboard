import type { Meta, StoryObj } from "@storybook/tanstack-react";
import { expect, userEvent, waitFor, within } from "storybook/test";

import type {
    GetOpenClawCronResult,
    ListOpenClawCronResult,
} from "../../../contracts/openClawCron.ts";
import type {
    TaskDetail,
    TaskProgressUpdate,
    TaskSummary,
} from "../../../contracts/taskModel.ts";
import { DashboardPageStory } from "../../storySupport/dashboardPageStoryHarness.tsx";
import {
    dashboardStoryFailure,
    dashboardStoryResolver,
    dashboardStoryValue,
    type DashboardStoryFixtures,
} from "../../storySupport/dashboardStoryTransport.ts";

const observedAtMs = Date.now();
const taskId = "019fe900-0000-7000-8000-000000000020";
const task = {
    assignee: "mira-2026",
    createdAtMs: observedAtMs - 86_400_000,
    id: taskId,
    labels: ["frontend", "storybook"],
    number: 232,
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
const recurringBoardTask = {
    assignee: "mira-2026",
    automation: {
        cronJobId: "storybook-recurring-maintenance",
        kind: "openclaw-cron",
        model: "openai/gpt-5.6-sol",
        recurring: true,
        scheduleSummary: "Every hour",
        sessionTarget: "isolated",
        thinking: "high",
    },
    createdAtMs: observedAtMs - 8 * 86_400_000,
    id: "019fe900-0000-7000-8000-000000000023",
    labels: ["automation", "operations"],
    number: 233,
    priority: "medium",
    status: "in-progress",
    title: "Run recurring Dashboard maintenance",
    updatedAtMs: observedAtMs - 12 * 60_000,
    version: 4,
} as const satisfies TaskSummary;
const populatedTask = {
    ...task,
    automation: {
        cronJobId: "storybook-task-detail-refresh",
        kind: "openclaw-cron",
        model: "openai/gpt-5.6-sol",
        recurring: true,
        scheduleSummary: "Every 15 minutes",
        sessionTarget: "isolated",
        thinking: "high",
    },
    labels: ["automation", "frontend", "markdown", "storybook"],
    status: "in-progress",
    updatedAtMs: observedAtMs - 8 * 60_000,
    version: 8,
} as const satisfies TaskSummary;
const populatedTaskDetail = {
    ...populatedTask,
    bodyMarkdown: [
        "## Goal",
        "",
        "Render a realistic task detail with **GitHub-flavored Markdown**, linked automation and auditable progress.",
        "",
        "### Acceptance criteria",
        "",
        "- Load labels and automation metadata",
        "- Render fenced code through the shared highlighter",
        "- Complete the final visual review",
        "",
        "~~~tsx",
        'type DetailState = { progressUpdates: number; state: "ready" };',
        'const detail: DetailState = { progressUpdates: 2, state: "ready" };',
        "~~~",
    ].join("\n"),
} satisfies TaskDetail;
const populatedTaskCron = {
    freshness: { kind: "fresh", observedAtMs },
    job: {
        agentId: "main",
        agentIdTruncated: false,
        createdAtMs: observedAtMs - 30 * 86_400_000,
        deliveryMode: "unspecified",
        descriptionTruncated: false,
        enabled: true,
        id: "storybook-task-detail-refresh",
        name: "Task detail refresh",
        nameTruncated: false,
        payload: {
            kind: "agent-turn",
            message: "Refresh the linked task detail",
            model: "openai/gpt-5.6-sol",
            thinking: "high",
            truncated: false,
        },
        schedule: { everyMs: 15 * 60_000, kind: "every", truncated: false },
        sessionTarget: "isolated",
        source: "openclaw",
        state: {
            lastDurationMs: 42_000,
            lastRunAtMs: observedAtMs - 7 * 60_000,
            lastRunStatus: "ok",
            nextRunAtMs: observedAtMs + 8 * 60_000,
        },
        synchronization: { state: "confirmed" },
        updatedAtMs: observedAtMs - 7 * 60_000,
        wakeMode: "now",
    },
} as const satisfies GetOpenClawCronResult;
const disabledPopulatedTaskCron = {
    ...populatedTaskCron,
    job: { ...populatedTaskCron.job, enabled: false },
} as const satisfies GetOpenClawCronResult;
const recurringBoardCronJob = {
    ...populatedTaskCron.job,
    enabled: false,
    id: "storybook-recurring-maintenance",
    name: "Recurring Dashboard maintenance",
    schedule: { everyMs: 3_600_000, kind: "every", truncated: false },
} as const satisfies GetOpenClawCronResult["job"];

function cronInventory(
    jobs: readonly GetOpenClawCronResult["job"][]
): ListOpenClawCronResult {
    return {
        freshness: { kind: "fresh", observedAtMs },
        hasMore: false,
        jobs: [...jobs],
        limit: 100,
        offset: 0,
        snapshotRevision: `sha256:${"A".repeat(43)}`,
        total: jobs.length,
    };
}

const recurringBoardCronInventory = cronInventory([recurringBoardCronJob]);
const populatedCronInventory = cronInventory([populatedTaskCron.job]);
const disabledPopulatedCronInventory = cronInventory([disabledPopulatedTaskCron.job]);
const populatedTaskProgressUpdates = [
    {
        author: {
            id: "storybook-task-runner",
            kind: "automation",
            label: "Storybook task runner",
        },
        createdAtMs: observedAtMs - 10 * 60_000,
        id: "019fe900-0000-7000-8000-000000000022",
        messageMarkdown: [
            "Published the populated detail fixture and verified its contract output.",
            "",
            "~~~json",
            '{ "detail": "populated", "progressUpdates": 2 }',
            "~~~",
        ].join("\n"),
        taskId,
        updatedAtMs: observedAtMs - 9 * 60_000,
        version: 2,
    },
    {
        author: {
            id: "019fd974-54a2-74dd-a64b-d4186f8d8828",
            kind: "user",
            username: "raymond",
        },
        createdAtMs: observedAtMs - 45 * 60_000,
        id: "019fe900-0000-7000-8000-000000000021",
        messageMarkdown:
            "### Review notes\n\n- Confirmed labels wrap without clipping.\n- Kept raw HTML disabled.",
        taskId,
        updatedAtMs: observedAtMs - 45 * 60_000,
        version: 1,
    },
] as const satisfies readonly TaskProgressUpdate[];
const taskPage = { tasks: [task, recurringBoardTask] } as const;
const populatedTaskPage = { tasks: [populatedTask] } as const;
const emptyTaskPage = { tasks: [] } as const;
const taskLabelSuggestions = {
    labels: ["automation", "frontend", "markdown", "operations", "storybook"],
    truncated: false,
} as const;
const notifications = { notifications: [], readCount: 0, unreadCount: 0 } as const;

function taskFixtures({
    cron,
    cronList = dashboardStoryValue(recurringBoardCronInventory),
    detail = dashboardStoryValue(taskDetail),
    list = dashboardStoryValue(taskPage),
    mutations = {},
    progress = dashboardStoryValue({ updates: [] }),
}: {
    readonly cron?: ReturnType<typeof dashboardStoryValue>;
    readonly cronList?: ReturnType<typeof dashboardStoryValue>;
    readonly detail?: ReturnType<typeof dashboardStoryValue>;
    readonly list?: ReturnType<typeof dashboardStoryValue>;
    readonly mutations?: DashboardStoryFixtures["mutations"];
    readonly progress?: ReturnType<typeof dashboardStoryValue>;
} = {}): DashboardStoryFixtures {
    return {
        mutations,
        queries: {
            ...(cron === undefined ? {} : { "openClawCron.get": cron }),
            "openClawCron.list": cronList,
            "notifications.list": dashboardStoryValue(notifications),
            "tasks.get": detail,
            "tasks.list": list,
            "tasks.listLabels": dashboardStoryValue(taskLabelSuggestions),
            "tasks.listUpdates": progress,
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
    const taskAction = await within(canvasElement).findByRole("button", {
        name: `Open task #${task.number}: ${task.title}`,
    });
    taskAction.focus();
    await userEvent.keyboard("[Space]");
    await userEvent.keyboard(
        "{Shift>}{ArrowRight}{ArrowRight}{ArrowRight}{ArrowRight}{ArrowRight}{ArrowRight}{/Shift}"
    );
    await userEvent.keyboard("[Space]");
    await waitFor(
        async () => {
            await expect(
                canvasElement.querySelector("[data-dnd-overlay]")
            ).toBeEmptyDOMElement();
        },
        { timeout: 5000 }
    );
}

const meta = {
    component: DashboardPageStory,
    parameters: { layout: "fullscreen" },
    render: (args, context) => <DashboardPageStory {...args} key={context.id} />,
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
        const assigneeFilter = await canvas.findByRole(
            "button",
            { name: "Filter tasks by assignee" },
            { timeout: 5000 }
        );
        await waitFor(
            async () => {
                await expect(assigneeFilter).toBeEnabled();
            },
            { timeout: 5000 }
        );
        await userEvent.click(assigneeFilter);
        await userEvent.click(
            await within(canvasElement.ownerDocument.body).findByRole("option", {
                name: "Raymond",
            })
        );
        await waitFor(
            async () => {
                await expect(
                    canvas.getByRole("heading", { name: "No matching tasks" })
                ).toBeVisible();
            },
            { timeout: 5000 }
        );
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
                name: `Open task #${task.number}: ${task.title}`,
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
        const trigger = await canvas.findByRole(
            "button",
            { name: "New task" },
            { timeout: 5000 }
        );
        await waitFor(
            async () => {
                await expect(trigger).toBeEnabled();
            },
            { timeout: 5000 }
        );
        await userEvent.click(trigger);
        const dialog = await waitFor(
            () =>
                within(canvasElement.ownerDocument.body).getByRole("dialog", {
                    name: "New task",
                }),
            { timeout: 5000 }
        );
        await expect(dialog).toBeVisible();
    },
};

export const DetailModal: Story = {
    args: { fixtures: taskFixtures(), route: "/tasks" },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        await userEvent.click(
            await canvas.findByRole("button", {
                name: `Open task #${task.number}: ${task.title}`,
            })
        );
        const body = within(canvasElement.ownerDocument.body);
        await expect(
            await body.findByRole("dialog", {
                name: `#${task.number}: ${task.title}`,
            })
        ).toBeVisible();
    },
};

export const PopulatedDetailModal: Story = {
    args: {
        fixtures: taskFixtures({
            cron: dashboardStoryValue(populatedTaskCron),
            cronList: dashboardStoryValue(populatedCronInventory),
            detail: dashboardStoryValue(populatedTaskDetail),
            list: dashboardStoryValue(populatedTaskPage),
            progress: dashboardStoryValue({
                updates: populatedTaskProgressUpdates,
            }),
        }),
        route: "/tasks",
    },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        await userEvent.click(
            await canvas.findByRole("button", {
                name: `Open task #${populatedTask.number}: ${populatedTask.title}`,
            })
        );
        const body = within(canvasElement.ownerDocument.body);
        const dialog = await body.findByRole("dialog", {
            name: `#${populatedTask.number}: ${populatedTask.title}`,
        });
        const detail = within(dialog);

        await expect(detail.getByText("markdown")).toBeVisible();
        await expect(
            detail.getByRole("link", {
                name: "Open OpenClaw cron job storybook-task-detail-refresh",
            })
        ).toBeVisible();
        await expect(await detail.findByText("Succeeded")).toBeVisible();
        await expect(detail.getByText("Recurring")).toBeVisible();
        await expect(detail.getByText("Task detail refresh")).toBeVisible();
        await expect(detail.getByText("Every 15 minutes")).toBeVisible();
        await expect(
            detail.getByRole("heading", { name: "Acceptance criteria" })
        ).toBeVisible();
        await expect(
            await detail.findByText(
                "Published the populated detail fixture and verified its contract output."
            )
        ).toBeVisible();
        const automationUpdateAuthor = detail.getByTitle(
            "Audit identity: automation:storybook-task-runner"
        );
        await expect(automationUpdateAuthor).toBeVisible();
        await expect(automationUpdateAuthor).toHaveTextContent(
            "Automation · Storybook task runner"
        );
        const userUpdateAuthor = detail.getByTitle(
            "Audit identity: user:019fd974-54a2-74dd-a64b-d4186f8d8828"
        );
        await expect(userUpdateAuthor).toBeVisible();
        await expect(userUpdateAuthor).toHaveTextContent("@raymond");
        await expect(detail.queryByText("No progress updates")).not.toBeInTheDocument();

        const highlightedSources = await detail.findAllByTestId(
            "syntax-highlighted-source"
        );
        await expect(highlightedSources).toHaveLength(2);
        await expect(highlightedSources[0]).toHaveAttribute(
            "data-language",
            "typescript"
        );
        await expect(
            highlightedSources[0]?.querySelector(".hljs-keyword")
        ).toHaveTextContent("type");
        await expect(highlightedSources[1]).toHaveAttribute("data-language", "json");
    },
};

export const DisabledAutomationDetailModal: Story = {
    args: {
        fixtures: taskFixtures({
            cron: dashboardStoryValue(disabledPopulatedTaskCron),
            cronList: dashboardStoryValue(disabledPopulatedCronInventory),
            detail: dashboardStoryValue(populatedTaskDetail),
            list: dashboardStoryValue(populatedTaskPage),
            progress: dashboardStoryValue({ updates: populatedTaskProgressUpdates }),
        }),
        route: "/tasks",
    },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        const taskAction = await canvas.findByRole(
            "button",
            {
                name: `Open task #${populatedTask.number}: ${populatedTask.title}`,
            },
            { timeout: 5000 }
        );
        const taskCard = taskAction.closest("article");
        if (taskCard === null) throw new TypeError("Task card is missing");
        await expect(within(taskCard).getByText("Recurring")).toBeVisible();
        await expect(
            await within(taskCard).findByText("Disabled", {}, { timeout: 5000 })
        ).toBeVisible();

        await userEvent.click(taskAction);
        const dialog = await within(canvasElement.ownerDocument.body).findByRole(
            "dialog",
            {
                name: `#${populatedTask.number}: ${populatedTask.title}`,
            }
        );
        const detail = within(dialog);
        await expect(await detail.findByText("Disabled")).toBeVisible();
        await expect(detail.getByText("Recurring")).toBeVisible();

        await userEvent.click(detail.getByRole("button", { name: "Close dialog" }));
        await waitFor(() => expect(dialog).not.toBeInTheDocument());
        await expect(canvas.getByText("Recurring")).toBeVisible();
        await expect(canvas.getByText("Disabled")).toBeVisible();
    },
};

export const Mobile: Story = {
    args: Board.args,
    parameters: { viewport: { defaultViewport: "mobile1" } },
};
