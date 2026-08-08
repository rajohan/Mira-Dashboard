import type { Meta, StoryObj } from "@storybook/tanstack-react";
import { createRootRoute, createRoute, Outlet } from "@tanstack/react-router";
import { expect, fn, within } from "storybook/test";

import { NavigationLink } from "../NavigationLink.tsx";

const rootRoute = createRootRoute({
    component: Outlet,
});
const agentsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/agents",
});
rootRoute.addChildren([agentsRoute]);

const meta = {
    args: {
        active: true,
        children: "Agents",
        onClick: fn(),
        to: "/agents",
    },
    component: NavigationLink,
    title: "UI/NavigationLink",
} satisfies Meta<typeof NavigationLink>;

export default meta;

type Story = StoryObj<typeof meta>;

export const ActiveTanStackRoute: Story = {
    parameters: {
        tanstack: {
            router: {
                path: "/agents",
                route: agentsRoute,
            },
        },
    },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        const link = canvas.getByRole("link", { name: "Agents" });

        await expect(link).toHaveAttribute("aria-current", "page");
        await expect(link).toHaveAttribute("href", "/agents");
    },
};

export const Inactive: Story = {
    args: {
        active: false,
    },
    parameters: {
        tanstack: {
            router: {
                path: "/agents",
                route: agentsRoute,
            },
        },
    },
};
