import { AlertTriangle, Loader2, Play, Terminal } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type { ExecResponse, OpsActionDefinition } from "../../../hooks";
import {
    OPS_ACTIONS,
    useCacheEntry,
    useExecJob,
    useRefreshCacheEntry,
    useStartOpsAction,
} from "../../../hooks";
import { formatDate } from "../../../utils/format";
import { emptyElementReference } from "../../../utils/reactReferences";
import { Badge } from "../../ui/Badge";
import { Card } from "../../ui/Card";
import { ConfirmModal } from "../../ui/ConfirmModal";

/** Renders the service actions card UI. */
export function ServiceActionsCard() {
    const startAction = useStartOpsAction();
    const refreshCache = useRefreshCacheEntry();
    const { data: systemHost } = useCacheEntry<{
        version?: {
            current: string;
            latest: string | undefined;
            updateAvailable: boolean;
        };
    }>("system.host", 60_000);
    const versionInfo = systemHost?.data.version;

    const [pendingAction, setPendingAction] = useState<OpsActionDefinition | undefined>(
        undefined
    );
    const [runningActionId, setRunningActionId] = useState<string | undefined>(undefined);
    const [runningActionLabel, setRunningActionLabel] = useState<string | undefined>(
        undefined
    );
    const [runningJobId, setRunningJobId] = useState<string | undefined>(undefined);
    const [result, setResult] = useState<
        | undefined
        | {
              action: string;
              response: ExecResponse;
              ranAt: number;
          }
    >(undefined);
    const outputReference = useRef(emptyElementReference<HTMLPreElement>());
    const [shouldAutoFollowOutput, setShouldAutoFollowOutput] = useState(true);

    const execJob = useExecJob(runningJobId);

    useEffect(() => {
        if (!execJob.data || execJob.data.status !== "done" || !runningActionLabel) {
            return;
        }

        const completedActionId = runningActionId;

        setResult({
            action: runningActionLabel,
            response: {
                code: execJob.data.code,
                stdout: execJob.data.stdout,
                stderr: execJob.data.stderr,
            },
            ranAt: execJob.data.endedAt || Date.now(),
        });

        setRunningActionId(undefined);
        setRunningActionLabel(undefined);
        setRunningJobId(undefined);

        if (completedActionId === "openclaw_update") {
            void (async () => {
                try {
                    await refreshCache.mutateAsync("system.host");
                } catch {
                    // Best-effort refresh after a host update.
                }
            })();
        }
    }, [execJob.data, refreshCache, runningActionId, runningActionLabel]);

    /** Performs confirm run. */
    async function confirmRun() {
        if (!pendingAction) {
            return;
        }

        const actionToRun = pendingAction;
        setPendingAction(undefined);
        setRunningActionId(actionToRun.id);
        setRunningActionLabel(actionToRun.label);

        try {
            const started = await startAction.mutateAsync(actionToRun);
            setRunningJobId(started.jobId);
        } catch {
            setRunningActionId(undefined);
            setRunningActionLabel(undefined);
            setRunningJobId(undefined);
        }
    }

    const liveLogs = execJob.data
        ? [execJob.data.stdout, execJob.data.stderr].filter(Boolean).join("\n").trim()
        : undefined;

    const finishedLogs = result
        ? [result.response.stdout, result.response.stderr]
              .filter(Boolean)
              .join("\n")
              .trim()
        : "";

    const logs = liveLogs ?? finishedLogs;

    const outputMeta = execJob.data
        ? {
              action: runningActionLabel || "Running action",
              ranAt: execJob.data.startedAt,
              code: execJob.data.status === "done" ? execJob.data.code : undefined,
              running: execJob.data.status === "running",
          }
        : result
          ? {
                action: result.action,
                ranAt: result.ranAt,
                code: result.response.code,
                running: false,
            }
          : undefined;

    const isAnyActionPending = startAction.isPending || Boolean(runningActionId);

    useEffect(() => {
        if (!shouldAutoFollowOutput || !outputReference.current) {
            return;
        }

        outputReference.current.scrollTop = outputReference.current.scrollHeight;
    }, [logs, shouldAutoFollowOutput]);

    useEffect(() => {
        if (runningActionId) {
            setShouldAutoFollowOutput(true);
        }
    }, [runningActionId]);

    return (
        <>
            <Card>
                <div className="mb-3 flex items-center justify-between gap-2">
                    <h3 className="text-primary-300 text-sm font-semibold tracking-wide uppercase">
                        Actions
                    </h3>
                </div>

                {versionInfo?.updateAvailable ? (
                    <div className="border-primary-700 bg-primary-900/30 mb-3 rounded border px-3 py-2 text-xs text-amber-200">
                        <div className="flex items-center gap-2">
                            <AlertTriangle className="h-3.5 w-3.5" />
                            New OpenClaw version available ({versionInfo.current} →{" "}
                            {versionInfo.latest}).
                        </div>
                    </div>
                ) : undefined}

                <div className="grid grid-cols-1 gap-3">
                    {(["system", "openclaw"] as const).map((scope) => (
                        <div
                            key={scope}
                            className="border-primary-700 bg-primary-900/30 rounded-lg border p-3"
                        >
                            <div className="text-primary-300 mb-2 text-xs font-semibold tracking-wide uppercase">
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
                                        className="border-primary-700 bg-primary-800/40 hover:border-primary-500 flex h-full flex-col rounded-lg border p-3 text-left transition disabled:cursor-not-allowed disabled:opacity-60"
                                        onClick={() => setPendingAction(action)}
                                        disabled={isAnyActionPending}
                                    >
                                        <div className="mb-1 flex items-center justify-between gap-2">
                                            <span className="text-primary-100 text-sm">
                                                {action.label}
                                            </span>
                                            {action.danger ? (
                                                <Badge variant="error">Caution</Badge>
                                            ) : undefined}
                                        </div>
                                        <div className="text-primary-400 min-h-[2.5rem] text-xs">
                                            {action.description}
                                        </div>
                                        {runningActionId === action.id ? (
                                            <div className="text-primary-300 mt-auto inline-flex items-center gap-1 pt-2 text-xs">
                                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                                Running...
                                            </div>
                                        ) : (
                                            <div className="text-primary-300 mt-auto inline-flex items-center gap-1 pt-2 text-xs">
                                                <Play className="h-3.5 w-3.5" />
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
                    <div className="border-primary-700 bg-primary-900/60 mt-4 rounded-lg border p-3">
                        <div className="text-primary-400 mb-2 text-xs">
                            {outputMeta.running ? "Running" : "Last run"}:{" "}
                            {outputMeta.action} · {formatDate(new Date(outputMeta.ranAt))}
                            {outputMeta.running
                                ? " · in progress"
                                : ` · exit code ${String(outputMeta.code)}`}
                        </div>
                        <div className="text-primary-300 mb-1 inline-flex items-center gap-1 text-xs">
                            <Terminal className="h-3.5 w-3.5" />
                            Output
                        </div>
                        <pre
                            ref={outputReference}
                            onScroll={(event) => {
                                const element = event.currentTarget;
                                const distanceFromBottom =
                                    element.scrollHeight -
                                    element.scrollTop -
                                    element.clientHeight;
                                const isAtBottom = distanceFromBottom <= 8;
                                setShouldAutoFollowOutput((previous) =>
                                    previous === isAtBottom ? previous : isAtBottom
                                );
                            }}
                            className="text-primary-200 max-h-52 overflow-auto rounded bg-black/30 p-2 text-xs whitespace-pre-wrap"
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
