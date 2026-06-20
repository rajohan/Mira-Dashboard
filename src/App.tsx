import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { lazy, Suspense, useEffect } from "react";
import { ErrorBoundary } from "react-error-boundary";

import { AppErrorFallback } from "./components/ui/AppErrorFallback";
import { OpenClawSocketProvider } from "./hooks/useOpenClawSocket";
import { queryClient } from "./lib/queryClient";
import { router } from "./router";

const isEnableDevtools = import.meta.env?.MODE !== "production";
const DashboardDevtools = isEnableDevtools
    ? lazy(() => import("./components/devtools/DashboardDevtools"))
    : undefined;

/** Renders the app UI. */
export default function App() {
    useEffect(() => {
        /** Performs on unauthorized. */
        const onUnauthorized = () => {
            void router.navigate({ to: "/login" });
        };

        window.addEventListener("openclaw:unauthorized", onUnauthorized);
        return () => {
            window.removeEventListener("openclaw:unauthorized", onUnauthorized);
        };
    }, []);

    return (
        <ErrorBoundary FallbackComponent={AppErrorFallback}>
            <QueryClientProvider client={queryClient}>
                <OpenClawSocketProvider>
                    <RouterProvider router={router} />
                    {DashboardDevtools ? (
                        <Suspense fallback={null}>
                            <DashboardDevtools />
                        </Suspense>
                    ) : undefined}
                </OpenClawSocketProvider>
            </QueryClientProvider>
        </ErrorBoundary>
    );
}
