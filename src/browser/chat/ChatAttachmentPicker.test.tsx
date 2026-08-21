import { describe, expect, jest, test } from "bun:test";

import { ChatAttachmentPicker } from "./ChatAttachmentPicker.tsx";
import type { ChatDraftAttachment } from "./chatTypes.ts";

const { fireEvent, render, screen, within } = await import("@testing-library/react");
const userEventModule = await import("@testing-library/user-event");
const userEvent = userEventModule.default;

function attachment(
    id: string,
    status: ChatDraftAttachment["status"],
    overrides: Partial<ChatDraftAttachment> = {}
): ChatDraftAttachment {
    const name = `${id}.txt`;
    return {
        file: new File([id], name, { type: "text/plain" }),
        id,
        mediaType: "text/plain",
        name,
        progress: status === "ready" ? 100 : 42,
        sizeBytes: id.length,
        status,
        ...overrides,
    };
}

function renderPicker(
    overrides: Partial<Parameters<typeof ChatAttachmentPicker>[0]> = {}
) {
    const properties: Parameters<typeof ChatAttachmentPicker>[0] = {
        attachments: [],
        onChooseFiles: jest.fn(),
        onClose: jest.fn(),
        onFilesSelected: jest.fn(),
        onPreview: jest.fn(),
        onRemove: jest.fn(),
        open: true,
        ...overrides,
    };
    return { properties, rendered: render(<ChatAttachmentPicker {...properties} />) };
}

describe("chat attachment picker", () => {
    test("renders every attachment lifecycle and delegates all picker actions", async () => {
        const files = [
            attachment("ready", "ready"),
            attachment("preparing", "preparing"),
            attachment("uploading", "uploading"),
            attachment("failed", "error", { error: "Upload was rejected" }),
        ];
        const { properties, rendered } = renderPicker({
            attachments: files,
            error: "One file needs attention",
        });
        const user = userEvent.setup();
        const dialog = screen.getByRole("dialog", { name: "Attach files" });

        expect(within(dialog).getByText("One file needs attention")).toHaveRole("alert");
        expect(
            within(dialog).getByText("Selected files").parentElement
        ).toHaveTextContent("4/10");
        expect(within(dialog).getByText("Ready")).toBeVisible();
        expect(within(dialog).getByText("Preparing")).toBeVisible();
        expect(within(dialog).getByText("Uploading 42%")).toBeVisible();
        expect(within(dialog).getByText("Upload was rejected")).toBeVisible();
        expect(
            within(dialog).getByRole("progressbar", {
                name: "Upload progress for preparing.txt",
            })
        ).toHaveValue(42);
        expect(
            within(dialog).getByRole("progressbar", {
                name: "Upload progress for uploading.txt",
            })
        ).toHaveValue(42);

        await user.click(
            within(dialog).getByRole("button", { name: "Preview ready.txt" })
        );
        await user.click(
            within(dialog).getByRole("button", { name: "Remove failed.txt" })
        );
        await user.click(within(dialog).getByRole("button", { name: /^Choose files$/u }));
        await user.click(within(dialog).getByRole("button", { name: "Done" }));

        expect(properties.onPreview).toHaveBeenCalledWith("ready");
        expect(properties.onRemove).toHaveBeenCalledWith("failed");
        expect(properties.onChooseFiles).toHaveBeenCalledTimes(1);
        expect(properties.onClose).toHaveBeenCalledTimes(1);
        rendered.unmount();
    });

    test("accepts a non-empty drop and clears its visible drag state", () => {
        const droppedFile = new File(["payload"], "drop.txt", {
            type: "text/plain",
        });
        const droppedFiles = {
            0: droppedFile,
            item: (index: number) => (index === 0 ? droppedFile : null),
            length: 1,
        } as unknown as FileList;
        const { properties, rendered } = renderPicker();
        const dropZone = screen.getByRole("button", {
            name: /Drop files here or choose files/u,
        });

        fireEvent.dragEnter(dropZone);
        expect(dropZone).toHaveClass("border-accent-400", "bg-primary-900");
        fireEvent.drop(dropZone, { dataTransfer: { files: droppedFiles } });

        expect(dropZone).not.toHaveClass("bg-primary-900");
        expect(properties.onFilesSelected).toHaveBeenCalledWith(droppedFiles);
        rendered.unmount();
    });

    test("disables selection at the bounded attachment limit", () => {
        const attachments = Array.from({ length: 10 }, (_, index) =>
            attachment(`file-${index}`, "ready")
        );
        const { properties, rendered } = renderPicker({ attachments });
        const dialog = screen.getByRole("dialog", { name: "Attach files" });
        const dropZone = within(dialog).getByRole("button", {
            name: /Drop files here or choose files/u,
        });

        expect(dropZone).toHaveTextContent("0 slots remaining");
        expect(dropZone).toBeDisabled();
        expect(
            within(dialog).getByRole("button", { name: /^Choose files$/u })
        ).toBeDisabled();
        fireEvent.drop(dropZone, { dataTransfer: { files: [] } });
        expect(properties.onFilesSelected).not.toHaveBeenCalled();
        rendered.unmount();
    });
});
