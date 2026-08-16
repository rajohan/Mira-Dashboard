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

    test("renders a remote Markdown attachment without loading embedded resources", async () => {
        const fetchMock = jest.spyOn(globalThis, "fetch").mockResolvedValue(
            new Response("# Release notes\n\n![secret](https://example.test/pixel.png)", {
                headers: {
                    "content-length": "62",
                    "content-type": "text/markdown",
                },
            })
        );
        try {
            render(
                <ChatAttachmentPreview
                    attachment={{
                        downloadUrl:
                            "/api/chat/media/019fe633-9133-4ba0-8b80-809dd80dfb40?disposition=download",
                        mediaType: "text/markdown",
                        name: "release.md",
                        previewUrl:
                            "/api/chat/media/019fe633-9133-4ba0-8b80-809dd80dfb40?disposition=preview",
                        renderPolicy: "bounded-text",
                        sizeBytes: 62,
                    }}
                    onClose={jest.fn()}
                />
            );

            await waitFor(() =>
                expect(
                    screen.getByRole("heading", { name: "Release notes" })
                ).toBeVisible()
            );
            expect(screen.getByRole("note")).toHaveTextContent(
                "[Image blocked: secret]"
            );
            expect(fetchMock).toHaveBeenCalledTimes(1);
        } finally {
            fetchMock.mockRestore();
        }
    });
});
