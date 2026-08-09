import { describe, expect, jest, test } from "bun:test";

import { ChatAttachmentPreview } from "./ChatAttachmentPreview.tsx";

const { render, screen, waitFor } = await import("@testing-library/react");

describe("chat attachment preview", () => {
    test("reads a newly attached JSON file through the bounded safe-text path", async () => {
        render(
            <ChatAttachmentPreview
                attachment={{
                    file: new File(['{"ready":true}'], "evidence.json", {
                        type: "application/json",
                    }),
                    mediaType: "application/json",
                    name: "evidence.json",
                    sizeBytes: 14,
                }}
                onClose={jest.fn()}
            />
        );

        await waitFor(() => expect(screen.getByText('{"ready":true}')).toBeVisible());
        expect(screen.queryByText("Preview unavailable")).toBeNull();
    });
});
