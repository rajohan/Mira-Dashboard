import type { Meta, StoryObj } from "@storybook/tanstack-react";
import { expect, fn, userEvent, within } from "storybook/test";

import { InfiniteScrollTrigger } from "../InfiniteScrollTrigger.tsx";

const metadata = {
    component: InfiniteScrollTrigger,
    parameters: { layout: "padded" },
} satisfies Meta<typeof InfiniteScrollTrigger>;

export default metadata;

type Story = StoryObj<typeof metadata>;

export const Loading: Story = {
    args: {
        hasMore: true,
        loading: true,
        loadingLabel: "Loading older rows…",
        onLoadMore: fn(),
    },
    play: async ({ canvasElement }) => {
        await expect(
            within(canvasElement).getByLabelText("Loading older rows…")
        ).toBeVisible();
    },
};

export const Retry: Story = {
    args: {
        error: "Older rows are unavailable.",
        hasMore: true,
        loading: false,
        loadingLabel: "Loading older rows…",
        onLoadMore: fn(),
    },
    play: async ({ args, canvasElement }) => {
        await userEvent.click(
            within(canvasElement).getByRole("button", { name: "Try again" })
        );
        await expect(args.onLoadMore).toHaveBeenCalledOnce();
    },
};
