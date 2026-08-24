import type { Meta, StoryObj } from "@storybook/tanstack-react";
import { useState } from "react";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";
import * as v from "valibot";

import {
    listWorkspaceFilesOutputSchema,
    type WorkspaceFileEntry,
    type WorkspaceFileRoot,
} from "../../../contracts/files.ts";
import {
    WorkspaceFilesView,
    type WorkspaceFilesViewProps,
} from "../WorkspaceFilesView.tsx";

const revision = "a".repeat(64);
const root: WorkspaceFileRoot = {
    id: "workspace",
    label: "Workspace",
    resourceId: "11111111-1111-4111-8111-111111111111",
    writable: true,
};
const readOnlyRoot: WorkspaceFileRoot = {
    id: "reports",
    label: "Reports",
    resourceId: "22222222-2222-4222-8222-222222222222",
    writable: false,
};
const snapshot = v.parse(listWorkspaceFilesOutputSchema, {
    directory: {
        displayPath: "/docs",
        name: "docs",
        resourceId: "33333333-3333-4333-8333-333333333333",
        revision,
        rootId: root.id,
        writable: true,
    },
    entries: [
        {
            kind: "directory",
            name: "guides",
            resourceId: "44444444-4444-4444-8444-444444444444",
            revision,
            writable: true,
        },
        {
            kind: "file",
            mimeType: "text/markdown",
            modifiedAtMs: 1_800_000_000_000,
            name: "README.md",
            previewKind: "text",
            resourceId: "55555555-5555-4555-8555-555555555555",
            revision,
            sizeBytes: 24,
            writable: true,
        },
        {
            kind: "file",
            mimeType: "application/pdf",
            modifiedAtMs: 1_800_000_000_000,
            name: "architecture.pdf",
            previewKind: "pdf",
            resourceId: "66666666-6666-4666-8666-666666666666",
            revision,
            sizeBytes: 482_000,
            writable: false,
        },
    ],
    nextCursor: "77777777-7777-4777-8777-777777777777",
});

const onPreview = fn(() =>
    Promise.resolve({
        content: "# Workspace guide\n\nPreview files without losing your place.",
        ticket: {
            disposition: "preview" as const,
            expiresAtMs: 1_900_000_000_000,
            fileName: "README.md",
            mimeType: "text/markdown",
            previewKind: "text" as const,
            revision,
            sizeBytes: 24,
            ticketId: "88888888-8888-4888-8888-888888888888",
            url: "/api/files/content/88888888-8888-4888-8888-888888888888",
        },
    })
);

const sourceEntry: WorkspaceFileEntry = {
    kind: "file",
    mimeType: "text/plain",
    modifiedAtMs: 1_800_000_000_000,
    name: "workspace.ts",
    previewKind: "text",
    resourceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    revision,
    sizeBytes: 83,
    writable: true,
};
const jsonEntry: WorkspaceFileEntry = {
    kind: "file",
    mimeType: "application/json",
    modifiedAtMs: 1_800_000_000_000,
    name: "settings.json",
    previewKind: "text",
    resourceId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    revision,
    sizeBytes: 61,
    writable: true,
};
const longNameEntry: WorkspaceFileEntry = {
    ...sourceEntry,
    name: "this-is-a-very-long-workspace-configuration-file-name-that-must-not-move-preview-actions.ts",
    resourceId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
};
const richViewerEntries = [sourceEntry, jsonEntry] as const;
const sourceContent = [
    "export const workspace = {",
    '    name: "Mira Dashboard",',
    "    writable: true,",
    "};",
].join("\n");
const jsonContent = JSON.stringify({
    path: "workspace/projects/mira-dashboard/".repeat(24),
    retentionDays: 14,
    service: { enabled: true, name: "Mira Dashboard" },
});
const onRichPreview = fn((entry: WorkspaceFileEntry) => {
    const content =
        entry.resourceId === sourceEntry.resourceId ? sourceContent : jsonContent;
    return Promise.resolve({
        content,
        ticket: {
            disposition: "preview" as const,
            expiresAtMs: 1_900_000_000_000,
            fileName: entry.name,
            mimeType: entry.mimeType ?? "text/plain",
            previewKind: "text" as const,
            revision,
            sizeBytes: content.length,
            ticketId:
                entry.resourceId === sourceEntry.resourceId
                    ? "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
                    : "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
            url:
                entry.resourceId === sourceEntry.resourceId
                    ? "/api/files/content/cccccccc-cccc-4ccc-8ccc-cccccccccccc"
                    : "/api/files/content/dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        },
    });
});

const meta = {
    args: {
        breadcrumbs: [
            { label: root.label, resourceId: root.resourceId },
            { label: snapshot.directory.name, resourceId: snapshot.directory.resourceId },
        ],
        directory: snapshot.directory,
        entries: snapshot.entries,
        hasNextPage: true,
        onDownload: fn(() => Promise.resolve()),
        onLoadMore: fn(),
        onNavigate: fn(),
        onOpenDirectory: fn(),
        onPreview,
        onRefresh: fn(),
        onReveal: fn(() => Promise.reject(new Error("Reveal is unavailable"))),
        onSelectRoot: fn(),
        onUpload: fn(() =>
            Promise.resolve({
                jobRunId: "file-write-job",
                status: "accepted" as const,
                ticketId: "99999999-9999-4999-8999-999999999999",
            })
        ),
        roots: [root, readOnlyRoot],
        selectedRootId: root.id,
        stable: true,
        treeSnapshots: [
            {
                directory: {
                    displayPath: "/",
                    name: root.label,
                    resourceId: root.resourceId,
                    revision,
                    rootId: root.id,
                    writable: true,
                },
                entries: snapshot.entries,
                hasNextPage: false,
            },
            {
                directory: snapshot.directory,
                entries: snapshot.entries,
                hasNextPage: true,
            },
        ],
    },
    component: WorkspaceFilesView,
    parameters: { layout: "padded" },
    title: "Files/WorkspaceFilesView",
} satisfies Meta<typeof WorkspaceFilesView>;

export default meta;

type Story = StoryObj<typeof meta>;

function PreviewRetentionStory(properties: WorkspaceFilesViewProps) {
    const [pendingDirectory, setPendingDirectory] = useState<WorkspaceFileEntry>();
    return (
        <WorkspaceFilesView
            {...properties}
            breadcrumbs={
                pendingDirectory === undefined
                    ? properties.breadcrumbs
                    : [
                          ...properties.breadcrumbs,
                          {
                              label: pendingDirectory.name,
                              resourceId: pendingDirectory.resourceId,
                          },
                      ]
            }
            directory={
                pendingDirectory === undefined
                    ? properties.directory
                    : {
                          displayPath: `${properties.directory.displayPath}/${pendingDirectory.name}`,
                          name: pendingDirectory.name,
                          resourceId: pendingDirectory.resourceId,
                          revision: pendingDirectory.revision,
                          rootId: properties.directory.rootId,
                          writable: pendingDirectory.writable,
                      }
            }
            directoryLoading={pendingDirectory !== undefined}
            entries={pendingDirectory === undefined ? properties.entries : []}
            hasNextPage={pendingDirectory === undefined ? properties.hasNextPage : false}
            onOpenDirectory={(entry, parentDirectoryId) => {
                properties.onOpenDirectory(entry, parentDirectoryId);
                setPendingDirectory(entry);
            }}
        />
    );
}

export const BoundedInventory: Story = {
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        await expect(
            canvas.getByRole("navigation", { name: "Workspace file tree" })
        ).toBeVisible();
        await expect(canvas.getByText("More available")).toBeVisible();
        await userEvent.click(canvas.getByRole("button", { name: "README.md" }));
        await expect(
            await canvas.findByRole("heading", { name: "README.md" })
        ).toBeVisible();
        await expect(
            canvas.getByText(/Preview files without losing your place/u)
        ).toBeVisible();
    },
};

export const PreviewError: Story = {
    args: {
        onPreview: fn(() => Promise.reject(new Error("Private Storybook failure"))),
    },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        await userEvent.click(canvas.getByRole("button", { name: "README.md" }));
        await expect(await canvas.findByRole("alert")).toHaveTextContent(
            "The request could not be completed. Try again."
        );
    },
};

export const EditorActionsStayInViewport: Story = {
    parameters: { layout: "fullscreen" },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        await userEvent.click(canvas.getByRole("button", { name: "README.md" }));
        await expect(
            await canvas.findByRole("heading", { name: "README.md" })
        ).toBeVisible();
        await userEvent.click(canvas.getByRole("button", { name: "Edit" }));

        const save = canvas.getByRole("button", { name: "Save" });
        await waitFor(() =>
            expect(save.getBoundingClientRect().bottom).toBeLessThanOrEqual(
                canvasElement.getBoundingClientRect().bottom + 1
            )
        );
    },
    render: (arguments_) => (
        <div className="h-screen overflow-hidden p-4">
            <WorkspaceFilesView {...arguments_} />
        </div>
    ),
};

export const PreviewPersistsWhileFolderLoads: Story = {
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        await userEvent.click(canvas.getByRole("button", { name: "README.md" }));
        await expect(
            await canvas.findByRole("heading", { name: "README.md" })
        ).toBeVisible();

        await userEvent.click(canvas.getByRole("button", { name: "guides" }));

        await expect(canvas.getByRole("heading", { name: "README.md" })).toBeVisible();
        await expect(canvas.queryByTestId("workspace-folder-loading")).toBeNull();
        await expect(
            canvas.getByText("Loading folder…", { selector: "span" })
        ).toBeVisible();
    },
    render: (arguments_) => <PreviewRetentionStory {...arguments_} />,
};

export const EmptyReadOnlyRoot: Story = {
    args: {
        breadcrumbs: [{ label: readOnlyRoot.label, resourceId: readOnlyRoot.resourceId }],
        directory: {
            displayPath: "/",
            name: readOnlyRoot.label,
            resourceId: readOnlyRoot.resourceId,
            revision,
            rootId: readOnlyRoot.id,
            writable: false,
        },
        entries: [],
        hasNextPage: false,
        selectedRootId: readOnlyRoot.id,
        treeSnapshots: [
            {
                directory: {
                    displayPath: "/",
                    name: readOnlyRoot.label,
                    resourceId: readOnlyRoot.resourceId,
                    revision,
                    rootId: readOnlyRoot.id,
                    writable: false,
                },
                entries: [],
                hasNextPage: false,
            },
        ],
    },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        await expect(
            canvas.getByRole("heading", { name: "Select a file" })
        ).toBeVisible();
        await expect(
            canvas.queryByRole("button", { name: "Upload file" })
        ).not.toBeInTheDocument();
    },
};

export const ChangingPagination: Story = {
    args: { stable: false },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        await expect(canvas.getByRole("alert")).toHaveTextContent(
            "changed while additional pages were loading"
        );
        await expect(
            canvas.queryByRole("button", { name: "Load more in current folder" })
        ).not.toBeInTheDocument();
    },
};

export const MobileInventory: Story = {
    parameters: { viewport: { defaultViewport: "mobile1" } },
    play: async ({ canvasElement }) => {
        const tree = within(canvasElement).getByRole("navigation", {
            name: "Workspace file tree",
        });
        await expect(tree).toBeVisible();
        await expect(
            within(tree).getByRole("button", { name: "README.md" })
        ).toBeVisible();
    },
};

export const RichTextViewers: Story = {
    args: {
        entries: richViewerEntries,
        hasNextPage: false,
        onPreview: onRichPreview,
        treeSnapshots: [
            {
                directory: {
                    displayPath: "/",
                    name: root.label,
                    resourceId: root.resourceId,
                    revision,
                    rootId: root.id,
                    writable: true,
                },
                entries: richViewerEntries,
                hasNextPage: false,
            },
            {
                directory: snapshot.directory,
                entries: richViewerEntries,
                hasNextPage: false,
            },
        ],
    },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);

        await userEvent.click(canvas.getByRole("button", { name: "workspace.ts" }));
        await expect(await canvas.findByText("TypeScript")).toBeVisible();
        await expect(canvas.getByText("4 lines")).toBeVisible();
        await expect(
            canvas.getByRole("button", { name: "Copy workspace.ts" })
        ).toBeVisible();

        await userEvent.click(canvas.getByRole("button", { name: "settings.json" }));
        await expect(await canvas.findByText("3 keys")).toBeVisible();
        await expect(canvas.getByText('"Mira Dashboard"')).toBeVisible();
        await expect(
            canvas.getByRole("button", { name: "Copy settings.json" })
        ).toBeVisible();

        await userEvent.click(canvas.getByRole("button", { name: "Source" }));
        const region = canvas.getByRole("region", {
            name: "settings.json JSON preview",
        });
        const source = canvas.getByTestId("source-viewer-source");
        const wrapSwitch = canvas.getByRole("switch", { name: "Wrap lines" });
        const code = canvasElement.querySelector("code[data-language='json']");
        const sourceLines = [
            ...canvasElement.querySelectorAll<HTMLElement>(".source-viewer-line"),
        ];
        const referenceLine = sourceLines[0];
        const longLine = sourceLines.find((line) =>
            line.textContent?.includes("workspace/projects/mira-dashboard/")
        );

        if (!(code instanceof HTMLElement) || !referenceLine || !longLine) {
            throw new TypeError("JSON source story did not render its long source line");
        }

        await expect(wrapSwitch).toBeChecked();
        await expect(source).toHaveClass("source-viewer-source-wrapped");
        await expect(code.textContent).toBe(
            JSON.stringify(JSON.parse(jsonContent), undefined, 2)
        );
        await waitFor(() =>
            expect(region.scrollWidth).toBeLessThanOrEqual(region.clientWidth + 1)
        );
        await expect(longLine.getBoundingClientRect().height).toBeGreaterThan(
            referenceLine.getBoundingClientRect().height
        );

        await userEvent.click(wrapSwitch);

        await expect(wrapSwitch).not.toBeChecked();
        await expect(source).toHaveClass("source-viewer-source-unwrapped");
        await waitFor(() =>
            expect(region.scrollWidth).toBeGreaterThan(region.clientWidth)
        );
    },
};

export const LongFileNameKeepsOnlyRefreshBelow: Story = {
    args: {
        entries: [longNameEntry],
        hasNextPage: false,
        onPreview: fn((entry: WorkspaceFileEntry) =>
            Promise.resolve({
                content: sourceContent,
                ticket: {
                    disposition: "preview" as const,
                    expiresAtMs: 1_900_000_000_000,
                    fileName: entry.name,
                    mimeType: entry.mimeType ?? "text/plain",
                    previewKind: "text" as const,
                    revision,
                    sizeBytes: sourceContent.length,
                    ticketId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
                    url: "/api/files/content/ffffffff-ffff-4fff-8fff-ffffffffffff",
                },
            })
        ),
        treeSnapshots: [
            {
                directory: {
                    displayPath: "/",
                    name: root.label,
                    resourceId: root.resourceId,
                    revision,
                    rootId: root.id,
                    writable: true,
                },
                entries: [longNameEntry],
                hasNextPage: false,
            },
            {
                directory: snapshot.directory,
                entries: [longNameEntry],
                hasNextPage: false,
            },
        ],
    },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        await userEvent.click(canvas.getByRole("button", { name: longNameEntry.name }));
        await expect(
            await canvas.findByRole("heading", { name: longNameEntry.name })
        ).toBeVisible();

        const heading = canvas.getByRole("heading", { name: longNameEntry.name });
        const raw = canvas.getByRole("button", { name: "Raw" });
        const refresh = canvas.getByRole("button", { name: "Refresh preview" });
        const primaryActions = raw.parentElement;
        const actionColumn = refresh.parentElement;
        if (
            !(primaryActions instanceof HTMLElement) ||
            !(actionColumn instanceof HTMLElement)
        ) {
            throw new TypeError("Files header did not render its stable action rows");
        }
        await expect(heading).toHaveClass("truncate");
        await expect(primaryActions).toContainElement(raw);
        await expect(actionColumn.children).toHaveLength(2);
        await expect(actionColumn.lastElementChild).toBe(refresh);
        await waitFor(() =>
            expect(refresh.getBoundingClientRect().top).toBeGreaterThanOrEqual(
                primaryActions.getBoundingClientRect().bottom
            )
        );
    },
};
