import { RotateCcw } from "lucide-react";
import type { ReactNode } from "react";

import type {
    DashboardReleaseStatus,
    DashboardReleaseSummary,
    ProductionCheckoutStatus,
} from "../../../hooks";
import { formatDate } from "../../../utils/format";
import { Badge } from "../../ui/Badge";
import { Button } from "../../ui/Button";
import { Card, CardTitle } from "../../ui/Card";

function areCommitsEquivalent(
    left: string | undefined,
    right: string | undefined
): boolean {
    if (!left || !right) return false;
    return left.startsWith(right) || right.startsWith(left);
}

/** Renders one managed release slot. */
function ReleaseSlot({
    badge,
    label,
    release,
}: {
    badge: ReactNode;
    label: string;
    release: DashboardReleaseSummary | undefined;
}) {
    return (
        <div className="rounded border border-primary-700 bg-primary-900/40 p-3">
            <div className="flex items-start justify-between gap-2">
                <div className="text-xs font-medium tracking-wide text-primary-500 uppercase">
                    {label}
                </div>
                {badge}
            </div>
            {release ? (
                <>
                    <a
                        href={release.commitUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="mt-2 line-clamp-2 block text-sm font-medium wrap-break-word text-primary-200 hover:text-primary-50"
                    >
                        {release.commitTitle}
                    </a>
                    <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-primary-500">
                        <code>{release.commitSha.slice(0, 8)}</code>
                        <span>Built {formatDate(release.builtAt)}</span>
                        <span>Schema v{release.schema.target}</span>
                    </div>
                </>
            ) : (
                <p className="mt-2 text-sm text-primary-400">No release available.</p>
            )}
        </div>
    );
}

interface ProductionReleasesCardProperties {
    baseBranch: string;
    checkout: ProductionCheckoutStatus | undefined;
    error: Error | undefined;
    isActionPending: boolean;
    onRollback: (release: DashboardReleaseSummary) => void;
    release: DashboardReleaseStatus | undefined;
}

/** Renders managed release state and the manual rollback control. */
export function ProductionReleasesCard({
    baseBranch,
    checkout,
    error,
    isActionPending,
    onRollback,
    release,
}: ProductionReleasesCardProperties) {
    const checkoutCommit = checkout?.headCommit || checkout?.head;
    const isMainCheckoutActive = areCommitsEquivalent(
        release?.current?.commitSha,
        checkoutCommit
    );
    const rollbackReason =
        error?.message ||
        (isActionPending ? "Another Dashboard action is in progress" : undefined) ||
        release?.rollback.reason ||
        (release ? undefined : "Managed release status is still loading");
    const rollbackReasonId = rollbackReason ? "rollback-disabled-reason" : undefined;

    return (
        <Card variant="bordered" className="space-y-3">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                <div>
                    <CardTitle className="text-base">Production releases</CardTitle>
                    <p className="mt-1 text-sm text-primary-400">
                        Active and previous are immutable release slots. A previous
                        release is offered as a rollback target only while its latest
                        runtime result is eligible.
                    </p>
                </div>
                <Badge
                    variant={error ? "error" : release?.current ? "success" : "warning"}
                    className="w-fit shrink-0 whitespace-nowrap"
                >
                    {error
                        ? "Status unavailable"
                        : release?.current
                          ? "Managed release active"
                          : "Checking releases"}
                </Badge>
            </div>

            {error ? <p className="text-sm text-red-300">{error.message}</p> : undefined}

            <div className="grid gap-2 lg:grid-cols-3">
                <ReleaseSlot
                    label="Active"
                    release={release?.current}
                    badge={
                        <Badge variant={release?.current ? "success" : "default"}>
                            {release?.current ? "Current" : "Unavailable"}
                        </Badge>
                    }
                />
                <ReleaseSlot
                    label={
                        release?.previous && !release.rollback.available
                            ? "Previous slot"
                            : "Rollback target"
                    }
                    release={release?.previous}
                    badge={
                        <Badge
                            variant={
                                release?.previous
                                    ? release.rollback.available
                                        ? "warning"
                                        : "error"
                                    : "default"
                            }
                        >
                            {release?.previous
                                ? release.rollback.available
                                    ? "Previous"
                                    : "Not eligible"
                                : "Unavailable"}
                        </Badge>
                    }
                />
                <div className="rounded border border-primary-700 bg-primary-900/40 p-3">
                    <div className="flex items-start justify-between gap-2">
                        <div className="text-xs font-medium tracking-wide text-primary-500 uppercase">
                            Main checkout
                        </div>
                        <Badge
                            variant={
                                checkoutCommit
                                    ? isMainCheckoutActive
                                        ? "success"
                                        : "info"
                                    : "default"
                            }
                            className="shrink-0 whitespace-nowrap"
                        >
                            {checkoutCommit
                                ? isMainCheckoutActive
                                    ? "Active"
                                    : "Deploy available"
                                : "Checking"}
                        </Badge>
                    </div>
                    <div className="mt-2 text-sm font-medium text-primary-200">
                        {checkoutCommit?.slice(0, 8) || "Checking…"}
                    </div>
                    <p className="mt-1 text-xs text-primary-500">
                        Control checkout. Deploy syncs latest {baseBranch} first
                    </p>
                </div>
            </div>

            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <p id={rollbackReasonId} className="text-xs text-primary-400">
                    {rollbackReason ||
                        `Ready to roll back to ${release?.previous?.commitSha.slice(0, 8)}.`}
                </p>
                <Button
                    variant="danger"
                    onClick={() => {
                        if (release?.previous) onRollback(release.previous);
                    }}
                    disabled={
                        isActionPending ||
                        !release?.rollback.available ||
                        !release.previous
                    }
                    aria-describedby={rollbackReasonId}
                    className="shrink-0"
                >
                    <RotateCcw className="size-4" />
                    {release?.previous
                        ? `Roll back to ${release.previous.commitSha.slice(0, 8)}`
                        : "Rollback unavailable"}
                </Button>
            </div>
        </Card>
    );
}
