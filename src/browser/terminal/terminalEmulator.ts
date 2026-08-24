import { FitAddon } from "@xterm/addon-fit";
import { Terminal, type IDisposable, type ITerminalOptions } from "@xterm/xterm";

import {
    terminalColumnsMaximum,
    terminalColumnsMinimum,
    type TerminalDimensions,
    terminalRowsMaximum,
    terminalRowsMinimum,
} from "../../contracts/terminal.ts";

const terminalScrollbackRows = 2000;

/** Explicitly disabled xterm window-report and manipulation capabilities. */
export const terminalWindowOptions = Object.freeze({
    fullscreenWin: false,
    getCellSizePixels: false,
    getIconTitle: false,
    getScreenSizeChars: false,
    getScreenSizePixels: false,
    getWinPosition: false,
    getWinSizeChars: false,
    getWinSizePixels: false,
    getWinState: false,
    getWinTitle: false,
    lowerWin: false,
    maximizeWin: false,
    minimizeWin: false,
    popTitle: false,
    pushTitle: false,
    raiseWin: false,
    refreshWin: false,
    restoreWin: false,
    setWinLines: false,
    setWinPosition: false,
    setWinSizeChars: false,
    setWinSizePixels: false,
});

/** Security- and accessibility-relevant xterm defaults for the PTY canvas. */
export const terminalEmulatorOptions = Object.freeze({
    allowProposedApi: false,
    allowTransparency: false,
    altClickMovesCursor: false,
    cursorBlink: true,
    cursorInactiveStyle: "outline",
    disableStdin: true,
    fontFamily:
        '"SFMono-Regular", Consolas, "Liberation Mono", Menlo, ui-monospace, monospace',
    fontSize: 14,
    linkHandler: null,
    logLevel: "off",
    minimumContrastRatio: 4.5,
    reflowCursorLine: true,
    rightClickSelectsWord: true,
    screenReaderMode: true,
    scrollback: terminalScrollbackRows,
    smoothScrollDuration: 0,
    theme: {
        background: "#0b0b0c",
        black: "#17181b",
        blue: "#77a8ff",
        brightBlack: "#686f7b",
        brightBlue: "#a7c7ff",
        brightCyan: "#91e4ea",
        brightGreen: "#83e5a8",
        brightMagenta: "#d8a7ff",
        brightRed: "#ff9b9b",
        brightWhite: "#ffffff",
        brightYellow: "#f6d675",
        cursor: "#a7c7ff",
        cursorAccent: "#0b0b0c",
        cyan: "#5fc5cd",
        foreground: "#e7e9ee",
        green: "#51c878",
        magenta: "#bd7dea",
        red: "#ef7777",
        selectionBackground: "#315b91",
        white: "#d2d5dc",
        yellow: "#d9b94f",
    },
    windowOptions: terminalWindowOptions,
} satisfies ITerminalOptions);

export interface TerminalEmulator {
    clear(): void;
    copySelection(): Promise<"copied" | "empty" | "unavailable">;
    dispose(): void;
    fit(): TerminalDimensions;
    focus(): void;
    open(container: HTMLElement): void;
    onInput(callback: (data: Uint8Array) => void): () => void;
    reset(): void;
    setInputEnabled(enabled: boolean): void;
    write(data: Uint8Array, callback: () => void): void;
}

export type TerminalEmulatorFactory = () => TerminalEmulator;

function clamp(value: number, minimum: number, maximum: number): number {
    return Math.max(minimum, Math.min(maximum, value));
}

function binaryStringBytes(value: string): Uint8Array {
    const bytes = new Uint8Array(value.length);
    for (let index = 0; index < value.length; index += 1) {
        bytes[index] = (value.codePointAt(index) ?? 0) & 255;
    }
    return bytes;
}

/**
 * Creates the sole renderer for unmodified PTY bytes. It does not register link,
 * clipboard, title, logging, or window-manipulation integrations.
 * @returns One non-persistent xterm adapter.
 */
export function createXtermTerminalEmulator(): TerminalEmulator {
    const terminal = new Terminal(terminalEmulatorOptions);
    const fitAddon = new FitAddon();
    const disposables: IDisposable[] = [];
    const encoder = new TextEncoder();
    terminal.loadAddon(fitAddon);
    // Explicitly consume remote clipboard writes. No clipboard addon is loaded.
    disposables.push(terminal.parser.registerOscHandler(52, () => true));

    const emulator: TerminalEmulator = {
        clear() {
            terminal.clear();
        },
        async copySelection() {
            const selection = terminal.getSelection();
            if (selection.length === 0) return "empty";
            if (globalThis.navigator.clipboard?.writeText === undefined) {
                return "unavailable";
            }
            try {
                await globalThis.navigator.clipboard.writeText(selection);
                return "copied";
            } catch {
                return "unavailable";
            }
        },
        dispose() {
            for (const disposable of disposables) disposable.dispose();
            fitAddon.dispose();
            terminal.dispose();
        },
        fit() {
            const proposed = fitAddon.proposeDimensions();
            const dimensions = Object.freeze({
                columns: clamp(
                    proposed?.cols ?? terminal.cols,
                    terminalColumnsMinimum,
                    terminalColumnsMaximum
                ),
                rows: clamp(
                    proposed?.rows ?? terminal.rows,
                    terminalRowsMinimum,
                    terminalRowsMaximum
                ),
            });
            if (
                dimensions.columns !== terminal.cols ||
                dimensions.rows !== terminal.rows
            ) {
                terminal.resize(dimensions.columns, dimensions.rows);
            }
            return dimensions;
        },
        focus: () => terminal.focus(),
        open(container) {
            terminal.open(container);
            terminal.textarea?.setAttribute("aria-label", "Interactive terminal input");
        },
        onInput(callback) {
            const data = terminal.onData((value) => callback(encoder.encode(value)));
            const binary = terminal.onBinary((value) =>
                callback(binaryStringBytes(value))
            );
            return () => {
                data.dispose();
                binary.dispose();
            };
        },
        reset() {
            terminal.reset();
            terminal.clear();
        },
        setInputEnabled(enabled) {
            terminal.options.disableStdin = !enabled;
        },
        write: (data, callback) => terminal.write(data, callback),
    };
    return Object.freeze(emulator);
}
