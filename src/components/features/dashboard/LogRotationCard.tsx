import { RotateCw } from "lucide-react";

import {
    useLogRotationStatus,
    useRunLogRotationDryRun,
    useRunLogRotationNow,
} from "../../../hooks/useLogRotation";
import { formatDate } from "../../../utils/format";
import { Button } from "../../ui/Button";
import { Card } from "../../ui/Card";

export function LogRotationCard() {
    const status = useLogRotationStatus(30_000);
    const dryRun = useRunLogRotationDryRun();
    const realRun = useRunLogRotationNow();
    const lastAction = realRun.data || dryRun.data;
    const lastRun = status.data?.lastRun;

    return (
        <Card className="overflow-hidden">
            <div className="border-b border-primary-700 px-4 py-3">
                <div className="flex items-center justify-between gap-3">
                    <div>
                        <div className="flex items-center gap-2 text-lg font-semibold">
                            <RotateCw className="h-4 w-4 text-accent-400" />
                            Log rotation
                        </div>
                        <div className="text-xs text-primary-400">
                            n8n scheduled workflow for approved file logs under
                            /opt/docker/data.
                        </div>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                        <Button
                            size="sm"
                            onClick={() => dryRun.mutate()}
                            disabled={dryRun.isPending || realRun.isPending}
                        >
                            {dryRun.isPending ? "Running..." : "Run dry-run now"}
                        </Button>
                        <Button
                            size="sm"
                            variant="danger"
                            onClick={() => realRun.mutate()}
                            disabled={dryRun.isPending || realRun.isPending}
                        >
                            {realRun.isPending ? "Running..." : "Run real now"}
                        </Button>
                    </div>
                </div>
            </div>

            <div className="grid gap-4 px-4 py-4 md:grid-cols-2 xl:grid-cols-5">
                <Card className="p-4">
                    <div className="text-sm text-primary-400">Workflow</div>
                    <div className="mt-2 text-lg font-semibold">Scheduled real</div>
                </Card>
                <Card className="p-4">
                    <div className="text-sm text-primary-400">Schedule</div>
                    <div className="mt-2 text-lg font-semibold">02:00 daily</div>
                </Card>
                <Card className="p-4">
                    <div className="text-sm text-primary-400">Retention</div>
                    <div className="mt-2 text-lg font-semibold">3 archives</div>
                </Card>
                <Card className="p-4">
                    <div className="text-sm text-primary-400">Rotate at</div>
                    <div className="mt-2 text-lg font-semibold">10 MB / daily</div>
                </Card>
                <Card className="p-4">
                    <div className="text-sm text-primary-400">Last run</div>
                    <div className="mt-2 text-lg font-semibold">
                        {lastRun?.finishedAt
                            ? formatDate(new Date(lastRun.finishedAt))
                            : "—"}
                    </div>
                    <div className="mt-1 text-xs text-primary-400">
                        {lastRun
                            ? `${lastRun.rotatedFiles} rotated · ${lastRun.errors.length} errors`
                            : status.isLoading
                              ? "Loading..."
                              : "No recorded run yet"}
                    </div>
                </Card>
            </div>

            {lastAction ? (
                <div className="border-t border-primary-700 px-4 py-3">
                    <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-primary-400">
                        Last {lastAction.result?.dryRun ? "dry-run" : "real run"} output
                    </div>
                    <pre className="max-h-52 overflow-auto rounded-lg bg-black/40 p-3 text-xs text-primary-100">
                        {JSON.stringify(lastAction, null, 2)}
                    </pre>
                </div>
            ) : null}
        </Card>
    );
}
