import { describe, expect, test } from "bun:test";

import { JsonViewer } from "./JsonViewer.tsx";

const { render, screen } = await import("@testing-library/react");
const userEventModule = await import("@testing-library/user-event");
const userEvent = userEventModule.default;

describe("JsonViewer", () => {
    test("expands a valid JSON tree and keeps a highlighted source view", async () => {
        const content = '{"enabled":true,"name":"Dashboard","retries":3}';
        const formatted = JSON.stringify(JSON.parse(content), undefined, 2);
        const { container } = render(
            <JsonViewer
                ariaLabel="settings.json preview"
                content={content}
                copyLabel="Copy settings.json"
            />
        );
        const user = userEvent.setup();

        expect(screen.getByText("3 keys")).toBeTruthy();
        expect(
            screen.getByRole("tree", { name: "settings.json preview tree" })
        ).toBeTruthy();
        expect(screen.getByText('"Dashboard"')).toBeTruthy();
        expect(screen.getByRole("button", { name: "Collapse root object" })).toBeTruthy();

        await user.click(screen.getByRole("button", { name: "Source" }));

        const highlighted = screen.getByTestId("syntax-highlighted-source");
        expect(highlighted.querySelectorAll(".source-viewer-line")).toHaveLength(5);
        expect(highlighted.querySelector(".hljs-attr")).toHaveTextContent('"enabled"');
        expect(highlighted.querySelector(".hljs-literal")).toHaveTextContent("true");
        expect(highlighted.querySelector(".hljs-string")).toHaveTextContent(
            '"Dashboard"'
        );
        expect(container.querySelector("code[data-language='json']")?.textContent).toBe(
            formatted
        );
        expect(screen.getByRole("switch", { name: "Wrap lines" })).toBeChecked();
        expect(screen.getByRole("button", { name: "Copy settings.json" })).toBeTruthy();
    });

    test("wraps long formatted JSON by default and keeps a no-wrap option", async () => {
        const user = userEvent.setup();
        const content = JSON.stringify({ path: "workspace/".repeat(80) });
        const formatted = JSON.stringify(JSON.parse(content), undefined, 2);
        const { container } = render(
            <JsonViewer
                ariaLabel="long.json preview"
                content={content}
                copyLabel="Copy long.json"
            />
        );

        await user.click(screen.getByRole("button", { name: "Source" }));
        const wrapSwitch = screen.getByRole("switch", { name: "Wrap lines" });
        const source = screen.getByTestId("source-viewer-source");

        expect(wrapSwitch).toBeChecked();
        expect(source).toHaveClass("source-viewer-source-wrapped");
        expect(container.querySelector("code[data-language='json']")?.textContent).toBe(
            formatted
        );

        await user.click(wrapSwitch);

        expect(wrapSwitch).not.toBeChecked();
        expect(source).toHaveClass("source-viewer-source-unwrapped");
        expect(container.querySelector("code[data-language='json']")?.textContent).toBe(
            formatted
        );
        expect(screen.getByRole("button", { name: "Copy long.json" })).toBeTruthy();
    });

    test("parses comments and trailing commas only in explicit JSON5 mode", () => {
        render(
            <JsonViewer
                ariaLabel="settings.json5 preview"
                content={'{service: "Dashboard", enabled: true,} // local'}
                copyLabel="Copy settings.json5"
                format="json5"
            />
        );

        expect(screen.getByText("JSON5")).toBeTruthy();
        expect(screen.getByText('"Dashboard"')).toBeTruthy();
        expect(
            screen.getByRole("tree", { name: "settings.json5 preview tree" })
        ).toBeTruthy();
    });

    test("fails closed to exact source text when JSON is invalid", () => {
        const { container } = render(
            <JsonViewer
                ariaLabel="invalid JSON preview"
                content="{broken"
                copyLabel="Copy invalid JSON"
            />
        );

        expect(screen.getByText("Invalid JSON")).toBeTruthy();
        expect(container.querySelector("code[data-language='json']")?.textContent).toBe(
            "{broken"
        );
    });
});
