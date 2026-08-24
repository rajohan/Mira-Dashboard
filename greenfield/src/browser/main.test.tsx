import { describe, expect, test } from "bun:test";

import { act } from "react";

const { screen } = await import("@testing-library/react");

describe("Dashboard browser entrypoint", () => {
    test("mounts the composed application into the document root", async () => {
        document.body.innerHTML = '<div id="root"></div>';
        const originalFetch = globalThis.fetch;
        globalThis.fetch = () =>
            Promise.resolve(
                Response.json(
                    { result: { data: { json: { state: "anonymous" } } } },
                    { status: 200 }
                )
            );
        let entrypoint: typeof import("./main.tsx") | undefined;
        try {
            entrypoint = await act(async () => import("./main.tsx"));

            expect(
                await screen.findByRole("heading", { level: 1, name: "Sign in" })
            ).toBeTruthy();
        } finally {
            if (entrypoint !== undefined) {
                act(() => entrypoint?.dashboardBrowserRoot.unmount());
            }
            globalThis.fetch = originalFetch;
            document.body.replaceChildren();
        }
    });
});
