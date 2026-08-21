import type { Meta, StoryObj } from "@storybook/tanstack-react";
import { createRootRoute, createRoute, Outlet } from "@tanstack/react-router";
import type { ComponentProps } from "react";
import { expect, fn, userEvent, within } from "storybook/test";

import { NavigationLink } from "../NavigationLink.tsx";

const rootRoute = createRootRoute({
    component: Outlet,
});
const agentsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/agents",
});
rootRoute.addChildren([agentsRoute]);

function RenderNavigationLink(properties: ComponentProps<typeof NavigationLink>) {
    return (
        <NavigationLink
            {...properties}
            onClick={(event) => {
                event.preventDefault();
                properties.onClick?.(event);
            }}
        />
    );
}

const meta = {
    args: {
        active: true,
        children: "Agents",
        current: true,
        onClick: fn(),
        to: "/agents",
    },
    component: NavigationLink,
    render: RenderNavigationLink,
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
    play: async ({ args, canvasElement }) => {
        const canvas = within(canvasElement);
        const link = canvas.getByRole("link", { name: "Agents" });

        await expect(link).toHaveAttribute("aria-current", "page");
        await expect(link).toHaveAttribute("href", "/agents");
        await userEvent.click(link);
        await expect(args.onClick).toHaveBeenCalledOnce();
    },
};

export const Inactive: Story = {
    args: {
        active: false,
        current: false,
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
