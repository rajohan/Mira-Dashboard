import type { Meta, StoryObj } from "@storybook/tanstack-react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
    createMemoryHistory,
    createRootRoute,
    createRoute,
    createRouter,
    RouterProvider,
    type RouterHistory,
    useRouter,
} from "@tanstack/react-router";
import { type ReactElement, type ReactNode, useState } from "react";
import { expect, userEvent, waitFor, within } from "storybook/test";

import { dashboardScrollRestorationKey } from "../../router.tsx";
import { TerminalPageLayout } from "../../terminal/TerminalRoute.tsx";
import { Button } from "../../ui/Button.tsx";
import { DashboardShell } from "../DashboardShell.tsx";

const jobsScrollTop = 720;
const reportsScrollTop = 360;
const wideDesktopViewport = { height: 900, width: 1920 } as const;
const mobileViewport = { height: 568, width: 320 } as const;

function ScrollStoryControls({
    children,
    title,
}: {
    readonly children: ReactNode;
    readonly title: string;
}): ReactElement {
    return (
        <div className="border-primary-700 bg-primary-900 sticky top-0 z-10 space-y-3 border-b py-4">
            <h1 className="text-xl font-bold">{title}</h1>
            <div className="flex flex-wrap items-center gap-3">{children}</div>
        </div>
    );
}

function ScrollStoryButton({
    children,
    onClick,
}: {
    readonly children: ReactNode;
    readonly onClick: () => void;
}): ReactElement {
    return (
        <Button onClick={onClick} size="sm" variant="secondary">
            {children}
        </Button>
    );
}

function JobsScrollStoryPage(): ReactElement {
    const navigate = jobsStoryRoute.useNavigate();
    const search: unknown = jobsStoryRoute.useSearch();
    const filter =
        typeof search === "object" &&
        search !== null &&
        "filter" in search &&
        search.filter === "active"
            ? "active"
            : "all";

    return (
        <section aria-label="Jobs scroll-restoration fixture">
            <ScrollStoryControls title="Jobs scroll fixture">
                <span>
                    Filter: <output aria-label="Current jobs filter">{filter}</output>
                </span>
                <ScrollStoryButton
                    onClick={() =>
                        void navigate({
                            search: { filter: "active" },
                            to: "/jobs",
                        })
                    }
                >
                    Apply active filter
                </ScrollStoryButton>
                <ScrollStoryButton onClick={() => void navigate({ to: "/reports" })}>
                    View reports
                </ScrollStoryButton>
            </ScrollStoryControls>
            <div aria-hidden="true" className="h-[160rem]" />
        </section>
    );
}

function ReportsScrollStoryPage(): ReactElement {
    const history = (useRouter() as { readonly history: RouterHistory }).history;

    return (
        <section aria-label="Reports scroll-restoration fixture">
            <ScrollStoryControls title="Reports scroll fixture">
                <ScrollStoryButton onClick={() => history.back()}>
                    Back to jobs
                </ScrollStoryButton>
            </ScrollStoryControls>
            <div aria-hidden="true" className="h-[160rem]" />
        </section>
    );
}

function TerminalLayoutStoryPage(): ReactElement {
    return (
        <TerminalPageLayout>
            <section
                aria-label="Interactive terminal canvas"
                className="border-primary-700 bg-primary-950 mb-8 min-h-0 w-full flex-1 overflow-hidden rounded-xl border p-4"
            >
                <p className="truncate font-mono text-emerald-300">
                    operator@dashboard:~/greenfield$
                </p>
            </section>
        </TerminalPageLayout>
    );
}

const rootStoryRoute = createRootRoute({ component: DashboardShell });
const jobsStoryRoute = createRoute({
    component: JobsScrollStoryPage,
    getParentRoute: () => rootStoryRoute,
    path: "/jobs",
    validateSearch: (search: Record<string, unknown>) => ({
        filter: search.filter === "active" ? ("active" as const) : ("all" as const),
    }),
});
const reportsStoryRoute = createRoute({
    component: ReportsScrollStoryPage,
    getParentRoute: () => rootStoryRoute,
    path: "/reports",
});
const terminalStoryRoute = createRoute({
    component: TerminalLayoutStoryPage,
    getParentRoute: () => rootStoryRoute,
    path: "/terminal",
});
const storyRouteTree = rootStoryRoute.addChildren([
    jobsStoryRoute,
    reportsStoryRoute,
    terminalStoryRoute,
]);

function createScrollStoryRouter() {
    return createRouter({
        getScrollRestorationKey: dashboardScrollRestorationKey,
        history: createMemoryHistory({ initialEntries: ["/jobs"] }),
        routeTree: storyRouteTree,
        scrollRestoration: true,
        scrollToTopSelectors: ["#dashboard-content"],
    });
}

function DashboardScrollRestorationStory() {
    const [queryClient] = useState(() => new QueryClient());
    const [router] = useState(createScrollStoryRouter);

    return (
        <QueryClientProvider client={queryClient}>
            <div className="h-screen">
                <RouterProvider router={router} />
            </div>
        </QueryClientProvider>
    );
}

function createTerminalLayoutStoryRouter() {
    return createRouter({
        history: createMemoryHistory({ initialEntries: ["/terminal"] }),
        routeTree: storyRouteTree,
    });
}

function DashboardTerminalLayoutStory() {
    const [queryClient] = useState(() => new QueryClient());
    const [router] = useState(createTerminalLayoutStoryRouter);

    return (
        <QueryClientProvider client={queryClient}>
            <div className="h-screen">
                <RouterProvider router={router} />
            </div>
        </QueryClientProvider>
    );
}

function scrollDashboardContent(content: HTMLElement, scrollTop: number): void {
    content.scrollTop = scrollTop;
    content.dispatchEvent(new Event("scroll", { bubbles: true }));
}

function finitePixelValue(value: string): number {
    const parsed = value.endsWith("px") ? Number(value.slice(0, -2)) : Number.NaN;
    if (!Number.isFinite(parsed)) {
        throw new TypeError(`Expected a finite pixel value, received ${value}.`);
    }
    return parsed;
}

async function expectTerminalLayoutGeometry(
    canvasElement: HTMLElement,
    viewport: Readonly<{ height: number; width: number }>,
    sidebarExpected: boolean
): Promise<void> {
    const canvas = within(canvasElement);
    const main = canvasElement.querySelector<HTMLElement>("#dashboard-content");
    const sidebar = canvasElement.querySelector<HTMLElement>("aside");
    const terminalCanvas = canvas.getByRole("region", {
        name: "Interactive terminal canvas",
    });
    const routeLayout = terminalCanvas.parentElement?.parentElement;

    if (routeLayout === null || routeLayout === undefined || main === null) {
        throw new Error("The Terminal page layout fixture is incomplete.");
    }

    await waitFor(async () => {
        await expect(canvasElement.getBoundingClientRect().width).toBe(viewport.width);
        await expect(canvasElement.getBoundingClientRect().height).toBe(viewport.height);
    });

    const mainBounds = main.getBoundingClientRect();
    const mainStyle = getComputedStyle(main);
    const contentLeft = mainBounds.left + finitePixelValue(mainStyle.paddingLeft);
    const contentRight = mainBounds.right - finitePixelValue(mainStyle.paddingRight);
    const contentBottom = mainBounds.bottom - finitePixelValue(mainStyle.paddingBottom);
    const availableWidth = contentRight - contentLeft;
    const routeStyle = getComputedStyle(routeLayout);
    const expectedWidth = Math.min(availableWidth, finitePixelValue(routeStyle.maxWidth));
    const expectedLeft = contentLeft + (availableWidth - expectedWidth) / 2;
    const routeBounds = routeLayout.getBoundingClientRect();
    const terminalBounds = terminalCanvas.getBoundingClientRect();
    const terminalStyle = getComputedStyle(terminalCanvas);

    await expect(Math.abs(routeBounds.left - expectedLeft)).toBeLessThanOrEqual(1);
    await expect(Math.abs(routeBounds.width - expectedWidth)).toBeLessThanOrEqual(1);
    await expect(Math.abs(terminalBounds.left - routeBounds.left)).toBeLessThanOrEqual(1);
    await expect(Math.abs(terminalBounds.right - routeBounds.right)).toBeLessThanOrEqual(
        1
    );
    await expect(
        Math.abs(
            terminalBounds.bottom +
                finitePixelValue(terminalStyle.marginBottom) -
                contentBottom
        )
    ).toBeLessThanOrEqual(1);
    await expect(terminalBounds.height).toBeGreaterThan(200);
    await expect(main.scrollWidth).toBe(main.clientWidth);

    if (sidebarExpected) {
        if (sidebar === null) throw new Error("The desktop sidebar is missing.");
        await expect(getComputedStyle(sidebar).display).not.toBe("none");
        await expect(routeBounds.left).toBeGreaterThan(
            sidebar.getBoundingClientRect().right
        );
    } else if (sidebar !== null) {
        await expect(getComputedStyle(sidebar).display).toBe("none");
    }
}

const meta = {
    component: DashboardScrollRestorationStory,
    parameters: { layout: "fullscreen" },
} satisfies Meta<typeof DashboardScrollRestorationStory>;

export default meta;

type Story = StoryObj<typeof meta>;

export const RestoresTheContentScroller: Story = {
    globals: { viewport: { isRotated: false, value: "desktop1280" } },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        await canvas.findByRole("heading", { name: "Jobs scroll fixture" });

        const content = canvasElement.querySelector<HTMLElement>("#dashboard-content");
        if (content === null) throw new Error("Dashboard content scroller is missing.");

        await waitFor(async () => {
            await expect(content.scrollHeight - content.clientHeight).toBeGreaterThan(
                jobsScrollTop
            );
        });

        scrollDashboardContent(content, jobsScrollTop);
        await waitFor(async () => {
            await expect(content.scrollTop).toBe(jobsScrollTop);
        });

        await userEvent.click(
            canvas.getByRole("button", { name: "Apply active filter" })
        );
        await waitFor(async () => {
            await expect(
                canvas.getByRole("status", { name: "Current jobs filter" })
            ).toHaveTextContent("active");
            await expect(content.scrollTop).toBe(jobsScrollTop);
        });

        await userEvent.click(canvas.getByRole("button", { name: "View reports" }));
        await canvas.findByRole("heading", { name: "Reports scroll fixture" });
        await waitFor(async () => {
            await expect(content.scrollTop).toBe(0);
        });

        scrollDashboardContent(content, reportsScrollTop);
        await waitFor(async () => {
            await expect(content.scrollTop).toBe(reportsScrollTop);
        });
        await userEvent.click(canvas.getByRole("button", { name: "Back to jobs" }));

        await canvas.findByRole("heading", { name: "Jobs scroll fixture" });
        await waitFor(async () => {
            await expect(
                canvas.getByRole("status", { name: "Current jobs filter" })
            ).toHaveTextContent("active");
            await expect(content.scrollTop).toBe(jobsScrollTop);
        });
    },
};

export const TerminalUsesTheDesktopPageContainer: Story = {
    globals: { viewport: { isRotated: false, value: "wideDesktop" } },
    parameters: {
        viewport: {
            options: {
                wideDesktop: {
                    name: "1920 px desktop",
                    styles: {
                        height: `${wideDesktopViewport.height}px`,
                        width: `${wideDesktopViewport.width}px`,
                    },
                    type: "desktop",
                },
            },
        },
    },
    play: async ({ canvasElement }) => {
        await expectTerminalLayoutGeometry(canvasElement, wideDesktopViewport, true);
    },
    render: () => <DashboardTerminalLayoutStory />,
};

export const TerminalKeepsTheMobileGutter: Story = {
    globals: { viewport: { isRotated: false, value: "mobile1" } },
    play: async ({ canvasElement }) => {
        await expectTerminalLayoutGeometry(canvasElement, mobileViewport, false);
    },
    render: () => <DashboardTerminalLayoutStory />,
};
