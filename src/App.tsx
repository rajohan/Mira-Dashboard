import { TanStackDevtools } from "@tanstack/react-devtools";
import { FormDevtoolsPanel } from "@tanstack/react-form-devtools";
import { QueryClientProvider } from "@tanstack/react-query";
import { ReactQueryDevtoolsPanel } from "@tanstack/react-query-devtools";
import { RouterProvider } from "@tanstack/react-router";
import { TanStackRouterDevtoolsPanel } from "@tanstack/react-router-devtools";
import { useEffect } from "react";
import { ErrorBoundary } from "react-error-boundary";

import { AppErrorFallback } from "./components/ui/AppErrorFallback";
import { OpenClawSocketProvider } from "./hooks/useOpenClawSocket";
import { queryClient } from "./lib/queryClient";
import { router } from "./router";

/** Renders the app UI. */
function App() {
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
                    <TanStackDevtools
                        plugins={[
                            {
                                name: "TanStack Query",
                                render: <ReactQueryDevtoolsPanel />,
                            },
                            {
                                name: "TanStack Router",
                                render: <TanStackRouterDevtoolsPanel />,
                            },
                            {
                                name: "TanStack Form",
                                render: <FormDevtoolsPanel />,
                            },
                        ]}
                    />
                </OpenClawSocketProvider>
            </QueryClientProvider>
        </ErrorBoundary>
    );
}

export default App;
