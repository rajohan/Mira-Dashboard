declare module "bun:test" {
    interface Matchers<T = unknown> {
        toBeDisabled(): void;
        toBeEnabled(): void;
        toBeInTheDocument(): void;
        toContainElement(element: HTMLElement | SVGElement | null): void;
        toHaveAttribute(name: string, value?: unknown): void;
        toHaveClass(...classNames: string[]): void;
        toHaveClass(classNames: string, options?: { exact: boolean }): void;
        toHaveFocus(): void;
        toHaveStyle(style: Record<string, unknown> | string): void;
        toHaveTextContent(
            text: RegExp | string,
            options?: { normalizeWhitespace: boolean }
        ): void;
        toHaveValue(value?: number | string | string[] | null): void;
    }
}
