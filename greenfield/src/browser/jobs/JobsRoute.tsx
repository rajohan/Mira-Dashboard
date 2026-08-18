import { useNavigate, useSearch } from "@tanstack/react-router";
import { useState } from "react";

import { OpenClawCronBrowser } from "../openClawCron/OpenClawCronBrowser.tsx";
import { Tabs } from "../ui/Tabs.tsx";
import { parseJobsRouteSearch } from "./jobRouteSearch.ts";
import { JobRunBrowser } from "./JobRunBrowser.tsx";
import { ScheduleBrowser } from "./ScheduleBrowser.tsx";
import { useJobRealtimeInvalidation } from "./useJobRealtimeInvalidation.ts";

function DashboardJobsContent() {
    useJobRealtimeInvalidation();
    const [focusRunId, setFocusRunId] = useState<string>();
    return (
        <div className="space-y-12">
            <JobRunBrowser onRequestRunFocus={setFocusRunId} />
            <ScheduleBrowser
                focusRunId={focusRunId}
                onRequestRunFocus={setFocusRunId}
                onRunFocusHandled={() => setFocusRunId(undefined)}
            />
        </div>
    );
}

/** @returns Isolated Dashboard-local jobs and Gateway-owned OpenClaw cron surfaces. */
export function JobsRoute() {
    const navigate = useNavigate({ from: "/jobs" });
    const search = parseJobsRouteSearch(useSearch({ from: "/jobs" }) as unknown);
    const source =
        search.source ?? (search.cronJobId === undefined ? "dashboard" : "openclaw");
    const selectSource = (nextSource: "dashboard" | "openclaw") => {
        void navigate({ search: { ...search, source: nextSource } });
    };

    return (
        <div>
            <h1 className="sr-only">Jobs</h1>
            <Tabs
                ariaLabel="Job source"
                onChange={selectSource}
                tabs={[
                    {
                        label: "Dashboard jobs",
                        panel: source === "dashboard" ? <DashboardJobsContent /> : null,
                        value: "dashboard",
                    },
                    {
                        label: "OpenClaw schedules",
                        panel:
                            source === "openclaw" ? (
                                <OpenClawCronBrowser
                                    onSelectedJobChange={(cronJobId) =>
                                        void navigate({
                                            replace: true,
                                            search: {
                                                ...search,
                                                cronJobId,
                                                source: "openclaw",
                                            },
                                        })
                                    }
                                    selectedJobId={search.cronJobId}
                                />
                            ) : null,
                        value: "openclaw",
                    },
                ]}
                value={source}
            />
        </div>
    );
}
