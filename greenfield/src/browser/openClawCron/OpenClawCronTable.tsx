import type { OpenClawCronJob } from "../../contracts/openClawCron.ts";
import { formatDashboardDateTime } from "../lib/formatDateTime.ts";
import { Badge } from "../ui/Badge.tsx";
import { Text } from "../ui/Text.tsx";
import { openClawCronScheduleLabel } from "./presentation.ts";

interface OpenClawCronTableProps {
    readonly jobs: readonly OpenClawCronJob[];
    readonly onSelect: (id: string) => void;
    readonly selectedId?: string;
}

function synchronizationVariant(state: OpenClawCronJob["synchronization"]["state"]) {
    if (state === "confirmed") return "success" as const;
    if (state === "pending") return "warning" as const;
    return "danger" as const;
}

/** @returns Accessible Gateway-owned cron inventory, explicitly separate from Dashboard jobs. */
export function OpenClawCronTable({
    jobs,
    onSelect,
    selectedId,
}: OpenClawCronTableProps) {
    return (
        <div className="border-primary-700 max-w-full overflow-x-auto rounded-lg border">
            <table aria-label="OpenClaw cron jobs" className="w-full min-w-224">
                <thead className="bg-primary-900">
                    <tr>
                        {[
                            "OpenClaw job",
                            "Gateway state",
                            "Dashboard sync",
                            "Schedule",
                            "Next run",
                        ].map((heading) => (
                            <th
                                className="text-primary-300 border-primary-700 border-b px-3 py-2 text-left text-xs font-semibold tracking-wide uppercase"
                                key={heading}
                                scope="col"
                            >
                                {heading}
                            </th>
                        ))}
                    </tr>
                </thead>
                <tbody>
                    {jobs.map((job) => (
                        <tr className="border-primary-700 border-b text-sm" key={job.id}>
                            <td className="p-3">
                                <button
                                    aria-current={
                                        job.id === selectedId ? "true" : undefined
                                    }
                                    className="text-primary-100 hover:text-accent-300 text-left font-medium wrap-break-word"
                                    onClick={() => onSelect(job.id)}
                                    type="button"
                                >
                                    {job.name}
                                </button>
                                <Text className="mt-1 font-mono" size="sm" tone="muted">
                                    {job.id}
                                </Text>
                            </td>
                            <td className="p-3">
                                <Badge variant={job.enabled ? "success" : "default"}>
                                    {job.enabled ? "enabled" : "disabled"}
                                </Badge>
                            </td>
                            <td className="p-3">
                                <Badge
                                    variant={synchronizationVariant(
                                        job.synchronization.state
                                    )}
                                >
                                    {job.synchronization.state}
                                </Badge>
                            </td>
                            <td className="p-3 font-mono text-xs wrap-break-word">
                                {openClawCronScheduleLabel(job)}
                            </td>
                            <td className="p-3">
                                {job.state.nextRunAtMs === undefined ? (
                                    <Text tone="muted">—</Text>
                                ) : (
                                    <time
                                        dateTime={new Date(
                                            job.state.nextRunAtMs
                                        ).toISOString()}
                                    >
                                        {formatDashboardDateTime(job.state.nextRunAtMs)}
                                    </time>
                                )}
                            </td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}
