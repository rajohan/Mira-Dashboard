import { afterAll, describe, expect, test } from "bun:test";

import { act } from "react";

import { acquireBrowserTestEnvironment } from "./testSupport/browserTestEnvironment.ts";

const browserEnvironment = acquireBrowserTestEnvironment();

afterAll(async () => {
    await browserEnvironment.release();
});

describe("Dashboard browser entrypoint", () => {
    test("mounts the lazy application graph into the document root", async () => {
        document.body.innerHTML = '<div id="root"></div>';
        const entrypoint = await act(async () => import("./main.tsx"));

        const heading = document.querySelector("h1");
        expect(heading).toBeInstanceOf(HTMLElement);
        expect(heading?.textContent).toBe("Mira Dashboard");

        act(() => entrypoint.dashboardBrowserRoot.unmount());
        document.body.replaceChildren();
    });
});
