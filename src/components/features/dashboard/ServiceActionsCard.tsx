import { AlertTriangle, Loader2, Play, Terminal } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type { ExecResponse, OpsActionDefinition } from "../../../hooks";
import {
    OPS_ACTIONS,
    useExecJob,
    useOpenClawVersion,
    useRefreshOpenClawVersion,
    useStartOpsAction,
} from "../../../hooks";
import { formatDate } from "../../../utils/format";
import { Badge } from "../../ui/Badge";
import { Card } from "../../ui/Card";
import { ConfirmModal } from "../../ui/ConfirmModal";

export function ServiceActionsCard() {
    const startAction = useStartOpsAction();
    const refreshOpenClawVersion = useRefreshOpenClawVersion();
    const { data: versionInfo } = useOpenClawVersion();

    const [pendingAction, setPendingAction] = useState<OpsActionDefinition | null>(null);
    const [runningActionId, setRunningActionId] = useState<string | null>(null);
    const [runningActionLabel, setRunningActionLabel] = useState<string | null>(null);
    const [runningJobId, setRunningJobId] = useState<string | null>(null);
    const [result, setResult] = useState<{
        action: string;
        response: ExecResponse;
        ranAt: number;
    } | null>(null);
    const outputRef = useRef<HTMLPreElement | null>(null);
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

        setRunningActionId(null);
        setRunningActionLabel(null);
        setRunningJobId(null);

        if (completedActionId === "openclaw_update") {
            void refreshOpenClawVersion.mutateAsync().catch(() => undefined);
        }
    }, [execJob.data, refreshOpenClawVersion, runningActionId, runningActionLabel]);

    async function confirmRun() {
        if (!pendingAction) {
            return;
        }

        const actionToRun = pendingAction;
        setPendingAction(null);
        setRunningActionId(actionToRun.id);
        setRunningActionLabel(actionToRun.label);

        try {
            const started = await startAction.mutateAsync(actionToRun);
            setRunningJobId(started.jobId);
        } catch {
            setRunningActionId(null);
            setRunningActionLabel(null);
            setRunningJobId(null);
        }
    }

    const liveLogs = execJob.data
        ? [execJob.data.stdout, execJob.data.stderr].filter(Boolean).join("\n").trim()
        : null;

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
              code: execJob.data.status === "done" ? execJob.data.code : null,
              running: execJob.data.status === "running",
          }
        : result
          ? {
                action: result.action,
                ranAt: result.ranAt,
                code: result.response.code,
                running: false,
            }
          : null;

    const isAnyActionPending = startAction.isPending || Boolean(runningActionId);

    useEffect(() => {
        if (!shouldAutoFollowOutput || !outputRef.current) {
            return;
        }

        outputRef.current.scrollTop = outputRef.current.scrollHeight;
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
                    <h3 className="text-sm font-semibold uppercase tracking-wide text-primary-300">
                        Actions
                    </h3>
                </div>

                {versionInfo?.updateAvailable ? (
                    <div className="mb-3 rounded border border-primary-700 bg-primary-900/30 px-3 py-2 text-xs text-amber-200">
                        <div className="flex items-center gap-2">
                            <AlertTriangle className="h-3.5 w-3.5" />
                            New OpenClaw version available ({versionInfo.current} → {versionInfo.latest}).
                        </div>
                    </div>
                ) : null}

                <div className="grid grid-cols-1 gap-3">
                    {(["system", "openclaw"] as const).map((scope) => (
                        <div
                            key={scope}
                            className="rounded-lg border border-primary-700 bg-primary-900/30 p-3"
                        >
                            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-primary-300">
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
                                            ) : null}
                                        </div>
                                        <div className="min-h-[2.5rem] text-xs text-primary-400">
                                            {action.description}
                                        </div>
                                        {runningActionId === action.id ? (
                                            <div className="mt-auto inline-flex items-center gap-1 pt-2 text-xs text-primary-300">
                                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                                Running...
                                            </div>
                                        ) : (
                                            <div className="mt-auto inline-flex items-center gap-1 pt-2 text-xs text-primary-300">
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
                    <div className="mt-4 rounded-lg border border-primary-700 bg-primary-900/60 p-3">
                        <div className="mb-2 text-xs text-primary-400">
                            {outputMeta.running ? "Running" : "Last run"}:{" "}
                            {outputMeta.action} · {formatDate(new Date(outputMeta.ranAt))}
                            {outputMeta.running
                                ? " · in progress"
                                : ` · exit code ${String(outputMeta.code)}`}
                        </div>
                        <div className="mb-1 inline-flex items-center gap-1 text-xs text-primary-300">
                            <Terminal className="h-3.5 w-3.5" />
                            Output
                        </div>
                        <pre
                            ref={outputRef}
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
                            className="max-h-52 overflow-auto whitespace-pre-wrap rounded bg-black/30 p-2 text-xs text-primary-200"
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
                        setPendingAction(null);
                    }
                }}
                onConfirm={() => {
                    void confirmRun();
                }}
            />
        </>
    );
}
