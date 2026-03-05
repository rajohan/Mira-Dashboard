import { AlertTriangle, Loader2, Play, Terminal } from "lucide-react";
import { useState } from "react";

import { OPS_ACTIONS, useOpenClawVersion, useRunOpsAction } from "../../../hooks";
import type { ExecResponse, OpsActionDefinition } from "../../../hooks";
import { formatDate } from "../../../utils/format";
import { Badge } from "../../ui/Badge";
import { Card } from "../../ui/Card";
import { ConfirmModal } from "../../ui/ConfirmModal";

export function ServiceActionsCard() {
    const runAction = useRunOpsAction();
    const { data: versionInfo } = useOpenClawVersion();
    const [pendingAction, setPendingAction] = useState<OpsActionDefinition | null>(null);
    const [runningActionId, setRunningActionId] = useState<string | null>(null);
    const [result, setResult] = useState<{
        action: string;
        response: ExecResponse;
        ranAt: number;
    } | null>(null);

    async function confirmRun() {
        if (!pendingAction) {
            return;
        }

        const actionToRun = pendingAction;
        setPendingAction(null);
        setRunningActionId(actionToRun.id);

        try {
            const response = await runAction.mutateAsync(actionToRun);
            setResult({
                action: actionToRun.label,
                response,
                ranAt: Date.now(),
            });
        } finally {
            setRunningActionId(null);
        }
    }

    const logs = result
        ? [result.response.stdout, result.response.stderr]
              .filter(Boolean)
              .join("\n")
              .trim()
        : "";

    return (
        <>
            <Card>
                <div className="mb-3 flex items-center justify-between gap-2">
                    <h3 className="text-sm font-semibold uppercase tracking-wide text-primary-300">
                        Actions
                    </h3>
                </div>

                {versionInfo?.updateAvailable && (
                    <div className="mb-3 flex items-center gap-2 rounded border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
                        <AlertTriangle className="h-3.5 w-3.5" />
                        New OpenClaw version available ({versionInfo.current} → {versionInfo.latest}).
                    </div>
                )}

                <div className="grid grid-cols-1 gap-3">
                    {(["system", "openclaw"] as const).map((scope) => (
                        <div key={scope} className="rounded-lg border border-primary-700 bg-primary-900/30 p-3">
                            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-primary-300">
                                {scope === "system" ? "System Actions" : "OpenClaw Actions"}
                            </div>

                            <div className="grid grid-cols-1 gap-2 lg:grid-cols-3">
                                {OPS_ACTIONS.filter((action) => action.scope === scope).map((action) => (
                                    <button
                                        key={action.id}
                                        type="button"
                                        className="rounded-lg border border-primary-700 bg-primary-800/40 p-3 text-left transition hover:border-primary-500"
                                        onClick={() => setPendingAction(action)}
                                        disabled={runAction.isPending}
                                    >
                                        <div className="mb-1 flex items-center justify-between gap-2">
                                            <span className="text-sm text-primary-100">{action.label}</span>
                                            {action.danger ? <Badge variant="error">Sensitive</Badge> : null}
                                        </div>
                                        <div className="text-xs text-primary-400">{action.description}</div>
                                        {runAction.isPending && runningActionId === action.id ? (
                                            <div className="mt-2 inline-flex items-center gap-1 text-xs text-primary-300">
                                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                                Running...
                                            </div>
                                        ) : (
                                            <div className="mt-2 inline-flex items-center gap-1 text-xs text-primary-300">
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

                {result && (
                    <div className="mt-4 rounded-lg border border-primary-700 bg-primary-900/60 p-3">
                        <div className="mb-2 text-xs text-primary-400">
                            Last run: {result.action} · {formatDate(new Date(result.ranAt))} · exit code {String(result.response.code)}
                        </div>
                        <div className="mb-1 inline-flex items-center gap-1 text-xs text-primary-300">
                            <Terminal className="h-3.5 w-3.5" />
                            Output
                        </div>
                        <pre className="max-h-52 overflow-auto whitespace-pre-wrap rounded bg-black/30 p-2 text-xs text-primary-200">
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
                    if (!runAction.isPending) {
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
