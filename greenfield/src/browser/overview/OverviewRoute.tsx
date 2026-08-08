import { CacheBrowser } from "../cache/CacheBrowser.tsx";
import { PageHeader } from "../ui/PageHeader.tsx";

/** @returns Progressive operational overview composed only from implemented domains. */
export function OverviewRoute() {
    return (
        <div>
            <PageHeader
                description="Validated operational projections stay visible through transient refresh failures while the remaining overview providers are rewritten."
                eyebrow="Operations"
                title="Mira Dashboard"
            />
            <div className="mt-8">
                <CacheBrowser />
            </div>
        </div>
    );
}
