import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { Files } from "./Files";

const hooks = vi.hoisted(() => ({
    handleContentChange: vi.fn(),
    handleRefresh: vi.fn(),
    handleSave: vi.fn(),
    handleSelect: vi.fn(),
    handleToggle: vi.fn(),
    setCodeEditMode: vi.fn(),
    setError: vi.fn(),
    setJsonPreview: vi.fn(),
    setMarkdownPreview: vi.fn(),
    useFileExplorerState: vi.fn(),
}));

vi.mock("../hooks/useFileExplorerState", () => ({
    useFileExplorerState: hooks.useFileExplorerState,
}));

vi.mock("../components/features/files", () => ({
    FileEditorPanel: ({
        fileContent,
        isEditable,
        onCodePreviewChange,
        onContentChange,
        onJsonPreviewChange,
        onMarkdownPreviewChange,
        onSave,
        selectedPath,
        syntaxClass,
    }: {
        fileContent: { path: string } | null;
        isEditable: boolean;
        onCodePreviewChange: (preview: boolean) => void;
        onContentChange: (content: string) => void;
        onJsonPreviewChange: (enabled: boolean) => void;
        onMarkdownPreviewChange: (enabled: boolean) => void;
        onSave: () => void;
        selectedPath: string | null;
        syntaxClass: string;
    }) => (
        <section data-testid="file-editor">
            <div>selected: {selectedPath || "none"}</div>
            <div>path: {fileContent?.path || "none"}</div>
            <div>editable: {String(isEditable)}</div>
            <div>syntax: {syntaxClass}</div>
            <button type="button" onClick={() => onSave()}>
                Save file
            </button>
            <button type="button" onClick={() => onContentChange("updated")}>
                Update content
            </button>
            <button type="button" onClick={() => onMarkdownPreviewChange(true)}>
                Markdown preview
            </button>
            <button type="button" onClick={() => onJsonPreviewChange(true)}>
                JSON preview
            </button>
            <button type="button" onClick={() => onCodePreviewChange(true)}>
                Code preview
            </button>
        </section>
    ),
    FilesSidebar: ({
        files,
        onSelect,
        onToggle,
        rootLoading,
    }: {
        files: Array<{ path: string }>;
        onSelect: (path: string) => void;
        onToggle: (path: string) => void;
        rootLoading: boolean;
    }) => (
        <aside data-testid="files-sidebar">
            <div>root loading: {String(rootLoading)}</div>
            <div>files: {files.length}</div>
            <button type="button" onClick={() => onSelect("README.md")}>
                Select README
            </button>
            <button type="button" onClick={() => onToggle("src")}>
                Toggle src
            </button>
        </aside>
    ),
}));

function mockFileState(overrides = {}) {
    hooks.useFileExplorerState.mockReturnValue({
        codeEditMode: false,
        contentLoading: false,
        editedContent: "# Hello",
        error: null,
        expandedPaths: new Set(["src"]),
        fileContent: {
            content: "# Hello",
            isBinary: false,
            path: "README.md",
            size: 7,
        },
        files: [{ path: "README.md" }],
        handleContentChange: hooks.handleContentChange,
        handleRefresh: hooks.handleRefresh,
        handleSave: hooks.handleSave,
        handleSelect: hooks.handleSelect,
        handleToggle: hooks.handleToggle,
        hasChanges: false,
        isJsonEditing: false,
        jsonPreview: false,
        jsonValidation: { error: null, isValid: true },
        largeFileWarning: null,
        markdownPreview: false,
        rootLoading: false,
        saveMutation: { isPending: false },
        selectedPath: "README.md",
        setCodeEditMode: hooks.setCodeEditMode,
        setError: hooks.setError,
        setJsonPreview: hooks.setJsonPreview,
        setMarkdownPreview: hooks.setMarkdownPreview,
        ...overrides,
    });
}

describe("Files page", () => {
    beforeEach(() => {
        hooks.handleContentChange.mockReset();
        hooks.handleRefresh.mockReset();
        hooks.handleSave.mockResolvedValue(Promise.resolve());
        hooks.handleSelect.mockReset();
        hooks.handleToggle.mockReset();
        hooks.setCodeEditMode.mockReset();
        hooks.setError.mockReset();
        hooks.setJsonPreview.mockReset();
        hooks.setMarkdownPreview.mockReset();
        hooks.useFileExplorerState.mockReset();
        mockFileState();
    });

    it("renders sidebar, editor, and derived syntax class", () => {
        render(<Files />);

        expect(screen.getByTestId("files-sidebar")).toHaveTextContent("files: 1");
        expect(screen.getByTestId("file-editor")).toHaveTextContent(
            "selected: README.md"
        );
        expect(screen.getByTestId("file-editor")).toHaveTextContent("editable: true");
        expect(screen.getByTestId("file-editor")).toHaveTextContent("syntax:");
    });

    it("refreshes, selects, toggles, edits, saves, and toggles previews", async () => {
        const user = userEvent.setup();

        render(<Files />);

        await user.click(screen.getByRole("button", { name: "Refresh" }));
        await user.click(screen.getByRole("button", { name: "Select README" }));
        await user.click(screen.getByRole("button", { name: "Toggle src" }));
        await user.click(screen.getByRole("button", { name: "Update content" }));
        await user.click(screen.getByRole("button", { name: "Save file" }));
        await user.click(screen.getByRole("button", { name: "Markdown preview" }));
        await user.click(screen.getByRole("button", { name: "JSON preview" }));
        await user.click(screen.getByRole("button", { name: "Code preview" }));

        expect(hooks.handleRefresh).toHaveBeenCalledTimes(1);
        expect(hooks.handleSelect).toHaveBeenCalledWith("README.md");
        expect(hooks.handleToggle).toHaveBeenCalledWith("src");
        expect(hooks.handleContentChange).toHaveBeenCalledWith("updated");
        expect(hooks.handleSave).toHaveBeenCalledTimes(1);
        expect(hooks.setMarkdownPreview).toHaveBeenCalledWith(true);
        expect(hooks.setJsonPreview).toHaveBeenCalledWith(true);
        expect(hooks.setCodeEditMode).toHaveBeenCalledWith(false);
    });

    it("shows and dismisses file errors", async () => {
        const user = userEvent.setup();
        mockFileState({ error: "Unable to load file" });

        render(<Files />);

        expect(screen.getByText("Unable to load file")).toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "" }));
        expect(hooks.setError).toHaveBeenCalledWith(null);
    });

    it("renders empty syntax when no file is selected", () => {
        mockFileState({ fileContent: null, selectedPath: null });

        render(<Files />);

        expect(screen.getByTestId("file-editor")).toHaveTextContent("path: none");
        expect(screen.getByTestId("file-editor")).toHaveTextContent("syntax:");
    });

    it("disables editing for binary or oversized files", () => {
        mockFileState({
            fileContent: { isBinary: true, path: "image.png" },
            largeFileWarning: "Large file",
        });

        render(<Files />);

        expect(screen.getByTestId("file-editor")).toHaveTextContent("editable: false");
    });

    it("disables refresh while loading", () => {
        mockFileState({ rootLoading: true });

        render(<Files />);

        expect(screen.getByRole("button", { name: "Refresh" })).toBeDisabled();
    });
});
