import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { ErrorBoundary, type FallbackProps } from "react-error-boundary";

import type { DashboardRouter } from "./router.tsx";

function DashboardErrorFallback({ resetErrorBoundary }: FallbackProps) {
    return (
        <main className="flex min-h-screen items-center justify-center bg-slate-950 px-4 text-slate-100">
            <section
                aria-labelledby="application-error-heading"
                className="w-full max-w-lg rounded-xl border border-red-900/60 bg-slate-900 p-6"
                role="alert"
            >
                <p className="text-sm font-medium text-red-300">Application error</p>
                <h1
                    className="mt-2 text-2xl font-semibold text-white"
                    id="application-error-heading"
                >
                    Dashboard unavailable
                </h1>
                <p className="mt-3 text-sm leading-6 text-slate-300">
                    The browser application could not finish rendering. No private error
                    details were displayed.
                </p>
                <button
                    className="mt-5 rounded-md bg-blue-500 px-4 py-2 text-sm font-semibold text-white outline-none hover:bg-blue-400 focus-visible:ring-2 focus-visible:ring-blue-300 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-900"
                    onClick={resetErrorBoundary}
                    type="button"
                >
                    Try again
                </button>
            </section>
        </main>
    );
}

/** Browser application dependencies constructed once by `main.tsx`. */
export interface DashboardBrowserApplicationProps {
    readonly queryClient: QueryClient;
    readonly router: DashboardRouter;
}

/**
 * Renders the root error, query, and routing boundaries.
 * @returns The composed browser application.
 */
export function DashboardBrowserApplication({
    queryClient,
    router,
}: DashboardBrowserApplicationProps) {
    return (
        <ErrorBoundary FallbackComponent={DashboardErrorFallback}>
            <QueryClientProvider client={queryClient}>
                <RouterProvider router={router} />
            </QueryClientProvider>
        </ErrorBoundary>
    );
}
