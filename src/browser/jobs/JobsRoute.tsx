import { useNavigate, useSearch } from "@tanstack/react-router";
import { useState } from "react";

import { OpenClawCronBrowser } from "../openClawCron/OpenClawCronBrowser.tsx";
import { Tabs } from "../ui/Tabs.tsx";
import { type JobsRouteSearch, parseJobsRouteSearch } from "./jobRouteSearch.ts";
import { JobRunBrowser } from "./JobRunBrowser.tsx";
import { ScheduleBrowser } from "./ScheduleBrowser.tsx";
import { useJobRealtimeInvalidation } from "./useJobRealtimeInvalidation.ts";

function DashboardJobsContent() {
    useJobRealtimeInvalidation();
    const initialRunId = useSearch({
        from: "/jobs",
        select: (value) => parseJobsRouteSearch(value).runId,
    });
    const [focusRunId, setFocusRunId] = useState<string | undefined>(initialRunId);
    return (
        <div className="space-y-4">
            <JobRunBrowser onRequestRunFocus={setFocusRunId} />
            <ScheduleBrowser
                focusRunId={focusRunId}
                onRequestRunFocus={setFocusRunId}
                onRunFocusHandled={() => setFocusRunId(undefined)}
            />
        </div>
    );
}

function OpenClawJobsContent() {
    const navigate = useNavigate({ from: "/jobs" });
    const selectedJobId = useSearch({
        from: "/jobs",
        select: (value) => parseJobsRouteSearch(value).cronJobId,
    });
    return (
        <OpenClawCronBrowser
            onSelectedJobChange={(cronJobId) =>
                void navigate({
                    replace: true,
                    search: (current: JobsRouteSearch) => ({
                        ...current,
                        cronJobId,
                        source: "openclaw",
                    }),
                })
            }
            selectedJobId={selectedJobId}
        />
    );
}

/** @returns Isolated Dashboard-local jobs and Gateway-owned OpenClaw cron surfaces. */
export function JobsRoute() {
    const navigate = useNavigate({ from: "/jobs" });
    const source = useSearch({
        from: "/jobs",
        select: (value) => {
            const search = parseJobsRouteSearch(value);
            return (
                search.source ??
                (search.cronJobId === undefined ? "dashboard" : "openclaw")
            );
        },
    });
    const selectSource = (nextSource: "dashboard" | "openclaw") => {
        void navigate({
            search: (current: JobsRouteSearch) => ({
                ...current,
                source: nextSource,
            }),
        });
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
                        panel: source === "openclaw" ? <OpenClawJobsContent /> : null,
                        value: "openclaw",
                    },
                ]}
                value={source}
            />
        </div>
    );
}
