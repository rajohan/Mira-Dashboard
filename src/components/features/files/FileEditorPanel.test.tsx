import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { FileContent } from "../../../types/file";
import { FileEditorPanel } from "./FileEditorPanel";

const jsonFile: FileContent = {
    content: '{"ok":true}',
    isBinary: false,
    modified: "2026-05-10T10:00:00.000Z",
    path: "/workspace/config.json",
    size: 11,
};

function renderPanel(overrides: Partial<Parameters<typeof FileEditorPanel>[0]> = {}) {
    const handlers = {
        onCodePreviewChange: vi.fn(),
        onContentChange: vi.fn(),
        onJsonPreviewChange: vi.fn(),
        onMarkdownPreviewChange: vi.fn(),
        onSave: vi.fn(),
    };
    const props: Parameters<typeof FileEditorPanel>[0] = {
        codeEditMode: false,
        contentLoading: false,
        editedContent: '{"ok":true}',
        fileContent: jsonFile,
        hasChanges: true,
        isEditable: true,
        isJsonEditing: true,
        jsonPreview: false,
        jsonValidation: { error: null, valid: true },
        largeFileWarning: false,
        markdownPreview: false,
        savePending: false,
        selectedPath: "/workspace/config.json",
        syntaxClass: "text-primary-300",
        ...handlers,
        ...overrides,
    };

    const view = render(<FileEditorPanel {...props} />);
    return { ...view, handlers };
}

describe("FileEditorPanel", () => {
    it("renders empty, loading, and failed states", () => {
        const { rerender } = renderPanel({ selectedPath: null });

        expect(screen.getByText("Select a file to view")).toBeInTheDocument();

        rerender(
            <FileEditorPanel
                codeEditMode={false}
                contentLoading
                editedContent=""
                fileContent={undefined}
                hasChanges={false}
                isEditable={false}
                isJsonEditing={false}
                jsonPreview={false}
                jsonValidation={{ error: null, valid: true }}
                largeFileWarning={false}
                markdownPreview={false}
                onCodePreviewChange={vi.fn()}
                onContentChange={vi.fn()}
                onJsonPreviewChange={vi.fn()}
                onMarkdownPreviewChange={vi.fn()}
                onSave={vi.fn()}
                savePending={false}
                selectedPath="/workspace/missing.txt"
                syntaxClass="text-primary-300"
            />
        );
        expect(screen.getByText("Loading...")).toBeInTheDocument();

        rerender(
            <FileEditorPanel
                codeEditMode={false}
                contentLoading={false}
                editedContent=""
                fileContent={undefined}
                hasChanges={false}
                isEditable={false}
                isJsonEditing={false}
                jsonPreview={false}
                jsonValidation={{ error: null, valid: true }}
                largeFileWarning={false}
                markdownPreview={false}
                onCodePreviewChange={vi.fn()}
                onContentChange={vi.fn()}
                onJsonPreviewChange={vi.fn()}
                onMarkdownPreviewChange={vi.fn()}
                onSave={vi.fn()}
                savePending={false}
                selectedPath="/workspace/missing.txt"
                syntaxClass="text-primary-300"
            />
        );
        expect(screen.getByText("Failed to load file")).toBeInTheDocument();
    });

    it("renders file controls, validation state, and save behavior", async () => {
        const user = userEvent.setup();
        const { handlers, rerender } = renderPanel({
            jsonValidation: { error: "Unexpected token", valid: false },
        });

        expect(screen.getByText("/workspace/config.json")).toBeInTheDocument();
        expect(screen.getByText("11 B")).toBeInTheDocument();
        expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
        expect(screen.getByText("Invalid JSON")).toHaveAttribute(
            "title",
            "Invalid JSON: Unexpected token"
        );
        expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();

        await user.click(screen.getByRole("button", { name: "Preview" }));
        expect(handlers.onJsonPreviewChange).toHaveBeenCalledWith(true);

        rerender(
            <FileEditorPanel
                codeEditMode={false}
                contentLoading={false}
                editedContent={'{"ok":true}'}
                fileContent={jsonFile}
                hasChanges
                isEditable
                isJsonEditing
                jsonPreview={false}
                jsonValidation={{ error: null, valid: true }}
                largeFileWarning={false}
                markdownPreview={false}
                onCodePreviewChange={handlers.onCodePreviewChange}
                onContentChange={handlers.onContentChange}
                onJsonPreviewChange={handlers.onJsonPreviewChange}
                onMarkdownPreviewChange={handlers.onMarkdownPreviewChange}
                onSave={handlers.onSave}
                savePending={false}
                selectedPath="/workspace/config.json"
                syntaxClass="text-primary-300"
            />
        );

        expect(screen.getByText("Valid JSON")).toHaveAttribute("title", "Valid JSON");
        await user.click(screen.getByRole("button", { name: "Save" }));

        expect(handlers.onSave).toHaveBeenCalledTimes(1);
    });

    it("shows saving state and disables save without changes", () => {
        const { rerender } = renderPanel({ savePending: true });

        expect(screen.getByRole("button", { name: "Saving..." })).toBeDisabled();

        rerender(
            <FileEditorPanel
                codeEditMode={false}
                contentLoading={false}
                editedContent={'{"ok":true}'}
                fileContent={jsonFile}
                hasChanges={false}
                isEditable
                isJsonEditing
                jsonPreview={false}
                jsonValidation={{ error: null, valid: true }}
                largeFileWarning={false}
                markdownPreview={false}
                onCodePreviewChange={vi.fn()}
                onContentChange={vi.fn()}
                onJsonPreviewChange={vi.fn()}
                onMarkdownPreviewChange={vi.fn()}
                onSave={vi.fn()}
                savePending={false}
                selectedPath="/workspace/config.json"
                syntaxClass="text-primary-300"
            />
        );

        expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    });
});
