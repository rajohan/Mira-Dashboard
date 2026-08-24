import type { ReactNode } from "react";

import {
    defaultTerminalBrowserDependencies,
    TerminalBrowserDependenciesContext,
    type TerminalBrowserDependencies,
} from "./terminalBrowserDependenciesContext.ts";

export interface TerminalBrowserDependenciesProviderProps {
    readonly children: ReactNode;
    readonly value?: TerminalBrowserDependencies;
}

/** @returns A narrow test/workbench seam around the production terminal adapters. */
export function TerminalBrowserDependenciesProvider({
    children,
    value = defaultTerminalBrowserDependencies,
}: TerminalBrowserDependenciesProviderProps) {
    return (
        <TerminalBrowserDependenciesContext value={value}>
            {children}
        </TerminalBrowserDependenciesContext>
    );
}
