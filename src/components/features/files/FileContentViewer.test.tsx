import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { FileContent } from "../../../types/file";
import { FileContentViewer } from "./FileContentViewer";

vi.mock("./viewers/MarkdownPreview", () => ({
    MarkdownPreview: ({ content }: { content: string }) => (
        <div data-testid="markdown-preview">{content}</div>
    ),
}));

vi.mock("./viewers/JsonPreview", () => ({
    JsonPreview: ({ content }: { content: string }) => (
        <div data-testid="json-preview">{content}</div>
    ),
}));

vi.mock("./viewers/CodePreview", () => ({
    CodePreview: ({ content, language }: { content: string; language: string }) => (
        <div data-testid="code-preview" data-language={language}>
            {content}
        </div>
    ),
}));

const baseFile: FileContent = {
    content: "hello",
    isBinary: false,
    modified: "2026-05-10T10:00:00.000Z",
    path: "/workspace/notes.txt",
    size: 5,
};

function renderViewer(overrides: Partial<Parameters<typeof FileContentViewer>[0]> = {}) {
    const onContentChange = vi.fn();
    const props: Parameters<typeof FileContentViewer>[0] = {
        codeEditMode: false,
        editedContent: "hello",
        fileContent: baseFile,
        isEditable: true,
        jsonPreview: false,
        largeFileWarning: false,
        markdownPreview: false,
        onContentChange,
        syntaxClass: "text-primary-300",
        ...overrides,
    };

    render(<FileContentViewer {...props} />);
    return { onContentChange };
}

describe("FileContentViewer", () => {
    it("edits text content and shows large-file warning", async () => {
        const user = userEvent.setup();
        const { onContentChange } = renderViewer({
            largeFileWarning: true,
            fileContent: { ...baseFile, size: 2_097_152 },
        });

        expect(screen.getByText(/Large file \(2\.0 MB\)/u)).toBeInTheDocument();
        await user.type(screen.getByDisplayValue("hello"), "!");

        expect(onContentChange).toHaveBeenCalled();
    });

    it("renders readonly text, binary files, and images", () => {
        const { rerender } = render(
            <FileContentViewer
                codeEditMode={false}
                editedContent="readonly text"
                fileContent={baseFile}
                isEditable={false}
                jsonPreview={false}
                largeFileWarning={false}
                markdownPreview={false}
                onContentChange={vi.fn()}
                syntaxClass="text-primary-300"
            />
        );

        expect(screen.getByText("readonly text")).toBeInTheDocument();

        rerender(
            <FileContentViewer
                codeEditMode={false}
                editedContent=""
                fileContent={{
                    ...baseFile,
                    isBinary: true,
                    path: "/workspace/archive.zip",
                }}
                isEditable={false}
                jsonPreview={false}
                largeFileWarning={false}
                markdownPreview={false}
                onContentChange={vi.fn()}
                syntaxClass="text-primary-300"
            />
        );

        expect(screen.getByText("Binary file")).toBeInTheDocument();
        expect(screen.getByText("Cannot display binary content")).toBeInTheDocument();

        rerender(
            <FileContentViewer
                codeEditMode={false}
                editedContent=""
                fileContent={{
                    ...baseFile,
                    content: "iVBORw0KGgo=",
                    isBinary: true,
                    isImage: true,
                    mimeType: "image/png",
                    path: "/workspace/avatar.png",
                }}
                isEditable={false}
                jsonPreview={false}
                largeFileWarning={false}
                markdownPreview={false}
                onContentChange={vi.fn()}
                syntaxClass="text-primary-300"
            />
        );

        expect(screen.getByRole("img", { name: "avatar.png" })).toHaveAttribute(
            "src",
            "data:image/png;base64,iVBORw0KGgo="
        );
    });

    it("uses textarea editing for code files when code edit mode is enabled", () => {
        renderViewer({
            codeEditMode: true,
            editedContent: "const ok = true;",
            fileContent: { ...baseFile, path: "/workspace/index.ts", size: 16 },
        });

        expect(screen.getByDisplayValue("const ok = true;")).toBeInTheDocument();
    });

    it("loads markdown, JSON, and code previews", async () => {
        const { rerender } = render(
            <FileContentViewer
                codeEditMode={false}
                editedContent="# Notes"
                fileContent={{ ...baseFile, path: "/workspace/notes.md" }}
                isEditable={true}
                jsonPreview={false}
                largeFileWarning={false}
                markdownPreview={true}
                onContentChange={vi.fn()}
                syntaxClass="text-primary-300"
            />
        );

        expect(await screen.findByTestId("markdown-preview")).toHaveTextContent(
            "# Notes"
        );

        rerender(
            <FileContentViewer
                codeEditMode={false}
                editedContent='{ "ok": true }'
                fileContent={{ ...baseFile, path: "/workspace/config.json" }}
                isEditable={true}
                jsonPreview={true}
                largeFileWarning={false}
                markdownPreview={false}
                onContentChange={vi.fn()}
                syntaxClass="text-primary-300"
            />
        );

        expect(await screen.findByTestId("json-preview")).toHaveTextContent(
            '{ "ok": true }'
        );

        rerender(
            <FileContentViewer
                codeEditMode={false}
                editedContent="console.log('hi');"
                fileContent={{ ...baseFile, path: "/workspace/app.ts" }}
                isEditable={true}
                jsonPreview={false}
                largeFileWarning={false}
                markdownPreview={false}
                onContentChange={vi.fn()}
                syntaxClass="text-primary-300"
            />
        );

        const codePreview = await screen.findByTestId("code-preview");
        expect(codePreview).toHaveTextContent("console.log('hi');");
        expect(codePreview).toHaveAttribute("data-language", "typescript");
    });
});
