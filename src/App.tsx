import { TanStackDevtools } from "@tanstack/react-devtools";
import { FormDevtoolsPanel } from "@tanstack/react-form-devtools";
import { QueryClientProvider } from "@tanstack/react-query";
import { ReactQueryDevtoolsPanel } from "@tanstack/react-query-devtools";
import { RouterProvider } from "@tanstack/react-router";
import { TanStackRouterDevtoolsPanel } from "@tanstack/react-router-devtools";
import { useEffect } from "react";

import { OpenClawSocketProvider } from "./hooks/useOpenClawSocket";
import { queryClient } from "./lib/queryClient";
import { router } from "./router";

function App() {
    useEffect(() => {
        const onUnauthorized = () => {
            void router.navigate({ to: "/login" });
        };

        window.addEventListener("openclaw:unauthorized", onUnauthorized);
        return () => {
            window.removeEventListener("openclaw:unauthorized", onUnauthorized);
        };
    }, []);

    return (
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
    );
}

export default App;
