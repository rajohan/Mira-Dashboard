import { afterEach, describe, expect, jest, test } from "bun:test";

import { CopyTextButton } from "./CopyTextButton.tsx";

const { render, screen } = await import("@testing-library/react");
const userEventModule = await import("@testing-library/user-event");
const userEvent = userEventModule.default;

const originalClipboard = Object.getOwnPropertyDescriptor(
    globalThis.navigator,
    "clipboard"
);

afterEach(() => {
    if (originalClipboard === undefined) {
        Reflect.deleteProperty(globalThis.navigator, "clipboard");
    } else {
        Object.defineProperty(globalThis.navigator, "clipboard", originalClipboard);
    }
});

describe("CopyTextButton", () => {
    test("copies exact text and exposes visible confirmation", async () => {
        const writeText = jest.fn(() => Promise.resolve());
        const user = userEvent.setup();
        Object.defineProperty(globalThis.navigator, "clipboard", {
            configurable: true,
            value: { writeText },
        });
        render(<CopyTextButton label="Copy source" text={"first\nsecond"} />);

        await user.click(screen.getByRole("button", { name: "Copy source" }));

        expect(writeText).toHaveBeenCalledWith("first\nsecond");
        expect(
            screen.getByRole("button", { name: "Copy source (copied)" })
        ).toHaveTextContent("Copied");
    });

    test("fails visibly when browser clipboard access is unavailable", async () => {
        const user = userEvent.setup();
        Object.defineProperty(globalThis.navigator, "clipboard", {
            configurable: true,
            value: undefined,
        });
        render(<CopyTextButton label="Copy JSON" text="{}" />);

        await user.click(screen.getByRole("button", { name: "Copy JSON" }));

        expect(
            screen.getByRole("button", { name: "Copy JSON (copy unavailable)" })
        ).toHaveTextContent("Copy unavailable");
    });
});
