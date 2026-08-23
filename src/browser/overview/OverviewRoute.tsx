import { CacheBrowser } from "../cache/CacheBrowser.tsx";
import { Heading } from "../ui/Heading.tsx";
import { OverviewServiceActionsSection } from "./OverviewServiceActionsSection.tsx";
import { SystemMetricsSection } from "./SystemMetricsSection.tsx";

/** @returns Progressive operational overview composed only from implemented domains. */
export function OverviewRoute() {
    return (
        <div>
            <Heading className="sr-only" level={1}>
                Dashboard
            </Heading>
            <SystemMetricsSection />
            <div className="mt-4">
                <OverviewServiceActionsSection />
            </div>
            <div className="mt-4">
                <CacheBrowser />
            </div>
        </div>
    );
}
