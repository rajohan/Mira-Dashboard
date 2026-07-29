export type TerminalOutputElement = Pick<
    HTMLDivElement,
    "clientHeight" | "scrollHeight" | "scrollTop"
>;

/**
 * Returns whether terminal output is currently scrolled near the bottom.
 * @param output Output value.
 * @returns Whether terminal output is currently scrolled near the bottom.
 */
export function isTerminalOutputAtBottom(
    output: TerminalOutputElement | undefined
): boolean {
    if (!output) {
        return false;
    }

    return output.scrollHeight - output.scrollTop - output.clientHeight < 30;
}

/**
 * Scrolls terminal output to the bottom when present.
 * @returns Scroll terminal output to bottom result.
 */
export function scrollTerminalOutputToBottom(output?: TerminalOutputElement): boolean {
    if (!output) {
        return false;
    }

    output.scrollTop = output.scrollHeight;
    return true;
}

/**
 * Scrolls terminal output and reports whether scrolling happened.
 * @param output Output value.
 * @param onScrolled Callback invoked to handle scrolled.
 * @returns Scroll terminal output to bottom and report result.
 */
export function scrollTerminalOutputToBottomAndReport(
    output: TerminalOutputElement | undefined,
    onScrolled: () => void
): boolean {
    if (!scrollTerminalOutputToBottom(output)) {
        return false;
    }

    onScrolled();
    return true;
}
