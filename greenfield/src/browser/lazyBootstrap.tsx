import { lazy } from "react";

const DashboardBrowserBootstrap = lazy(() => import("./bootstrap.tsx"));

/**
 * Defers the application providers and route graph behind the minimal document bootstrap.
 * @returns The lazy Dashboard application boundary.
 */
export default function LazyDashboardBrowserBootstrap() {
    return <DashboardBrowserBootstrap />;
}
