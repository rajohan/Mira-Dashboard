import type { CommandHistoryEntry } from "../../../hooks/useTerminal";
import { cn } from "../../../utils/cn";

/**
 * Renders one completed or active terminal history entry.
 * @param properties Terminal history entry.
 * @returns Rendered terminal output.
 */
export function TerminalOutput({ entry }: { entry: CommandHistoryEntry }) {
    const isSuccess = entry.status === "done" && entry.code === 0;

    return (
        <div
            className={cn(
                "mb-4",
                (entry.status === "running" || entry.status === "signaled") &&
                    "opacity-80"
            )}
        >
            <div className="flex flex-wrap items-start gap-x-2 gap-y-1 text-primary-400">
                <span className="shrink-0 text-accent-400">{entry.cwd}$</span>
                <span className="min-w-0 break-all text-primary-100">
                    {entry.command}
                </span>
                {(entry.status === "running" || entry.status === "signaled") && (
                    <span className="animate-pulse text-accent-400">
                        {entry.status === "signaled" ? "Stopping…" : "●"}
                    </span>
                )}
            </div>

            {entry.stdout && (
                <pre className="mt-1 max-w-full wrap-break-word whitespace-pre-wrap text-primary-100">
                    {entry.stdout}
                </pre>
            )}

            {entry.stderr && (
                <pre className="mt-1 max-w-full wrap-break-word whitespace-pre-wrap text-red-400">
                    {entry.stderr}
                </pre>
            )}

            {entry.status === "done" && (
                <div
                    className={cn(
                        "mt-1 text-xs",
                        isSuccess ? "text-green-400" : "text-red-400"
                    )}
                >
                    Exit code: {entry.code ?? "unknown"}
                    {entry.endedAt && (
                        <span className="ml-0 block text-primary-600 sm:ml-2 sm:inline">
                            ({((entry.endedAt - entry.startedAt) / 1000).toFixed(2)}s)
                        </span>
                    )}
                </div>
            )}

            {entry.status === "error" && (
                <div className="mt-1 text-xs text-red-400">Command failed to start</div>
            )}
        </div>
    );
}
