import { DashboardBrowserApplication } from "./application.tsx";
import { createDashboardQueryClient } from "./queryClient.ts";
import { createDashboardRouter } from "./router.tsx";

const queryClient = createDashboardQueryClient();
const router = createDashboardRouter();

/**
 * Owns browser services constructed once for the application lifetime.
 * @returns The composed Dashboard browser application.
 */
export default function DashboardBrowserBootstrap() {
    return <DashboardBrowserApplication queryClient={queryClient} router={router} />;
}
