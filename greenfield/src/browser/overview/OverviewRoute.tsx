import { CacheBrowser } from "../cache/CacheBrowser.tsx";
import { PageHeader } from "../ui/PageHeader.tsx";
import { OverviewAgentsSection } from "./OverviewAgentsSection.tsx";
import { OverviewIncidentsSection } from "./OverviewIncidentsSection.tsx";
import { OverviewJobsSection } from "./OverviewJobsSection.tsx";
import { OverviewNotificationsSection } from "./OverviewNotificationsSection.tsx";
import { OverviewReportsSection } from "./OverviewReportsSection.tsx";
import { OverviewTasksSection } from "./OverviewTasksSection.tsx";
import { SystemMetricsSection } from "./SystemMetricsSection.tsx";

/** @returns Progressive operational overview composed only from implemented domains. */
export function OverviewRoute() {
    return (
        <div>
            <PageHeader
                description="See current system activity, recent work, alerts, and saved background-check results in one place."
                eyebrow="Operations"
                title="Mira Dashboard"
            />
            <div className="mt-8">
                <SystemMetricsSection />
            </div>
            <div className="mt-10 grid gap-6 xl:grid-cols-2">
                <OverviewTasksSection />
                <OverviewAgentsSection />
                <OverviewNotificationsSection />
                <OverviewIncidentsSection />
            </div>
            <div className="mt-10">
                <OverviewJobsSection />
            </div>
            <div className="mt-10">
                <OverviewReportsSection />
            </div>
            <div className="mt-10">
                <CacheBrowser />
            </div>
        </div>
    );
}
