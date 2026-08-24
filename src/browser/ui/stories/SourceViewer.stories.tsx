import type { Meta, StoryObj } from "@storybook/tanstack-react";
import { expect, userEvent, waitFor, within } from "storybook/test";

import { SourceViewer } from "../SourceViewer.tsx";

const meta = {
    args: {
        ariaLabel: "Example TypeScript source",
        content: [
            "interface WorkspaceFile {",
            "    readonly name: string;",
            "    readonly writable: boolean;",
            "}",
            "",
            "export const file: WorkspaceFile = {",
            '    name: "README.md",',
            "    writable: true,",
            "};",
        ].join("\n"),
        copyLabel: "Copy example source",
        language: "typescript",
        languageLabel: "TypeScript",
    },
    component: SourceViewer,
    parameters: { layout: "padded" },
} satisfies Meta<typeof SourceViewer>;

export default meta;

type Story = StoryObj<typeof meta>;

const longSource = [
    "export const workspace = {",
    `    path: "${"workspace/projects/mira-dashboard/".repeat(24)}",`,
    "    writable: true,",
    "    retries: 3,",
    "};",
].join("\n");
const fiveDigitLineTail = "last-source-line";
// The CSS gutter is fixed-width; measuring "10000" below proves five-digit capacity
// without forcing the browser to highlight and mount ten thousand equivalent rows.
const fiveDigitLineSource = `${"\n".repeat(11)}${fiveDigitLineTail}`;

export const TypeScriptSource: Story = {
    decorators: [
        (Story) => (
            <div className="border-primary-700 h-96 overflow-hidden rounded-lg border">
                <Story />
            </div>
        ),
    ],
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        await expect(canvas.getByText("TypeScript")).toBeVisible();
        await expect(canvas.getByText("9 lines")).toBeVisible();
        await expect(
            canvas.getByRole("button", { name: "Copy example source" })
        ).toBeVisible();
    },
};

export const LongLinesWrapByDefault: Story = {
    args: {
        ariaLabel: "Long TypeScript source",
        content: longSource,
        copyLabel: "Copy long source",
    },
    decorators: [
        (Story) => (
            <div className="border-primary-700 h-96 max-w-2xl overflow-hidden rounded-lg border">
                <Story />
            </div>
        ),
    ],
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        const region = canvas.getByRole("region", { name: "Long TypeScript source" });
        const wrapSwitch = canvas.getByRole("switch", { name: "Wrap lines" });
        const source = canvas.getByTestId("source-viewer-source");
        const highlighted = canvas.getByTestId("syntax-highlighted-source");
        const code = canvasElement.querySelector("code[data-language='typescript']");
        const sourceLines =
            highlighted.querySelectorAll<HTMLElement>(".source-viewer-line");
        const referenceLine = sourceLines[0];
        const longLine = sourceLines[1];
        const keyword = highlighted.querySelector<HTMLElement>(".hljs-keyword");
        const string = highlighted.querySelector<HTMLElement>(".hljs-string");
        const number = highlighted.querySelector<HTMLElement>(".hljs-number");

        if (
            !(code instanceof HTMLElement) ||
            !referenceLine ||
            !longLine ||
            !keyword ||
            !string ||
            !number
        ) {
            throw new TypeError(
                "Source story did not render the expected highlighted tokens"
            );
        }

        await expect(wrapSwitch).toBeChecked();
        await expect(source).toHaveClass("source-viewer-source-wrapped");
        await expect(code.textContent).toBe(longSource);
        await expect(highlighted.querySelectorAll(".source-viewer-line")).toHaveLength(5);
        await expect(highlighted.querySelector("[style]")).toBeNull();
        await expect(getComputedStyle(source).backgroundColor).toBe("rgba(0, 0, 0, 0)");
        await expect(getComputedStyle(source).color).toBe("rgb(248, 248, 242)");
        await expect(getComputedStyle(keyword).color).toBe("rgb(255, 54, 125)");
        await expect(getComputedStyle(string).color).toBe("rgb(230, 219, 116)");
        await expect(getComputedStyle(number).color).toBe("rgb(174, 129, 255)");
        await waitFor(() =>
            expect(region.scrollWidth).toBeLessThanOrEqual(region.clientWidth + 1)
        );
        await expect(longLine.getBoundingClientRect().height).toBeGreaterThan(
            referenceLine.getBoundingClientRect().height
        );

        await userEvent.click(wrapSwitch);

        await expect(wrapSwitch).not.toBeChecked();
        await expect(source).toHaveClass("source-viewer-source-unwrapped");
        await expect(code.textContent).toBe(longSource);
        await waitFor(() =>
            expect(region.scrollWidth).toBeGreaterThan(region.clientWidth)
        );
        region.scrollLeft = region.scrollWidth;
        await waitFor(() => expect(region.scrollLeft).toBeGreaterThan(0));
        await expect(getComputedStyle(longLine, "::before").position).toBe("sticky");
        await expect(longLine.getBoundingClientRect().height).toBeLessThanOrEqual(
            referenceLine.getBoundingClientRect().height + 1
        );
    },
};

export const LongLinesMobileWrap: Story = {
    args: {
        ariaLabel: "Mobile TypeScript source",
        content: longSource,
        copyLabel: "Copy mobile source",
    },
    decorators: [
        (Story) => (
            <div className="border-primary-700 h-128 w-full overflow-hidden rounded-lg border">
                <Story />
            </div>
        ),
    ],
    globals: { viewport: { isRotated: false, value: "mobile1" } },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        const region = canvas.getByRole("region", { name: "Mobile TypeScript source" });
        const toolbar = canvas.getByTestId("source-viewer-toolbar");
        const wrapSwitch = canvas.getByRole("switch", { name: "Wrap lines" });
        const copyButton = canvas.getByRole("button", { name: "Copy mobile source" });
        const code = canvasElement.querySelector("code[data-language='typescript']");
        const sourceLines =
            canvasElement.querySelectorAll<HTMLElement>(".source-viewer-line");
        const referenceLine = sourceLines[0];
        const longLine = sourceLines[1];

        if (!(code instanceof HTMLElement) || !referenceLine || !longLine) {
            throw new TypeError("Mobile source story did not render its code element");
        }

        await expect(wrapSwitch).toBeChecked();
        await expect(copyButton).toBeVisible();
        await expect(code.textContent).toBe(longSource);
        await waitFor(() =>
            expect(region.scrollWidth).toBeLessThanOrEqual(region.clientWidth + 1)
        );
        await expect(longLine.getBoundingClientRect().height).toBeGreaterThan(
            referenceLine.getBoundingClientRect().height
        );
        await expect(toolbar.scrollWidth).toBeLessThanOrEqual(toolbar.clientWidth + 1);
        await expect(toolbar.getBoundingClientRect().left).toBeGreaterThanOrEqual(
            canvasElement.getBoundingClientRect().left
        );
        await expect(toolbar.getBoundingClientRect().right).toBeLessThanOrEqual(
            canvasElement.getBoundingClientRect().right
        );
    },
};

export const FiveDigitLineNumberGutter: Story = {
    args: {
        ariaLabel: "Five-digit gutter source",
        content: fiveDigitLineSource,
        copyLabel: "Copy five-digit gutter source",
        language: "text",
        languageLabel: "Plain text",
    },
    decorators: [
        (Story) => (
            <div className="border-primary-700 h-96 max-w-2xl overflow-hidden rounded-lg border">
                <Story />
            </div>
        ),
    ],
    play: async ({ canvasElement }) => {
        const code = canvasElement.querySelector<HTMLElement>(
            "code.source-viewer-lines[data-language='text']"
        );
        const toolbar = canvasElement.querySelector<HTMLElement>(
            "[data-testid='source-viewer-toolbar']"
        );

        if (!code || !toolbar) {
            throw new TypeError("Gutter story did not render its source surface");
        }

        const lastLine = code.lastElementChild;
        if (
            !(lastLine instanceof HTMLElement) ||
            !lastLine.classList.contains("source-viewer-line")
        ) {
            throw new TypeError("Source story did not render its final line");
        }

        const wrapSwitch = within(toolbar).getByRole("switch", { name: "Wrap lines" });
        const gutterStyle = getComputedStyle(lastLine, "::before");
        const textContext = document.createElement("canvas").getContext("2d");
        if (!textContext) {
            throw new TypeError("Maximum source story could not measure its line number");
        }
        textContext.font = gutterStyle.font;

        await expect({
            color: gutterStyle.color,
            content: gutterStyle.content,
            lastLine: lastLine.textContent,
            left: gutterStyle.left,
            lineCount: code.childElementCount,
            lineElementsOnly:
                code.querySelector(":scope > :not(.source-viewer-line)") === null,
            lineNumberFits: textContext.measureText("10000").width < 48,
            paddingRight: gutterStyle.paddingRight,
            position: gutterStyle.position,
            width: gutterStyle.width,
            wrapChecked: wrapSwitch.getAttribute("aria-checked") === "true",
        }).toEqual({
            color: "rgb(133, 140, 153)",
            content: "counter(source-viewer-line-number)",
            lastLine: fiveDigitLineTail,
            left: "0px",
            lineCount: 12,
            lineElementsOnly: true,
            lineNumberFits: true,
            paddingRight: "16px",
            position: "sticky",
            width: "64px",
            wrapChecked: true,
        });
    },
};
