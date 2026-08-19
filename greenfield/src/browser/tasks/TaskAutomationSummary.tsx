import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";

import type { OpenClawCronJob } from "../../contracts/openClawCron.ts";
import type { TaskAutomationProfile } from "../../contracts/taskModel.ts";
import { useDashboardTrpcClient } from "../api/trpcContextValue.ts";
import { formatDashboardDateTimeToMinute } from "../lib/formatDateTime.ts";
import { openClawCronDetailQueryOptions } from "../openClawCron/openClawCronQueries.ts";
import {
    openClawCronOperationalStatus,
    openClawCronScheduleLabel,
    openClawCronSessionTargetLabel,
} from "../openClawCron/presentation.ts";
import { ActionLink } from "../ui/ActionLink.tsx";
import { Alert } from "../ui/Alert.tsx";
import { Badge } from "../ui/Badge.tsx";
import { Button } from "../ui/Button.tsx";
import { Heading } from "../ui/Heading.tsx";
import { Text } from "../ui/Text.tsx";

interface TaskAutomationSummaryProps {
    readonly automation: TaskAutomationProfile;
}

function timestamp(timestampMs: number | undefined): ReactNode {
    if (timestampMs === undefined) return "—";
    return (
        <time dateTime={new Date(timestampMs).toISOString()}>
            {formatDashboardDateTimeToMinute(timestampMs)}
        </time>
    );
}

function runtimeLabel(
    automation: TaskAutomationProfile,
    job: OpenClawCronJob | undefined
): string {
    const payload = job?.payload.kind === "agent-turn" ? job.payload : undefined;
    return (
        [payload?.model ?? automation.model, payload?.thinking ?? automation.thinking]
            .filter((value): value is string => value !== undefined)
            .join(" · ") || "—"
    );
}

/** @returns Stored task automation metadata enriched by one exact live cron observation. */
export function TaskAutomationSummary({ automation }: TaskAutomationSummaryProps) {
    const client = useDashboardTrpcClient();
    const cron = useQuery(openClawCronDetailQueryOptions(client, automation.cronJobId));
    const job = cron.data?.job;
    const status =
        job === undefined
            ? {
                  label: cron.isPending ? "Checking status…" : "Status unavailable",
                  variant: "default" as const,
              }
            : openClawCronOperationalStatus(job);
    const retainedStatus =
        cron.data?.freshness.kind === "last-known-good" ||
        (cron.data !== undefined && cron.error !== null);
    let availabilityMessage: string | undefined;
    if (job === undefined) {
        availabilityMessage = cron.isPending
            ? "Checking the current OpenClaw status. Stored task metadata is shown meanwhile."
            : "Current OpenClaw status is unavailable. Stored task metadata is shown.";
    }
    const schedule =
        job === undefined
            ? (automation.scheduleSummary ?? "—")
            : openClawCronScheduleLabel(job);
    const session =
        job === undefined
            ? (automation.sessionTarget ?? "—")
            : openClawCronSessionTargetLabel(job.sessionTarget);

    return (
        <section className="border-primary-700 bg-primary-900/40 mt-5 rounded-lg border p-4">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                <div>
                    <Heading level={3}>OpenClaw automation</Heading>
                    <Text className="mt-1" size="sm" tone="muted">
                        {automation.recurring
                            ? "This task tracks a recurring OpenClaw job."
                            : "This task is linked to an OpenClaw job."}
                    </Text>
                </div>
                <div className="flex shrink-0 flex-wrap items-center gap-2 sm:justify-end">
                    <Badge variant="info">
                        {automation.recurring ? "Recurring" : "Automated"}
                    </Badge>
                    <Badge variant={status.variant}>{status.label}</Badge>
                </div>
            </div>
            {availabilityMessage !== undefined && (
                <Text className="mt-3" size="sm" tone="muted">
                    {availabilityMessage}
                </Text>
            )}
            <Alert
                action={
                    retainedStatus ? (
                        <Button
                            busy={cron.isFetching}
                            onClick={() => void cron.refetch()}
                            size="sm"
                            variant="secondary"
                        >
                            Try again
                        </Button>
                    ) : undefined
                }
                className="mt-3"
                focusOnError={false}
                message={
                    retainedStatus
                        ? "The latest refresh failed, so the last available OpenClaw status is shown."
                        : undefined
                }
                variant="warning"
            />
            <dl className="mt-4 grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2 lg:grid-cols-3">
                <div className="min-w-0">
                    <dt className="text-primary-400 text-xs font-medium tracking-wide uppercase">
                        Cron job
                    </dt>
                    <dd className="mt-1 max-w-full text-sm wrap-anywhere">
                        <ActionLink
                            aria-label={`Open OpenClaw cron job ${automation.cronJobId}`}
                            className="text-accent-300 hover:text-accent-200 inline-flex max-w-full items-center"
                            search={{
                                cronJobId: automation.cronJobId,
                                source: "openclaw",
                            }}
                            to="/jobs"
                        >
                            <span className="wrap-anywhere">
                                {job?.name ?? automation.cronJobId}
                            </span>
                        </ActionLink>
                    </dd>
                </div>
                <div className="min-w-0">
                    <dt className="text-primary-400 text-xs font-medium tracking-wide uppercase">
                        Schedule
                    </dt>
                    <dd className="text-primary-100 mt-1 text-sm wrap-anywhere">
                        {schedule}
                    </dd>
                </div>
                <div className="min-w-0">
                    <dt className="text-primary-400 text-xs font-medium tracking-wide uppercase">
                        Next run
                    </dt>
                    <dd className="text-primary-100 mt-1 text-sm">
                        {timestamp(job?.state.nextRunAtMs)}
                    </dd>
                </div>
                <div className="min-w-0">
                    <dt className="text-primary-400 text-xs font-medium tracking-wide uppercase">
                        Last run
                    </dt>
                    <dd className="text-primary-100 mt-1 text-sm">
                        {timestamp(job?.state.lastRunAtMs)}
                    </dd>
                </div>
                <div className="min-w-0">
                    <dt className="text-primary-400 text-xs font-medium tracking-wide uppercase">
                        Session
                    </dt>
                    <dd className="text-primary-100 mt-1 text-sm wrap-anywhere">
                        {session}
                    </dd>
                </div>
                <div className="min-w-0">
                    <dt className="text-primary-400 text-xs font-medium tracking-wide uppercase">
                        Runtime
                    </dt>
                    <dd className="text-primary-100 mt-1 text-sm wrap-anywhere">
                        {runtimeLabel(automation, job)}
                    </dd>
                </div>
            </dl>
        </section>
    );
}
