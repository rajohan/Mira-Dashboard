import { describe, expect, jest, test } from "bun:test";

import type { WorkspaceFileEntry } from "../../contracts/files.ts";
import { WorkspaceFileTable } from "./WorkspaceFileTable.tsx";

const { render, screen } = await import("@testing-library/react");
const userEventModule = await import("@testing-library/user-event");
const userEvent = userEventModule.default;

const directory: WorkspaceFileEntry = {
    kind: "directory",
    name: "guides",
    resourceId: "33333333-3333-4333-8333-333333333333",
    revision: "a".repeat(64),
    writable: true,
};

describe("WorkspaceFileTable", () => {
    test("uses the shared non-submitting button for the primary file action", async () => {
        const onOpenDirectory = jest.fn();
        const user = userEvent.setup();
        render(
            <WorkspaceFileTable
                entries={[directory]}
                onDownload={jest.fn()}
                onOpenDirectory={onOpenDirectory}
                onPreview={jest.fn()}
                onReplace={jest.fn()}
            />
        );

        const primaryAction = screen.getByRole("button", {
            name: "Open folder guides",
        });
        expect(primaryAction).toHaveAttribute("type", "button");
        expect(primaryAction).toHaveClass(
            "cursor-pointer",
            "focus-visible:ring-offset-2"
        );
        expect(
            screen.getByRole("columnheader", { name: "Name" }).querySelector("button")
        ).toBeNull();

        await user.click(primaryAction);
        expect(onOpenDirectory).toHaveBeenCalledWith(directory);
    });

    test("opens bounded prefixes for preview and never offers replacement", async () => {
        const prefix: WorkspaceFileEntry = {
            kind: "file",
            mimeType: "text/plain",
            name: "agentmail.ts",
            previewKind: "download-only",
            resourceId: "44444444-4444-4444-8444-444444444444",
            revision: "b".repeat(64),
            sizeBytes: 2 * 1024 * 1024 + 1,
            truncated: true,
            writable: true,
        };
        const onPreview = jest.fn();
        const user = userEvent.setup();
        render(
            <WorkspaceFileTable
                entries={[prefix]}
                onDownload={jest.fn()}
                onOpenDirectory={jest.fn()}
                onPreview={onPreview}
                onReplace={jest.fn()}
            />
        );

        expect(screen.queryByRole("button", { name: "Replace agentmail.ts" })).toBeNull();
        await user.click(
            screen.getAllByRole("button", {
                name: "Preview prefix of agentmail.ts",
            })[0]!
        );
        expect(onPreview).toHaveBeenCalledWith(prefix);
        expect(
            screen.getByRole("button", {
                name: "Download prefix of agentmail.ts",
            })
        ).toBeTruthy();
    });
});
