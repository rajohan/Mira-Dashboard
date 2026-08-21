import { useSearch } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { dashboardPageContainerClassName } from "../layout/dashboardShellLayout.ts";
import { cn } from "../lib/classNames.ts";
import { Alert } from "../ui/Alert.tsx";
import { TerminalBrowser } from "./TerminalBrowser.tsx";
import { useTerminalBrowserDependencies } from "./terminalBrowserDependenciesContext.ts";
import { parseTerminalRouteSearch } from "./terminalRouteSearch.ts";

interface TerminalPageLayoutProps {
    readonly children: ReactNode;
}

/**
 * Keeps the terminal canvas aligned with normal Dashboard pages while allowing
 * the shell's main viewport to scroll when the controls and canvas exceed it.
 * @returns A height-preserving workspace slot without a redundant page intro.
 */
export function TerminalPageLayout({ children }: TerminalPageLayoutProps) {
    return (
        <div className={cn(dashboardPageContainerClassName, "flex min-h-full flex-col")}>
            <div className="flex min-h-0 flex-1 flex-col">{children}</div>
            <div aria-hidden="true" className="h-8 shrink-0" />
        </div>
    );
}

/** @returns A recent-MFA-gated, worker-owned interactive PTY canvas. */
export function TerminalRoute() {
    const dependencies = useTerminalBrowserDependencies();
    const { dockerContainerId } = parseTerminalRouteSearch(
        useSearch({ from: "/terminal" }) as unknown
    );
    return (
        <TerminalPageLayout>
            {dockerContainerId !== undefined && (
                <Alert
                    focusOnError={false}
                    message={`Docker console handoff selected container ${dockerContainerId.slice(0, 12)}. Starting a new terminal opens an interactive /bin/sh inside that exact container.`}
                    variant="warning"
                />
            )}
            <div
                className={
                    dockerContainerId === undefined
                        ? undefined
                        : "mt-4 flex min-h-0 flex-1 flex-col"
                }
            >
                <TerminalBrowser
                    {...dependencies}
                    {...(dockerContainerId === undefined ? {} : { dockerContainerId })}
                />
            </div>
        </TerminalPageLayout>
    );
}
