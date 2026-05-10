import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { AttachmentPreviewModal } from "./AttachmentPreviewModal";
import type { ChatPreviewItem } from "./chatTypes";

describe("AttachmentPreviewModal", () => {
    it("stays closed without a preview item", () => {
        render(<AttachmentPreviewModal previewItem={null} onClose={vi.fn()} />);

        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    it("renders image previews", async () => {
        const preview: ChatPreviewItem = {
            kind: "image",
            mimeType: "image/png",
            sizeBytes: 1024,
            title: "avatar.png",
            url: "data:image/png;base64,abc",
        };

        render(<AttachmentPreviewModal previewItem={preview} onClose={vi.fn()} />);

        expect(
            await screen.findByRole("dialog", { name: "avatar.png" })
        ).toBeInTheDocument();
        expect(screen.getByText("image/png · 1.0 KB")).toBeInTheDocument();
        expect(screen.getByRole("img", { name: "avatar.png" })).toHaveAttribute(
            "src",
            "data:image/png;base64,abc"
        );
    });

    it("renders text, download, and missing-preview states", async () => {
        const { rerender } = render(
            <AttachmentPreviewModal
                previewItem={{
                    kind: "text",
                    mimeType: "text/plain",
                    text: "hello from attachment",
                    title: "notes.txt",
                }}
                onClose={vi.fn()}
            />
        );

        expect(await screen.findByText("hello from attachment")).toBeInTheDocument();

        rerender(
            <AttachmentPreviewModal
                previewItem={{
                    kind: "file",
                    mimeType: "application/zip",
                    title: "archive.zip",
                    url: "https://example.com/archive.zip",
                }}
                onClose={vi.fn()}
            />
        );

        expect(
            await screen.findByText("Preview is not available for this file type yet.")
        ).toBeInTheDocument();
        expect(screen.getByRole("link", { name: "Download file" })).toHaveAttribute(
            "href",
            "https://example.com/archive.zip"
        );

        rerender(
            <AttachmentPreviewModal
                previewItem={{ kind: "file", title: "historical.bin" }}
                onClose={vi.fn()}
            />
        );

        expect(
            await screen.findByText(
                "This historical attachment has no preview data available."
            )
        ).toBeInTheDocument();
    });
});
