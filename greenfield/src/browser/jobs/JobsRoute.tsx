import { useState } from "react";

import { PageHeader } from "../ui/PageHeader.tsx";
import { JobRunBrowser } from "./JobRunBrowser.tsx";
import { ScheduleBrowser } from "./ScheduleBrowser.tsx";
import { useJobRealtimeInvalidation } from "./useJobRealtimeInvalidation.ts";

/** @returns Dashboard-local durable schedules, queue state, and run history. */
export function JobsRoute() {
    useJobRealtimeInvalidation();
    const [focusRunId, setFocusRunId] = useState<string>();
    const handleRunFocus = (id: string) => {
        setFocusRunId((current) => (current === id ? undefined : current));
    };

    return (
        <div>
            <PageHeader
                description="Dashboard-local schedules, durable queue state, workers, and bounded execution history."
                eyebrow="Operations"
                title="Jobs"
            />
            <div className="mt-8 space-y-12">
                <JobRunBrowser
                    focusRunId={focusRunId}
                    onRequestRunFocus={setFocusRunId}
                    onRunFocusHandled={handleRunFocus}
                />
                <ScheduleBrowser onRequestRunFocus={setFocusRunId} />
            </div>
        </div>
    );
}
