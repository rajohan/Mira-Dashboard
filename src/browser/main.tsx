import { StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";

import DashboardBrowserApplicationRoot from "./application.tsx";

interface DashboardHotData {
    dashboardBrowserRoot?: Root;
}

const rootElement = document.querySelector("#root");
if (!(rootElement instanceof HTMLElement)) {
    throw new TypeError("Dashboard browser root is missing");
}

/** Root owned by the browser entrypoint and preserved across Bun HMR updates. */
export const dashboardBrowserRoot: Root = ((
    import.meta.hot.data as DashboardHotData
).dashboardBrowserRoot ??= createRoot(rootElement));

dashboardBrowserRoot.render(
    <StrictMode>
        <DashboardBrowserApplicationRoot />
    </StrictMode>
);
