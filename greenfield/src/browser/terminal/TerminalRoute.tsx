import type { ReactNode } from "react";

import { dashboardPageContainerClassName } from "../layout/dashboardShellLayout.ts";
import { cn } from "../lib/classNames.ts";
import { PageHeader } from "../ui/PageHeader.tsx";
import { TerminalBrowser } from "./TerminalBrowser.tsx";

interface TerminalPageLayoutProps {
    readonly children: ReactNode;
}

/**
 * Keeps the full-height terminal canvas aligned with normal Dashboard pages.
 * @returns The shared Terminal heading and a height-preserving workspace slot.
 */
export function TerminalPageLayout({ children }: TerminalPageLayoutProps) {
    return (
        <div
            className={cn(
                dashboardPageContainerClassName,
                "flex h-full min-h-[calc(100dvh-8rem)] flex-col"
            )}
        >
            <div className="shrink-0">
                <PageHeader
                    description="Open an interactive terminal that starts in the folder you choose. The Dashboard does not save terminal input or output."
                    eyebrow="Operations"
                    title="Terminal"
                />
            </div>
            <div className="mt-8 flex min-h-0 flex-1 flex-col">{children}</div>
        </div>
    );
}

/** @returns A recent-MFA-gated, worker-owned interactive PTY canvas. */
export function TerminalRoute() {
    return (
        <TerminalPageLayout>
            <TerminalBrowser />
        </TerminalPageLayout>
    );
}
