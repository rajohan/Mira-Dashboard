import { createContext, use } from "react";

import type { TerminalBrowserProps } from "./TerminalBrowser.tsx";

export type TerminalBrowserDependencies = Pick<
    TerminalBrowserProps,
    "createEmulator" | "createSocketConnection"
>;

export const defaultTerminalBrowserDependencies: TerminalBrowserDependencies =
    Object.freeze({});
export const TerminalBrowserDependenciesContext =
    createContext<TerminalBrowserDependencies>(defaultTerminalBrowserDependencies);

/** @returns Production defaults or explicitly injected terminal adapters. */
export function useTerminalBrowserDependencies(): TerminalBrowserDependencies {
    return use(TerminalBrowserDependenciesContext);
}
