import type { Meta, StoryObj } from "@storybook/tanstack-react";
import { expect, userEvent, within } from "storybook/test";

import type {
    ListWorkspaceFilesOutput,
    WorkspaceFileRoot,
} from "../../../contracts/files.ts";
import { DashboardPageStory } from "../../storySupport/dashboardPageStoryHarness.tsx";
import {
    dashboardStoryFailure,
    dashboardStoryResolver,
    dashboardStoryValue,
    type DashboardStoryFixtures,
} from "../../storySupport/dashboardStoryTransport.ts";

const nowMs = 1_800_000_000_000;
const revision = "a".repeat(64);
const root = {
    id: "workspace",
    label: "Mira workspace",
    resourceId: "11111111-1111-4111-8111-111111111111",
    writable: true,
} as const satisfies WorkspaceFileRoot;
const readOnlyRoot = {
    id: "reports",
    label: "Generated reports",
    resourceId: "22222222-2222-4222-8222-222222222222",
    writable: false,
} as const satisfies WorkspaceFileRoot;
const populatedPage = {
    directory: {
        displayPath: "/",
        name: "workspace",
        resourceId: root.resourceId,
        revision,
        rootId: root.id,
        writable: true,
    },
    entries: [
        {
            kind: "directory",
            modifiedAtMs: nowMs - 86_400_000,
            name: "guides",
            resourceId: "33333333-3333-4333-8333-333333333333",
            revision,
            writable: true,
        },
        {
            kind: "file",
            mimeType: "text/markdown",
            modifiedAtMs: nowMs - 3_600_000,
            name: "README.md",
            previewKind: "text",
            resourceId: "44444444-4444-4444-8444-444444444444",
            revision,
            sizeBytes: 4096,
            writable: true,
        },
        {
            kind: "file",
            mimeType: "application/pdf",
            modifiedAtMs: nowMs - 7_200_000,
            name: "architecture.pdf",
            previewKind: "pdf",
            resourceId: "55555555-5555-4555-8555-555555555555",
            revision,
            sizeBytes: 482_000,
            writable: false,
        },
    ],
} as const satisfies ListWorkspaceFilesOutput;
const readOnlyPage = {
    directory: {
        displayPath: "/",
        name: "reports",
        resourceId: readOnlyRoot.resourceId,
        revision: "b".repeat(64),
        rootId: readOnlyRoot.id,
        writable: false,
    },
    entries: [],
} as const satisfies ListWorkspaceFilesOutput;
const notifications = { notifications: [], readCount: 0, unreadCount: 0 } as const;
let retainedRefreshShouldFail = false;

function codedError(code: string): Error {
    return Object.assign(new Error("Private Storybook file failure"), {
        data: { code },
    });
}

function fileFixtures({
    list = dashboardStoryValue(populatedPage),
    mutations,
    roots = [root],
}: Readonly<{
    list?: ReturnType<typeof dashboardStoryValue>;
    mutations?: DashboardStoryFixtures["mutations"];
    roots?: readonly WorkspaceFileRoot[];
}> = {}): DashboardStoryFixtures {
    return {
        mutations,
        queries: {
            "files.list": list,
            "files.listRoots": dashboardStoryValue({ roots }),
            "notifications.list": dashboardStoryValue(notifications),
        },
    };
}

async function openUploadDialog(canvasElement: HTMLElement) {
    const canvas = within(canvasElement);
    const page = within(canvasElement.ownerDocument.body);
    await userEvent.click(
        await canvas.findByRole("button", { name: "Upload file" }, { timeout: 5000 })
    );
    const dialog = await page.findByRole(
        "dialog",
        { name: "Upload file" },
        { timeout: 5000 }
    );
    await userEvent.upload(
        within(dialog).getByLabelText("File"),
        new File(["Storybook file"], "storybook.txt", { type: "text/plain" })
    );
    return { canvas, dialog };
}

const meta = {
    component: DashboardPageStory,
    parameters: { layout: "fullscreen" },
    render: (args, context) => <DashboardPageStory {...args} key={context.id} />,
} satisfies Meta<typeof DashboardPageStory>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Loading: Story = {
    args: {
        fixtures: {
            queries: {
                "files.listRoots": dashboardStoryResolver(
                    () =>
                        new Promise<never>(() => {
                            // Intentionally pending to preserve route loading.
                        })
                ),
                "notifications.list": dashboardStoryValue(notifications),
            },
        },
        route: "/files",
    },
};

export const Populated: Story = {
    args: { fixtures: fileFixtures(), route: "/files" },
};

export const UploadDialog: Story = {
    args: { fixtures: fileFixtures(), route: "/files" },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        const page = within(canvasElement.ownerDocument.body);
        await userEvent.click(
            await canvas.findByRole("button", { name: "Upload file" }, { timeout: 5000 })
        );
        const dialog = await page.findByRole(
            "dialog",
            { name: "Upload file" },
            { timeout: 5000 }
        );
        await expect(
            within(dialog).getByRole("button", {
                name: /Drop a file here or choose a file/iu,
            })
        ).toBeVisible();
    },
};

export const EmptyReadOnly: Story = {
    args: {
        fixtures: fileFixtures({
            list: dashboardStoryValue(readOnlyPage),
            roots: [readOnlyRoot],
        }),
        route: "/files",
    },
};

export const InitialError: Story = {
    args: {
        fixtures: {
            queries: {
                "files.listRoots": dashboardStoryFailure(codedError("FORBIDDEN")),
                "notifications.list": dashboardStoryValue(notifications),
            },
        },
        route: "/files",
    },
};

export const BrowserRetained: Story = {
    args: {
        fixtures: fileFixtures({
            list: dashboardStoryResolver(() => {
                if (retainedRefreshShouldFail) throw codedError("FORBIDDEN");
                return populatedPage;
            }),
        }),
        route: "/files",
    },
    beforeEach: () => {
        retainedRefreshShouldFail = false;
        return () => {
            retainedRefreshShouldFail = false;
        };
    },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        await expect(
            await canvas.findByRole("button", { name: "README.md" }, { timeout: 5000 })
        ).toBeVisible();
        retainedRefreshShouldFail = true;
        await userEvent.click(canvas.getByRole("button", { name: "Refresh" }));
        await expect(
            await canvas.findByRole("alert", {}, { timeout: 5000 })
        ).toBeVisible();
        await expect(canvas.getByRole("button", { name: "README.md" })).toBeVisible();
    },
};

export const MutationBusy: Story = {
    args: {
        fixtures: fileFixtures({
            mutations: {
                "files.prepareUpload": dashboardStoryResolver(
                    () =>
                        new Promise<never>(() => {
                            // Keep the real upload reservation in its busy state.
                        })
                ),
            },
        }),
        route: "/files",
    },
    play: async ({ canvasElement }) => {
        const { dialog } = await openUploadDialog(canvasElement);
        await userEvent.click(
            within(dialog).getByRole("button", { name: "Upload file" })
        );
        await expect(
            await within(dialog).findByRole(
                "button",
                { name: "Uploading…" },
                { timeout: 5000 }
            )
        ).toBeDisabled();
    },
};

export const MutationConflict: Story = {
    args: {
        fixtures: fileFixtures({
            mutations: {
                "files.prepareUpload": dashboardStoryFailure(codedError("CONFLICT")),
            },
        }),
        route: "/files",
    },
    play: async ({ canvasElement }) => {
        const { dialog } = await openUploadDialog(canvasElement);
        await userEvent.click(
            within(dialog).getByRole("button", { name: "Upload file" })
        );
        await expect(
            await within(dialog).findByText(
                /changed.*Refresh and review/iu,
                {},
                { timeout: 5000 }
            )
        ).toBeVisible();
    },
};

export const Mobile: Story = {
    args: { fixtures: fileFixtures(), route: "/files" },
    globals: { viewport: { isRotated: false, value: "mobile1" } },
};
