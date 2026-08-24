import type { Meta, StoryObj } from "@storybook/tanstack-react";
import { expect, fireEvent, userEvent, within } from "storybook/test";

import generatedDocuments from "../../../../docs/generated/browser-reference.json";
import { DashboardPageStory } from "../../storySupport/dashboardPageStoryHarness.tsx";
import { dashboardStoryValue } from "../../storySupport/dashboardStoryTransport.ts";

const fixtures = {
    queries: {
        "notifications.list": dashboardStoryValue({
            notifications: [],
            readCount: 0,
            unreadCount: 0,
        }),
        "system.documentationReference": dashboardStoryValue(generatedDocuments),
    },
};

const meta = {
    component: DashboardPageStory,
    parameters: { layout: "fullscreen" },
    render: (args, context) => <DashboardPageStory {...args} key={context.id} />,
} satisfies Meta<typeof DashboardPageStory>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Ready: Story = {
    args: { fixtures, route: "/docs" },
};

export const Search: Story = {
    args: Ready.args,
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        await fireEvent.change(
            await canvas.findByRole("searchbox", { name: "Search documentation" }),
            { target: { value: "Mira Dashboard raw HTTP API" } }
        );
        await expect(
            canvas.getByText("openapi.raw-http.json", { selector: "p" })
        ).toBeVisible();
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
