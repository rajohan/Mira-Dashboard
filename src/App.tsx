import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { TanStackDevtools } from "@tanstack/react-devtools";
import { ReactQueryDevtoolsPanel } from "@tanstack/react-query-devtools";
import { TanStackRouterDevtoolsPanel } from "@tanstack/react-router-devtools";
import { FormDevtoolsPanel } from "@tanstack/react-form-devtools";

import { router } from "./router";
import { queryClient } from "./lib/queryClient";
import { OpenClawSocketProvider } from "./hooks/useOpenClawSocket";

function App() {
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
