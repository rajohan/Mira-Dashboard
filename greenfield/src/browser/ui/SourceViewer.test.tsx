import { describe, expect, test } from "bun:test";

import { SourceViewer } from "./SourceViewer.tsx";

const { render, screen } = await import("@testing-library/react");
const userEventModule = await import("@testing-library/user-event");
const userEvent = userEventModule.default;

describe("SourceViewer", () => {
    test("presents exact highlighted source with a language and line numbers", async () => {
        const content = "const answer = 42;\nconsole.log(answer);\n";
        const { container } = render(
            <SourceViewer
                ariaLabel="dashboard.ts source"
                content={content}
                copyLabel="Copy dashboard.ts"
                language="typescript"
                languageLabel="TypeScript"
            />
        );

        expect(screen.getByText("TypeScript")).toBeTruthy();
        expect(screen.getByText("3 lines")).toBeTruthy();
        expect(screen.getByRole("region", { name: "dashboard.ts source" })).toBeTruthy();
        const code = container.querySelector("code[data-language='typescript']");
        expect(code?.textContent).toBe(content);
        expect(screen.getByRole("button", { name: "Copy dashboard.ts" })).toBeTruthy();
        expect(screen.getByRole("switch", { name: "Wrap lines" })).toBeChecked();
        expect(screen.getByTestId("source-viewer-source")).toHaveClass(
            "bg-transparent",
            "source-viewer-source-wrapped"
        );
        const highlighted = await screen.findByTestId("syntax-highlighted-source");
        expect(highlighted.querySelectorAll(".source-viewer-line")).toHaveLength(3);
        expect(highlighted.querySelector(".hljs-keyword")).toHaveTextContent("const");
        expect(highlighted.querySelector(".hljs-number")).toHaveTextContent("42");
        expect(highlighted.querySelector("[style]")).toBeNull();
    });

    test("wraps long lines by default and preserves exact content when wrapping is disabled", async () => {
        const user = userEvent.setup();
        const content = `const longValue = "${"workspace/".repeat(80)}";`;
        const { container } = render(
            <SourceViewer
                ariaLabel="long.ts source"
                content={content}
                copyLabel="Copy long.ts"
                language="typescript"
                languageLabel="TypeScript"
            />
        );
        const wrapSwitch = screen.getByRole("switch", { name: "Wrap lines" });
        const source = screen.getByTestId("source-viewer-source");

        expect(wrapSwitch).toBeChecked();
        expect(source).toHaveClass("source-viewer-source-wrapped");
        expect(
            container.querySelector("code[data-language='typescript']")?.textContent
        ).toBe(content);

        await user.click(wrapSwitch);

        expect(wrapSwitch).not.toBeChecked();
        expect(source).toHaveClass("source-viewer-source-unwrapped");
        expect(
            container.querySelector("code[data-language='typescript']")?.textContent
        ).toBe(content);
    });

    test("wraps and line-numbers plain source without parsing it", () => {
        const content = "first plain line\nsecond plain line";
        const { container } = render(
            <SourceViewer
                ariaLabel="notes.txt source"
                content={content}
                copyLabel="Copy notes.txt"
                language="text"
                languageLabel="Plain text"
            />
        );
        const code = container.querySelector("code[data-language='text']");

        expect(code?.textContent).toBe(content);
        expect(code?.querySelectorAll(".source-viewer-line")).toHaveLength(2);
        expect(code).toHaveClass("source-viewer-lines-numbered");
        expect(
            container.querySelector("[data-testid='syntax-highlighted-source']")
        ).toBeNull();
    });
});
