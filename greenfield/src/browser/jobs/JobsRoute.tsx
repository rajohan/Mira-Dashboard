import { useNavigate, useSearch } from "@tanstack/react-router";
import { useState } from "react";

import { OpenClawCronBrowser } from "../openClawCron/OpenClawCronBrowser.tsx";
import { Button } from "../ui/Button.tsx";
import { PageHeader } from "../ui/PageHeader.tsx";
import { parseJobsRouteSearch } from "./jobRouteSearch.ts";
import { JobRunBrowser } from "./JobRunBrowser.tsx";
import { ScheduleBrowser } from "./ScheduleBrowser.tsx";
import { useJobRealtimeInvalidation } from "./useJobRealtimeInvalidation.ts";

function DashboardJobsContent() {
    useJobRealtimeInvalidation();
    const [focusRunId, setFocusRunId] = useState<string>();
    const handleRunFocus = (id: string) => {
        setFocusRunId((current) => (current === id ? undefined : current));
    };

    return (
        <div className="space-y-12">
            <JobRunBrowser
                focusRunId={focusRunId}
                onRequestRunFocus={setFocusRunId}
                onRunFocusHandled={handleRunFocus}
            />
            <ScheduleBrowser onRequestRunFocus={setFocusRunId} />
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
            <PageHeader
                description="Dashboard-local durable jobs and separately owned OpenClaw Gateway cron automations."
                eyebrow="Operations"
                title="Jobs"
            />
            <fieldset className="border-primary-700 mt-6 inline-flex rounded-lg border p-1">
                <legend className="sr-only">Job source</legend>
                <Button
                    aria-pressed={source === "dashboard"}
                    onClick={() => selectSource("dashboard")}
                    variant={source === "dashboard" ? "primary" : "ghost"}
                >
                    Dashboard jobs
                </Button>
                <Button
                    aria-pressed={source === "openclaw"}
                    onClick={() => selectSource("openclaw")}
                    variant={source === "openclaw" ? "primary" : "ghost"}
                >
                    OpenClaw cron
                </Button>
            </fieldset>
            <div className="mt-8">
                {source === "dashboard" ? (
                    <DashboardJobsContent />
                ) : (
                    <OpenClawCronBrowser
                        onSelectedJobChange={(cronJobId) =>
                            void navigate({
                                replace: true,
                                search: { ...search, cronJobId, source: "openclaw" },
                            })
                        }
                        selectedJobId={search.cronJobId}
                    />
                )}
            </div>
        </div>
    );
}
