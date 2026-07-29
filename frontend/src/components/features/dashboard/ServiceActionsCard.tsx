import { AlertTriangle, Loader2, Play, Terminal } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { parseSystemHostSummary } from "../../../../../contracts/system";
import type { OpsActionDefinition } from "../../../hooks";
import {
    OPS_ACTIONS,
    useCacheEntry,
    useExecJob,
    useRefreshCacheEntry,
    useStartOpsAction,
} from "../../../hooks";
import { formatDate } from "../../../utils/format";
import { Badge } from "../../ui/Badge";
import { Card } from "../../ui/Card";
import { ConfirmModal } from "../../ui/ConfirmModal";

interface ServiceActionsCardProperties {
    className?: string;
}

/**
 * Renders the service actions card UI.
 * @returns Rendered the service actions card UI.
 */
export function ServiceActionsCard({ className }: ServiceActionsCardProperties = {}) {
    const startAction = useStartOpsAction();
    const refreshCache = useRefreshCacheEntry();
    const { data: systemHost } = useCacheEntry(
        "system.host",
        parseSystemHostSummary,
        60_000
    );
    const versionInfo = systemHost?.data.version;
    const versionAlertText = versionInfo?.latest
        ? `New OpenClaw version available (${versionInfo.current} -> ${versionInfo.latest}).`
        : `New OpenClaw version available (${versionInfo?.current} -> not available).`;

    const [pendingAction, setPendingAction] = useState<OpsActionDefinition | undefined>();
    const [runningActionId, setRunningActionId] = useState<string | undefined>();
    const [runningActionLabel, setRunningActionLabel] = useState<string | undefined>();
    const [runningJobId, setRunningJobId] = useState<string | undefined>();
    const outputRef = useRef<HTMLPreElement | undefined>(undefined);
    const refreshedUpdateJobIdRef = useRef<string | undefined>(undefined);
    const [shouldAutoFollowOutput, setShouldAutoFollowOutput] = useState(true);

    const execJob = useExecJob(runningJobId);

    useEffect(() => {
        if (!runningActionLabel || !execJob.data || execJob.data.status !== "done") {
            return;
        }

        if (
            runningActionId === "openclaw_update" &&
            runningJobId &&
            refreshedUpdateJobIdRef.current !== runningJobId
        ) {
            refreshedUpdateJobIdRef.current = runningJobId;
            void (async () => {
                try {
                    await refreshCache.mutateAsync("system.host");
                } catch {
                    // Best-effort refresh after a host update.
                }
            })();
        }
    }, [execJob.data, refreshCache, runningActionId, runningActionLabel, runningJobId]);

    /** Performs confirm run. */
    async function confirmRun() {
        if (!pendingAction) {
            return;
        }

        const actionToRun = pendingAction;
        setPendingAction(undefined);
        setRunningActionId(actionToRun.id);
        setRunningActionLabel(actionToRun.label);
        setRunningJobId(undefined);
        setShouldAutoFollowOutput(true);

        try {
            const started = await startAction.mutateAsync(actionToRun);
            setRunningJobId(started.jobId);
        } catch {
            setRunningActionId(undefined);
            setRunningActionLabel(undefined);
            setRunningJobId(undefined);
        }
    }

    const logs = execJob.data
        ? [execJob.data.stdout, execJob.data.stderr].filter(Boolean).join("\n").trim()
        : "";

    const outputMeta = execJob.data
        ? {
              action: runningActionLabel || "Running action",
              ranAt: execJob.data.startedAt,
              ...(execJob.data.status === "done" && { code: execJob.data.code }),
              running: execJob.data.status !== "done",
          }
        : undefined;

    const isRunningAction = Boolean(
        runningActionId && (!execJob.data || execJob.data.status !== "done")
    );
    const isAnyActionPending = startAction.isPending || isRunningAction;

    useEffect(() => {
        if (!shouldAutoFollowOutput || !outputRef.current) {
            return;
        }

        outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }, [logs, shouldAutoFollowOutput]);

    return (
        <>
            <Card className={className}>
                <div className="mb-3 flex items-center justify-between gap-2">
                    <h3 className="text-sm font-semibold tracking-wide text-primary-300 uppercase">
                        Actions
                    </h3>
                </div>

                {versionInfo?.updateAvailable ? (
                    <div className="mb-3 rounded border border-primary-700 bg-primary-900/30 px-3 py-2 text-xs text-amber-200">
                        <div className="flex items-center gap-2">
                            <AlertTriangle className="size-3.5" />
                            {versionAlertText}
                        </div>
                    </div>
                ) : undefined}

                <div className="grid grid-cols-1 gap-3">
                    {(["system", "openclaw"] as const).map((scope) => (
                        <div
                            key={scope}
                            className="rounded-lg border border-primary-700 bg-primary-900/30 p-3"
                        >
                            <div className="mb-2 text-xs font-semibold tracking-wide text-primary-300 uppercase">
                                {scope === "system"
                                    ? "System Actions"
                                    : "OpenClaw Actions"}
                            </div>

                            <div className="grid grid-cols-1 gap-2 lg:grid-cols-3">
                                {OPS_ACTIONS.filter(
                                    (action) => action.scope === scope
                                ).map((action) => (
                                    <button
                                        key={action.id}
                                        type="button"
                                        className="flex h-full flex-col rounded-lg border border-primary-700 bg-primary-800/40 p-3 text-left transition hover:border-primary-500 disabled:cursor-not-allowed disabled:opacity-60"
                                        onClick={() => setPendingAction(action)}
                                        disabled={isAnyActionPending}
                                    >
                                        <div className="mb-1 flex items-center justify-between gap-2">
                                            <span className="text-sm text-primary-100">
                                                {action.label}
                                            </span>
                                            {action.danger ? (
                                                <Badge variant="error">Caution</Badge>
                                            ) : undefined}
                                        </div>
                                        <div className="min-h-10 text-xs text-primary-400">
                                            {action.description}
                                        </div>
                                        {runningActionId === action.id &&
                                        isRunningAction ? (
                                            <div className="mt-auto inline-flex items-center gap-1 pt-2 text-xs text-primary-300">
                                                <Loader2 className="size-3.5 animate-spin" />
                                                Running...
                                            </div>
                                        ) : (
                                            <div className="mt-auto inline-flex items-center gap-1 pt-2 text-xs text-primary-300">
                                                <Play className="size-3.5" />
                                                Run
                                            </div>
                                        )}
                                    </button>
                                ))}
                            </div>
                        </div>
                    ))}
                </div>

                {outputMeta && (
                    <div className="mt-4 rounded-lg border border-primary-700 bg-primary-900/60 p-3">
                        <div className="mb-2 text-xs text-primary-400">
                            {outputMeta.running ? "Running" : "Last run"}:{" "}
                            {outputMeta.action} · {formatDate(new Date(outputMeta.ranAt))}
                            {outputMeta.running
                                ? " · in progress"
                                : ` · exit code ${String(outputMeta.code ?? "not available")}`}
                        </div>
                        <div className="mb-1 inline-flex items-center gap-1 text-xs text-primary-300">
                            <Terminal className="size-3.5" />
                            Output
                        </div>
                        <pre
                            ref={(element) => {
                                outputRef.current = element ?? undefined;
                            }}
                            onScroll={(event) => {
                                const element = event.currentTarget;
                                const distanceFromBottom =
                                    element.scrollHeight -
                                    element.scrollTop -
                                    element.clientHeight;
                                const isAtBottom = distanceFromBottom <= 8;
                                setShouldAutoFollowOutput((wasPrevious) =>
                                    wasPrevious === isAtBottom ? wasPrevious : isAtBottom
                                );
                            }}
                            className="max-h-52 overflow-auto rounded bg-black/30 p-2 text-xs whitespace-pre-wrap text-primary-200"
                        >
                            {logs || "No output"}
                        </pre>
                    </div>
                )}
            </Card>

            <ConfirmModal
                isOpen={Boolean(pendingAction)}
                title={pendingAction?.label || "Confirm action"}
                message={pendingAction?.confirmMessage || "Run this action?"}
                confirmLabel={pendingAction?.confirmLabel || "Run"}
                danger={pendingAction?.danger}
                onCancel={() => {
                    if (!startAction.isPending) {
                        setPendingAction(undefined);
                    }
                }}
                onConfirm={() => {
                    void confirmRun();
                }}
            />
        </>
    );
}
