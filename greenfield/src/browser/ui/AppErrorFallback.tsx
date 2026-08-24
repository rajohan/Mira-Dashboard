import type { FallbackProps } from "react-error-boundary";

import { PageState } from "./PageState.tsx";

/**
 * Renders the redacted application-level React error fallback.
 * @returns A recoverable full-page error state without private exception details.
 */
export function AppErrorFallback({ resetErrorBoundary }: FallbackProps) {
    return (
        <main className="bg-primary-950 text-primary-100 flex min-h-screen items-center justify-center px-4">
            <PageState
                message="The browser application could not finish rendering. No private error details were displayed."
                onRetry={resetErrorBoundary}
                status="error"
                title="Dashboard unavailable"
            />
        </main>
    );
}
