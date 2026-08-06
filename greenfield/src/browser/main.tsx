import { StrictMode, Suspense } from "react";
import { createRoot, type Root } from "react-dom/client";

import LazyDashboardBrowserBootstrap from "./lazyBootstrap.tsx";

const rootElement = document.querySelector("#root");
if (!(rootElement instanceof HTMLElement)) {
    throw new TypeError("Dashboard browser root is missing");
}

/** Root owned by the browser entrypoint for its complete document lifetime. */
export const dashboardBrowserRoot: Root = createRoot(rootElement);

dashboardBrowserRoot.render(
    <StrictMode>
        <Suspense
            fallback={
                <main
                    aria-busy="true"
                    className="flex min-h-screen items-center justify-center bg-slate-950 px-4 text-slate-200"
                >
                    <output>Loading Dashboard…</output>
                </main>
            }
        >
            <LazyDashboardBrowserBootstrap />
        </Suspense>
    </StrictMode>
);
