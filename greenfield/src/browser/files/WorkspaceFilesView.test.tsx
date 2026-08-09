import { describe, expect, jest, test } from "bun:test";

import type {
    WorkspaceFileDirectory,
    WorkspaceFileEntry,
    WorkspaceFileRoot,
} from "../../contracts/files.ts";
import { WorkspaceFilesView } from "./WorkspaceFilesView.tsx";

const { act, render, screen, waitFor, within } = await import("@testing-library/react");
const userEventModule = await import("@testing-library/user-event");
const userEvent = userEventModule.default;

const revision = "a".repeat(64);
const root: WorkspaceFileRoot = {
    id: "workspace",
    label: "Workspace",
    resourceId: "11111111-1111-4111-8111-111111111111",
    writable: true,
};
const directory: WorkspaceFileDirectory = {
    displayPath: "/docs",
    name: "docs",
    resourceId: "22222222-2222-4222-8222-222222222222",
    revision,
    rootId: root.id,
    writable: true,
};
const entries: readonly WorkspaceFileEntry[] = [
    {
        kind: "directory",
        name: "guides",
        resourceId: "33333333-3333-4333-8333-333333333333",
        revision,
        writable: true,
    },
    {
        kind: "file",
        mimeType: "text/markdown",
        modifiedAtMs: 1_800_000_000_000,
        name: "README.md",
        previewKind: "text",
        resourceId: "44444444-4444-4444-8444-444444444444",
        revision,
        sizeBytes: 7,
        writable: true,
    },
];

function properties() {
    return {
        breadcrumbs: [
            { label: root.label, resourceId: root.resourceId },
            { label: directory.name, resourceId: directory.resourceId },
        ],
        directory,
        entries,
        hasNextPage: true,
        onDownload: jest.fn(() => Promise.resolve()),
        onLoadMore: jest.fn(),
        onNavigate: jest.fn(),
        onOpenDirectory: jest.fn(),
        onPreview: jest.fn(() =>
            Promise.resolve({
                content: "# Hello",
                ticket: {
                    disposition: "preview" as const,
                    expiresAtMs: 1_900_000_000_000,
                    fileName: "README.md",
                    mimeType: "text/markdown",
                    previewKind: "text" as const,
                    revision,
                    sizeBytes: 7,
                    ticketId: "55555555-5555-4555-8555-555555555555",
                    url: "/api/files/content/55555555-5555-4555-8555-555555555555",
                },
            })
        ),
        onRefresh: jest.fn(),
        onSelectRoot: jest.fn(),
        onUpload: jest.fn(
            (
                _file: File,
                _replacedEntry: WorkspaceFileEntry | undefined,
                _parentDirectoryId?: string
            ) =>
                Promise.resolve({
                    jobRunId: "file-write-job",
                    status: "accepted" as const,
                    ticketId: "66666666-6666-4666-8666-666666666666",
                })
        ),
        roots: [root],
        selectedRootId: root.id,
        stable: true,
        treeSnapshots: [
            { directory, entries, hasNextPage: true },
            {
                directory: { ...directory, resourceId: root.resourceId },
                entries,
                hasNextPage: false,
            },
        ],
    };
}

describe("WorkspaceFilesView", () => {
    test("keeps path navigation and an expandable persistent tree", async () => {
        const props = properties();
        const user = userEvent.setup();
        render(<WorkspaceFilesView {...props} />);

        const path = screen.getByRole("navigation", { name: "Workspace file path" });
        const breadcrumbButton = within(path).getByRole("button", {
            name: "Workspace",
        });
        expect(breadcrumbButton).toHaveAttribute("type", "button");
        await user.click(breadcrumbButton);
        expect(props.onNavigate).toHaveBeenCalledWith(0);

        const tree = screen.getByRole("navigation", { name: "Workspace file tree" });
        const directoryButton = within(tree).getByRole("button", { name: "guides" });
        expect(directoryButton).toHaveAttribute("type", "button");
        await user.click(directoryButton);
        expect(props.onOpenDirectory).toHaveBeenCalledWith(entries[0], root.resourceId);
        expect(within(tree).getByText(/Open this folder to load/u)).toBeTruthy();

        await user.click(
            screen.getByRole("button", { name: "Load more in current folder" })
        );
        expect(props.onLoadMore).toHaveBeenCalledTimes(1);
    });

    test("renders text in the persistent pane with raw and rendered modes", async () => {
        const props = properties();
        const user = userEvent.setup();
        render(<WorkspaceFilesView {...props} />);

        await user.click(screen.getByRole("button", { name: "README.md" }));
        expect(await screen.findByRole("heading", { name: "README.md" })).toBeTruthy();
        expect(screen.getByRole("heading", { name: "Hello" })).toBeTruthy();
        expect(screen.queryByRole("dialog")).toBeNull();

        await user.click(screen.getByRole("button", { name: "Raw" }));
        expect(
            document.querySelector("code[data-language='markdown']")?.textContent
        ).toBe("# Hello");
    });

    test("keeps the tree mounted during folder loading", () => {
        const props = properties();
        const { rerender } = render(<WorkspaceFilesView {...props} />);
        const tree = screen.getByRole("navigation", { name: "Workspace file tree" });

        rerender(
            <WorkspaceFilesView
                {...props}
                directory={{
                    ...directory,
                    displayPath: "/docs/guides",
                    name: "guides",
                    resourceId: entries[0]!.resourceId,
                }}
                directoryLoading
                entries={[]}
            />
        );

        expect(screen.getByTestId("workspace-folder-loading")).toHaveAttribute(
            "aria-busy",
            "true"
        );
        expect(screen.getByRole("navigation", { name: "Workspace file tree" })).toBe(
            tree
        );
    });

    test("keeps the selected preview while another folder loads", async () => {
        const props = properties();
        const user = userEvent.setup();
        const { rerender } = render(<WorkspaceFilesView {...props} />);

        await user.click(screen.getByRole("button", { name: "README.md" }));
        expect(await screen.findByRole("heading", { name: "README.md" })).toBeTruthy();

        await user.click(screen.getByRole("button", { name: "guides" }));
        expect(props.onOpenDirectory).toHaveBeenCalledWith(entries[0], root.resourceId);
        expect(screen.getByRole("heading", { name: "README.md" })).toBeTruthy();

        rerender(
            <WorkspaceFilesView
                {...props}
                directory={{
                    ...directory,
                    displayPath: "/docs/guides",
                    name: "guides",
                    resourceId: entries[0]!.resourceId,
                }}
                directoryLoading
                entries={[]}
                hasNextPage={false}
            />
        );

        expect(screen.getByRole("heading", { name: "README.md" })).toBeTruthy();
        expect(screen.queryByTestId("workspace-folder-loading")).toBeNull();
    });

    test("clears a selected preview only after its complete parent folder omits it", async () => {
        const props = properties();
        const user = userEvent.setup();
        const { rerender } = render(<WorkspaceFilesView {...props} />);

        await user.click(screen.getByRole("button", { name: "README.md" }));
        expect(await screen.findByRole("heading", { name: "README.md" })).toBeTruthy();

        const parentDirectory = {
            ...directory,
            displayPath: "/",
            name: root.label,
            resourceId: root.resourceId,
        };
        rerender(
            <WorkspaceFilesView
                {...props}
                directory={parentDirectory}
                entries={[entries[0]!]}
            />
        );
        expect(screen.getByRole("heading", { name: "README.md" })).toBeTruthy();

        rerender(
            <WorkspaceFilesView
                {...props}
                directory={parentDirectory}
                entries={[entries[0]!]}
                hasNextPage={false}
            />
        );

        await waitFor(() =>
            expect(screen.queryByRole("heading", { name: "README.md" })).toBeNull()
        );
        expect(screen.getByRole("heading", { name: "Select a file" })).toBeTruthy();
    });

    test("ignores a stale preview after a newer file selection", async () => {
        const secondEntry: WorkspaceFileEntry = {
            ...entries[1]!,
            name: "NOTES.md",
            resourceId: "77777777-7777-4777-8777-777777777777",
        };
        let resolveFirst!: (
            value: Awaited<ReturnType<ReturnType<typeof properties>["onPreview"]>>
        ) => void;
        let resolveSecond!: (
            value: Awaited<ReturnType<ReturnType<typeof properties>["onPreview"]>>
        ) => void;
        const firstPreview = new Promise<
            Awaited<ReturnType<ReturnType<typeof properties>["onPreview"]>>
        >((resolve) => {
            resolveFirst = resolve;
        });
        const secondPreview = new Promise<
            Awaited<ReturnType<ReturnType<typeof properties>["onPreview"]>>
        >((resolve) => {
            resolveSecond = resolve;
        });
        const props = properties();
        const visibleEntries = [...entries, secondEntry];
        const onPreview = jest.fn((entry: WorkspaceFileEntry) =>
            entry.resourceId === secondEntry.resourceId ? secondPreview : firstPreview
        );
        const user = userEvent.setup();
        render(
            <WorkspaceFilesView
                {...props}
                entries={visibleEntries}
                onPreview={onPreview}
                treeSnapshots={props.treeSnapshots.map((snapshot) => ({
                    ...snapshot,
                    entries: visibleEntries,
                }))}
            />
        );

        await user.click(screen.getByRole("button", { name: "README.md" }));
        await user.click(screen.getByRole("button", { name: "NOTES.md" }));
        await act(() => {
            resolveSecond({
                content: "# Second",
                ticket: {
                    disposition: "preview",
                    expiresAtMs: 1_900_000_000_000,
                    fileName: secondEntry.name,
                    mimeType: "text/markdown",
                    previewKind: "text",
                    revision,
                    sizeBytes: 8,
                    ticketId: "88888888-8888-4888-8888-888888888888",
                    url: "/api/files/content/88888888-8888-4888-8888-888888888888",
                },
            });
            return secondPreview;
        });
        expect(screen.getByRole("heading", { name: "NOTES.md" })).toBeTruthy();

        await act(() => {
            resolveFirst({
                content: "# Stale",
                ticket: {
                    disposition: "preview",
                    expiresAtMs: 1_900_000_000_000,
                    fileName: "README.md",
                    mimeType: "text/markdown",
                    previewKind: "text",
                    revision,
                    sizeBytes: 7,
                    ticketId: "99999999-9999-4999-8999-999999999999",
                    url: "/api/files/content/99999999-9999-4999-8999-999999999999",
                },
            });
            return firstPreview;
        });
        expect(screen.queryByRole("heading", { name: "README.md" })).toBeNull();
        expect(screen.getByRole("heading", { name: "NOTES.md" })).toBeTruthy();
    });

    test("queues inline text editing through the selected CAS replacement", async () => {
        const props = properties();
        const user = userEvent.setup();
        render(<WorkspaceFilesView {...props} />);

        await user.click(screen.getByRole("button", { name: "README.md" }));
        await screen.findByRole("heading", { name: "README.md" });
        await user.click(screen.getByRole("button", { name: "Edit" }));
        const editor = screen.getByLabelText("File contents");
        await user.clear(editor);
        await user.type(editor, "# Updated");
        await user.click(screen.getByRole("button", { name: "Save" }));

        await waitFor(() => expect(props.onUpload).toHaveBeenCalledTimes(1));
        const [file, replaced, parentDirectoryId] = props.onUpload.mock.calls[0]!;
        expect(file).toBeInstanceOf(File);
        expect(await file.text()).toBe("# Updated");
        expect(replaced).toEqual(entries[1]);
        expect(parentDirectoryId).toBe(root.resourceId);
        expect(await screen.findByText(/Your change is queued/u)).toBeTruthy();
    });

    test("uploads one selected file and reports the queued worker job", async () => {
        const props = properties();
        const user = userEvent.setup();
        render(<WorkspaceFilesView {...props} />);

        await user.click(screen.getByRole("button", { name: "Upload file" }));
        const dialog = screen.getByRole("dialog", { name: "Upload file" });
        const input = within(dialog).getByLabelText("File");
        const file = new File(["hello"], "hello.txt", { type: "text/plain" });
        await user.upload(input, file);
        await user.click(within(dialog).getByRole("button", { name: "Upload file" }));

        await waitFor(() =>
            expect(props.onUpload).toHaveBeenCalledWith(
                file,
                undefined,
                directory.resourceId
            )
        );
        expect(await screen.findByText(/Your change is queued/u)).toBeTruthy();
    });

    test("blocks paging and asks for refresh after a changing page sequence", () => {
        render(<WorkspaceFilesView {...properties()} stable={false} />);
        expect(screen.getByRole("alert")).toHaveTextContent(
            "changed while additional pages were loading"
        );
        expect(
            screen.queryByRole("button", { name: "Load more in current folder" })
        ).toBeNull();
    });
});
