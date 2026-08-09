import type { Meta, StoryObj } from "@storybook/tanstack-react";
import type { ComponentProps } from "react";
import { useState } from "react";
import { useArgs } from "storybook/preview-api";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";

import { TaskBoardToolbar } from "../TaskBoardToolbar.tsx";

type TaskBoardToolbarProperties = ComponentProps<typeof TaskBoardToolbar>;

interface ControlledTaskBoardToolbarProperties {
    readonly properties: TaskBoardToolbarProperties;
    readonly updateProperties: (properties: Partial<TaskBoardToolbarProperties>) => void;
}

function ControlledTaskBoardToolbar({
    properties,
    updateProperties,
}: ControlledTaskBoardToolbarProperties) {
    const [assignee, setAssignee] = useState(properties.assignee);
    const [automation, setAutomation] = useState(properties.automation);
    const [search, setSearch] = useState(properties.search);

    return (
        <TaskBoardToolbar
            {...properties}
            assignee={assignee}
            automation={automation}
            onAssigneeChange={(nextAssignee) => {
                setAssignee(nextAssignee);
                updateProperties({ assignee: nextAssignee });
                properties.onAssigneeChange(nextAssignee);
            }}
            onAutomationChange={(nextAutomation) => {
                setAutomation(nextAutomation);
                updateProperties({ automation: nextAutomation });
                properties.onAutomationChange(nextAutomation);
            }}
            onSearchChange={(nextSearch) => {
                setSearch(nextSearch);
                updateProperties({ search: nextSearch });
                properties.onSearchChange(nextSearch);
            }}
            search={search}
        />
    );
}

function RenderControlledTaskBoardToolbar(properties: TaskBoardToolbarProperties) {
    const [, updateProperties] = useArgs<TaskBoardToolbarProperties>();

    return (
        <ControlledTaskBoardToolbar
            key={`${properties.assignee}:${properties.automation}:${properties.search}`}
            properties={properties}
            updateProperties={updateProperties}
        />
    );
}

const meta = {
    args: {
        assignee: "all",
        automation: "all",
        busy: false,
        onAssigneeChange: fn(),
        onAutomationChange: fn(),
        onCreate: fn(),
        onSearchChange: fn(),
        search: "",
    },
    component: TaskBoardToolbar,
    parameters: {
        layout: "padded",
    },
    render: RenderControlledTaskBoardToolbar,
    title: "Tasks/TaskBoardToolbar",
} satisfies Meta<typeof TaskBoardToolbar>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
    play: async ({ args, canvasElement }) => {
        const search = within(canvasElement).getByRole("searchbox", {
            name: "Search tasks",
        });

        await userEvent.type(search, "cache");
        await waitFor(async () => {
            await expect(
                within(canvasElement).getByRole("searchbox", {
                    name: "Search tasks",
                })
            ).toHaveValue("cache");
        });
        await expect(args.onSearchChange).toHaveBeenLastCalledWith("cache");
    },
};

export const Filtered: Story = {
    args: {
        assignee: "mira-2026",
        automation: "recurring",
        search: "worker",
    },
};

export const Busy: Story = {
    args: {
        busy: true,
    },
};
