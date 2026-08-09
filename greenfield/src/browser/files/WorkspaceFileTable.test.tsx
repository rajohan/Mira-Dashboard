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

        await user.click(primaryAction);
        expect(onOpenDirectory).toHaveBeenCalledWith(directory);
    });
});
