import { StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";

import DashboardBrowserApplicationRoot from "./application.tsx";

const rootElement = document.querySelector("#root");
if (!(rootElement instanceof HTMLElement)) {
    throw new TypeError("Dashboard browser root is missing");
}

/** Root owned by the browser entrypoint for its complete document lifetime. */
export const dashboardBrowserRoot: Root = createRoot(rootElement);

dashboardBrowserRoot.render(
    <StrictMode>
        <DashboardBrowserApplicationRoot />
    </StrictMode>
);
