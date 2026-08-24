import type { Meta, StoryObj } from "@storybook/tanstack-react";
import { expect, userEvent, waitFor, within } from "storybook/test";

import { Heading } from "../Heading.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "../Popover.tsx";
import { Text } from "../Text.tsx";

const meta = {
    args: {
        children: null,
    },
    component: Popover,
} satisfies Meta<typeof Popover>;

export default meta;

type Story = StoryObj<typeof meta>;

export const AnchoredPanel: Story = {
    render: () => (
        <Popover>
            <PopoverTrigger variant="secondary">Queue controls</PopoverTrigger>
            <PopoverContent>
                <Heading level={3}>Queue controls</Heading>
                <Text className="mt-2" tone="muted">
                    Pause new claims while active runs finish normally.
                </Text>
            </PopoverContent>
        </Popover>
    ),
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        const trigger = canvas.getByRole("button", { name: "Queue controls" });

        await userEvent.click(trigger);
        const panelId = await waitFor(() => {
            const id = trigger.getAttribute("aria-controls");

            if (id === null) {
                throw new Error("The queue controls popover did not expose its panel.");
            }

            return id;
        });
        await waitFor(async () => {
            const panel = canvasElement.ownerDocument.querySelector(
                `#${globalThis.CSS.escape(panelId)}`
            );

            if (!(panel instanceof HTMLElement)) {
                throw new Error("The queue controls popover panel was not mounted.");
            }

            await expect(
                within(panel).getByRole("heading", { name: "Queue controls" })
            ).toBeVisible();
        });
        await userEvent.keyboard("{Escape}");
        await waitFor(async () => {
            await expect(trigger).toHaveAttribute("aria-expanded", "false");
            await expect(
                canvasElement.ownerDocument.querySelector(
                    `#${globalThis.CSS.escape(panelId)}`
                )
            ).not.toBeInTheDocument();
            await expect(trigger).toHaveFocus();
        });
    },
};

export const StartAligned: Story = {
    render: () => (
        <Popover>
            <PopoverTrigger variant="ghost">View details</PopoverTrigger>
            <PopoverContent align="start">
                <Text>Last refresh succeeded in 842 milliseconds.</Text>
            </PopoverContent>
        </Popover>
    ),
};

export const ViewportEdge: Story = {
    parameters: {
        layout: "fullscreen",
    },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        const trigger = canvas.getByRole("button", { name: "Open edge panel" });

        await userEvent.click(trigger);
        await waitFor(async () => {
            const panelId = trigger.getAttribute("aria-controls");
            const panel =
                panelId === null
                    ? null
                    : canvasElement.ownerDocument.querySelector(
                          `#${globalThis.CSS.escape(panelId)}`
                      );

            if (!(panel instanceof HTMLElement)) {
                throw new Error("The edge popover panel was not mounted.");
            }

            const bounds = panel.getBoundingClientRect();
            await expect(bounds.left).toBeGreaterThanOrEqual(8);
            await expect(bounds.right).toBeLessThanOrEqual(
                (canvasElement.ownerDocument.defaultView?.innerWidth ?? 0) - 8
            );
        });
    },
    render: () => (
        <Popover>
            <PopoverTrigger variant="secondary">Open edge panel</PopoverTrigger>
            <PopoverContent align="start">
                <Text>The panel keeps a safe distance from the viewport edge.</Text>
            </PopoverContent>
        </Popover>
    ),
};
