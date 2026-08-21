import type { Meta, StoryObj } from "@storybook/tanstack-react";
import type { ComponentProps } from "react";
import { useState } from "react";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";

import { Tabs, type TabDefinition } from "../Tabs.tsx";

type WorkerView = "history" | "overview" | "settings";
type WorkerTabsProperties = ComponentProps<typeof Tabs<WorkerView>>;

const workerTabs = Object.freeze([
    {
        label: "Overview",
        panel: (
            <div className="border-primary-700 bg-primary-900 rounded-lg border p-4">
                Current capacity: 3 of 4 workers available.
            </div>
        ),
        value: "overview",
    },
    {
        label: "History",
        panel: (
            <div className="border-primary-700 bg-primary-900 rounded-lg border p-4">
                The latest five runs completed successfully.
            </div>
        ),
        value: "history",
    },
    {
        disabled: true,
        label: "Settings",
        panel: (
            <div className="border-primary-700 bg-primary-900 rounded-lg border p-4">
                Settings are code-owned for this worker.
            </div>
        ),
        value: "settings",
    },
] satisfies readonly TabDefinition<WorkerView>[]);

interface WorkerTabsStoryProperties {
    readonly className: string;
    readonly properties: WorkerTabsProperties;
}

function WorkerTabsStory({ className, properties }: WorkerTabsStoryProperties) {
    const [value, setValue] = useState(properties.value);

    return (
        <div className={className}>
            <Tabs
                {...properties}
                onChange={(nextValue) => {
                    setValue(nextValue);
                    properties.onChange(nextValue);
                }}
                value={value}
            />
        </div>
    );
}

function RenderControlledWorkerTabs(properties: WorkerTabsProperties) {
    return (
        <WorkerTabsStory
            className="w-full max-w-3xl"
            key={properties.value}
            properties={properties}
        />
    );
}

function RenderNarrowWorkerTabs(properties: WorkerTabsProperties) {
    return (
        <WorkerTabsStory
            className="w-56 max-w-full"
            key={properties.value}
            properties={properties}
        />
    );
}

const meta = {
    args: {
        ariaLabel: "Worker details",
        description: "Choose one worker detail view.",
        onChange: fn(),
        tabs: workerTabs,
        value: "overview",
    },
    component: Tabs,
    parameters: {
        layout: "padded",
    },
    render: RenderControlledWorkerTabs,
} satisfies Meta<typeof Tabs<WorkerView>>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const SelectedTabKeepsItsSurfaceOnHover: Story = {
    play: async ({ canvasElement }) => {
        const overview = within(canvasElement).getByRole("tab", {
            name: "Overview",
        });
        const selectedBackground = getComputedStyle(overview).backgroundColor;
        const selectedText = getComputedStyle(overview).color;

        await userEvent.hover(overview);
        await waitFor(async () => {
            await expect(getComputedStyle(overview).backgroundColor).toBe(
                selectedBackground
            );
            await expect(getComputedStyle(overview).color).toBe(selectedText);
        });
    },
};

export const Vertical: Story = {
    args: {
        vertical: true,
    },
};

export const Narrow: Story = {
    render: RenderNarrowWorkerTabs,
};

export const KeyboardNavigation: Story = {
    play: async ({ args, canvasElement }) => {
        const canvas = within(canvasElement);
        const overview = canvas.getByRole("tab", { name: "Overview" });

        await userEvent.tab();
        await expect(overview).toHaveFocus();
        await userEvent.keyboard("{ArrowRight}");
        await waitFor(async () => {
            await expect(canvas.getByRole("tab", { name: "History" })).toHaveAttribute(
                "aria-selected",
                "true"
            );
            await expect(canvas.getByRole("tabpanel")).toHaveTextContent(
                "The latest five runs completed successfully."
            );
        });
        await expect(args.onChange).toHaveBeenLastCalledWith("history");
    },
};

export const ManualActivation: Story = {
    args: {
        manual: true,
    },
    play: async ({ args, canvasElement }) => {
        const canvas = within(canvasElement);
        const history = canvas.getByRole("tab", { name: "History" });
        const overview = canvas.getByRole("tab", { name: "Overview" });

        await userEvent.tab();
        await expect(overview).toHaveFocus();
        await userEvent.keyboard("{ArrowRight}");

        await expect(history).toHaveFocus();
        await expect(overview).toHaveAttribute("aria-selected", "true");
        await expect(history).toHaveAttribute("aria-selected", "false");
        await expect(canvas.getByRole("tabpanel")).toHaveTextContent(
            "Current capacity: 3 of 4 workers available."
        );
        await expect(args.onChange).not.toHaveBeenCalled();

        await userEvent.keyboard("{Enter}");
        await waitFor(async () => {
            await expect(history).toHaveAttribute("aria-selected", "true");
            await expect(canvas.getByRole("tabpanel")).toHaveTextContent(
                "The latest five runs completed successfully."
            );
        });
        await expect(args.onChange).toHaveBeenLastCalledWith("history");
    },
};
