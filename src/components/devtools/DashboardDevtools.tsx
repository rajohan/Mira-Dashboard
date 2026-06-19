import { TanStackDevtools } from "@tanstack/react-devtools";
import { FormDevtoolsPanel } from "@tanstack/react-form-devtools";
import { ReactQueryDevtoolsPanel } from "@tanstack/react-query-devtools";
import { TanStackRouterDevtoolsPanel } from "@tanstack/react-router-devtools";

/** Renders TanStack devtools in local development. */
function DashboardDevtools() {
    return (
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
    );
}

export default DashboardDevtools;
