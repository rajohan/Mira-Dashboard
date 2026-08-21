import type { Meta, StoryObj } from "@storybook/tanstack-react";
import { expect, userEvent, within } from "storybook/test";

import { DashboardPageStory } from "../../storySupport/dashboardPageStoryHarness.tsx";

const meta = {
    component: DashboardPageStory,
    parameters: { layout: "fullscreen" },
    render: (args, context) => <DashboardPageStory {...args} key={context.id} />,
} satisfies Meta<typeof DashboardPageStory>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Ready: Story = {
    args: { route: "/docs" },
};

export const Search: Story = {
    args: Ready.args,
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        await userEvent.type(
            await canvas.findByRole("searchbox", { name: "Search documentation" }),
            "Mira Dashboard raw HTTP API"
        );
        await expect(canvas.getByText("openapi.raw http")).toBeVisible();
    },
};

export const Schema: Story = {
    args: Ready.args,
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        await userEvent.click(
            await canvas.findByRole("link", { name: "tRPC procedures" })
        );
        const inputLinks = await canvas.findAllByRole("link", { name: "input" });
        await userEvent.click(inputLinks[0]!);
        await expect(canvas.getByTestId("source-viewer-toolbar")).toHaveTextContent(
            "JSON"
        );
    },
};
