import { afterAll, describe, expect, test } from "bun:test";

import { act } from "react";

import { acquireBrowserTestEnvironment } from "./testSupport/browserTestEnvironment.ts";

const browserEnvironment = acquireBrowserTestEnvironment();
const { waitFor } = await import("@testing-library/react");

afterAll(async () => {
    await browserEnvironment.release();
});

describe("Dashboard browser entrypoint", () => {
    test("mounts the lazy application graph into the document root", async () => {
        document.body.innerHTML = '<div id="root"></div>';
        let entrypoint: typeof import("./main.tsx") | undefined;
        try {
            entrypoint = await act(async () => import("./main.tsx"));
            await waitFor(
                () => {
                    const heading = document.querySelector("h1");
                    expect(heading).toBeInstanceOf(HTMLElement);
                    expect(heading?.textContent).toBe("Mira Dashboard");
                },
                { container: document.body }
            );
        } finally {
            const mountedRoot = entrypoint?.dashboardBrowserRoot;
            if (mountedRoot) act(() => mountedRoot.unmount());
            document.body.replaceChildren();
        }
    });
});
