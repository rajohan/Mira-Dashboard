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
            <div className="border-primary-700 border-b px-4 py-3">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div className="min-w-0">
                        <div className="flex items-center gap-2 text-lg font-semibold">
                            <RotateCw className="text-accent-400 h-4 w-4" />
                            Log rotation
                        </div>
                        <div className="text-primary-400 text-xs">
                            n8n scheduled workflow for approved file logs under
                            /opt/docker/data.
                        </div>
                    </div>
                    <div className="grid grid-cols-1 gap-2 sm:flex sm:flex-wrap sm:items-center">
                        <Button
                            size="sm"
                            onClick={() => dryRun.mutate()}
                            disabled={dryRun.isPending || realRun.isPending}
                            className="w-full sm:w-auto"
                        >
                            {dryRun.isPending ? "Running..." : "Run dry-run now"}
                        </Button>
                        <Button
                            size="sm"
                            variant="danger"
                            onClick={() => realRun.mutate()}
                            disabled={dryRun.isPending || realRun.isPending}
                            className="w-full sm:w-auto"
                        >
                            {realRun.isPending ? "Running..." : "Run real now"}
                        </Button>
                    </div>
                </div>
            </div>

            <div className="grid gap-4 px-4 py-4 md:grid-cols-2 xl:grid-cols-5">
                <Card className="p-4">
                    <div className="text-primary-400 text-sm">Workflow</div>
                    <div className="mt-2 text-lg font-semibold">Scheduled real</div>
                </Card>
                <Card className="p-4">
                    <div className="text-primary-400 text-sm">Schedule</div>
                    <div className="mt-2 text-lg font-semibold">02:10 daily</div>
                </Card>
                <Card className="p-4">
                    <div className="text-primary-400 text-sm">Retention</div>
                    <div className="mt-2 text-lg font-semibold">3 archives</div>
                </Card>
                <Card className="p-4">
                    <div className="text-primary-400 text-sm">Rotate at</div>
                    <div className="mt-2 text-lg font-semibold">10 MB / daily</div>
                </Card>
                <Card className="p-4">
                    <div className="text-primary-400 text-sm">Last run</div>
                    <div className="mt-2 text-lg font-semibold">
                        {lastRun?.finishedAt
                            ? formatDate(new Date(lastRun.finishedAt))
                            : "—"}
                    </div>
                    <div className="text-primary-400 mt-1 text-xs">
                        {lastRun
                            ? `${lastRun.rotatedFiles} rotated · ${lastRun.errors.length} errors`
                            : status.isLoading
                              ? "Loading..."
                              : "No recorded run yet"}
                    </div>
                </Card>
            </div>

            {lastAction ? (
                <div className="border-primary-700 border-t px-4 py-3">
                    <div className="text-primary-400 mb-2 text-xs font-semibold tracking-wide uppercase">
                        Last {lastAction.result?.dryRun ? "dry-run" : "real run"} output
                    </div>
                    <pre className="text-primary-100 max-h-52 overflow-auto rounded-lg bg-black/40 p-3 text-xs">
                        {JSON.stringify(lastAction, null, 2)}
                    </pre>
                </div>
            ) : null}
        </Card>
    );
}
