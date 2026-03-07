import { Send, Terminal as TerminalIcon, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
import { Input } from "../components/ui/Input";
import {
    type CommandHistoryEntry,
    useStartTerminalCommand,
    useTerminalHistory,
    useTerminalJob,
} from "../hooks/useTerminal";
import { cn } from "../utils/cn";

const HOME_DIR = "/home/ubuntu";

function shortenPath(path: string): string {
    if (path === HOME_DIR) return "~";
    if (path.startsWith(HOME_DIR + "/")) return "~" + path.slice(HOME_DIR.length);
    return path;
}

export function Terminal() {
    const [command, setCommand] = useState("");
    const [historyIndex, setHistoryIndex] = useState(-1);
    const [currentJobId, setCurrentJobId] = useState<string | null>(null);
    const [cwd, setCwd] = useState(HOME_DIR);
    const outputRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLInputElement>(null);

    const startCommand = useStartTerminalCommand();
    const { data: jobData } = useTerminalJob(currentJobId);
    const { history, addCommand, updateCommand, clearHistory } = useTerminalHistory();

    // Auto-scroll to bottom when output changes
    useEffect(() => {
        if (outputRef.current) {
            outputRef.current.scrollTop = outputRef.current.scrollHeight;
        }
    }, [history, jobData?.stdout, jobData?.stderr]);

    // Update command status when job data changes
    useEffect(() => {
        if (jobData && currentJobId) {
            const entry = history.find((h) => h.jobId === currentJobId);
            if (entry) {
                updateCommand(entry.id, {
                    status: jobData.status,
                    code: jobData.code,
                    stdout: jobData.stdout,
                    stderr: jobData.stderr,
                    endedAt: jobData.endedAt,
                });

                // Update cwd if cd command was successful
                if (entry.command.startsWith("cd ") && jobData.code === 0) {
                    const newPath = entry.command.slice(3).trim();
                    const resolvedPath = resolvePath(newPath, entry.cwd);
                    setCwd(resolvedPath);
                }
            }
        }
    }, [jobData, currentJobId, history, updateCommand]);

    function resolvePath(path: string, currentDir: string): string {
        if (path.startsWith("/")) return path;
        if (path.startsWith("~/")) return HOME_DIR + path.slice(1);
        if (path === "~") return HOME_DIR;

        const parts = path.split("/").filter(Boolean);
        const currentParts = currentDir.split("/").filter(Boolean);

        for (const part of parts) {
            if (part === "..") {
                currentParts.pop();
            } else if (part !== ".") {
                currentParts.push(part);
            }
        }

        return "/" + currentParts.join("/");
    }

    const handleSubmit = async (event: React.FormEvent) => {
        event.preventDefault();
        if (!command.trim() || startCommand.isPending) return;

        const trimmedCommand = command.trim();

        // Handle cd command locally (no need to execute via backend)
        if (trimmedCommand.startsWith("cd ") || trimmedCommand === "cd") {
            const newPath =
                trimmedCommand === "cd" ? HOME_DIR : trimmedCommand.slice(3).trim();
            const resolvedPath = resolvePath(newPath, cwd);

            addCommand({
                command: trimmedCommand,
                cwd: shortenPath(cwd),
                jobId: null,
                status: "done",
                code: 0,
                stdout: "",
                stderr: "",
                startedAt: Date.now(),
                endedAt: Date.now(),
            });

            setCwd(resolvedPath);
            setCommand("");
            setHistoryIndex(-1);
            return;
        }

        // Handle pwd command locally
        if (trimmedCommand === "pwd") {
            addCommand({
                command: trimmedCommand,
                cwd: shortenPath(cwd),
                jobId: null,
                status: "done",
                code: 0,
                stdout: cwd,
                stderr: "",
                startedAt: Date.now(),
                endedAt: Date.now(),
            });
            setCommand("");
            setHistoryIndex(-1);
            return;
        }

        try {
            const entryId = addCommand({
                command: trimmedCommand,
                cwd: shortenPath(cwd),
                jobId: null,
                status: "pending",
                code: null,
                stdout: "",
                stderr: "",
                startedAt: Date.now(),
                endedAt: null,
            });

            setCommand("");
            setHistoryIndex(-1);

            const result = await startCommand.mutateAsync({
                command: trimmedCommand,
                cwd,
            });

            setCurrentJobId(result.jobId);
            updateCommand(entryId, {
                jobId: result.jobId,
                status: "running",
            });
        } catch {
            const entryId = addCommand({
                command: trimmedCommand,
                cwd: shortenPath(cwd),
                jobId: null,
                status: "error",
                code: 1,
                stdout: "",
                stderr: "Failed to start command",
                startedAt: Date.now(),
                endedAt: Date.now(),
            });
            updateCommand(entryId, { status: "error" });
        }
    };

    const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
        if (event.key === "ArrowUp") {
            event.preventDefault();
            const commands = history.map((h) => h.command).reverse();
            if (commands.length > 0) {
                const newIndex = Math.min(historyIndex + 1, commands.length - 1);
                setHistoryIndex(newIndex);
                setCommand(commands[newIndex] || "");
            }
        } else if (event.key === "ArrowDown") {
            event.preventDefault();
            const commands = history.map((h) => h.command).reverse();
            const newIndex = Math.max(historyIndex - 1, -1);
            setHistoryIndex(newIndex);
            setCommand(newIndex >= 0 ? commands[newIndex] || "" : "");
        }
    };

    const promptPrefix = `${shortenPath(cwd)}$`;

    return (
        <div className="flex h-full flex-col gap-4 p-4">
            <div className="flex items-center justify-between">
                <h2 className="flex items-center gap-2 text-xl font-semibold">
                    <TerminalIcon size={24} />
                    Terminal
                </h2>
                <Button
                    variant="secondary"
                    size="sm"
                    onClick={clearHistory}
                    disabled={history.length === 0}
                >
                    <Trash2 size={16} />
                    Clear
                </Button>
            </div>

            <Card className="flex flex-1 flex-col overflow-hidden">
                {/* Terminal Output */}
                <div
                    ref={outputRef}
                    className="flex-1 overflow-auto bg-black p-4 font-mono text-sm"
                >
                    {history.length === 0 ? (
                        <div className="text-primary-400">
                            Welcome to Mira Dashboard Terminal.
                            <br />
                            Type a command and press Enter to execute.
                            <br />
                            Use cd to change directory, pwd to show current path.
                            <br />
                            <br />
                            Use ↑/↓ arrows to navigate command history.
                        </div>
                    ) : (
                        history.map((entry) => (
                            <TerminalOutput key={entry.id} entry={entry} />
                        ))
                    )}

                    {/* Current running job output (if not yet in history) */}
                    {jobData &&
                        currentJobId &&
                        !history.some((h) => h.jobId === currentJobId) && (
                            <div className="mt-2">
                                <div className="text-primary-400">
                                    <span className="text-accent-400">
                                        {promptPrefix}
                                    </span>{" "}
                                    {command}
                                </div>
                                {jobData.stdout && (
                                    <pre className="mt-1 whitespace-pre-wrap text-primary-100">
                                        {jobData.stdout}
                                    </pre>
                                )}
                                {jobData.stderr && (
                                    <pre className="mt-1 whitespace-pre-wrap text-red-400">
                                        {jobData.stderr}
                                    </pre>
                                )}
                                {jobData.status === "running" && (
                                    <div className="mt-1 text-accent-400">Running...</div>
                                )}
                            </div>
                        )}
                </div>

                {/* Command Input */}
                <form
                    onSubmit={handleSubmit}
                    className="flex items-center gap-2 border-t border-primary-700 bg-primary-900 p-3"
                >
                    <span className="flex-shrink-0 font-mono text-accent-400">
                        {promptPrefix}
                    </span>
                    <Input
                        ref={inputRef}
                        type="text"
                        value={command}
                        onChange={(e) => setCommand(e.target.value)}
                        onKeyDown={handleKeyDown}
                        placeholder="Enter command..."
                        className="flex-1 bg-black font-mono"
                        disabled={startCommand.isPending}
                        autoFocus
                    />
                    <Button
                        type="submit"
                        disabled={!command.trim() || startCommand.isPending}
                    >
                        <Send size={16} />
                        Run
                    </Button>
                </form>
            </Card>
        </div>
    );
}

function TerminalOutput({ entry }: { entry: CommandHistoryEntry }) {
    const isSuccess = entry.status === "done" && entry.code === 0;

    return (
        <div className={cn("mb-4", entry.status === "running" && "opacity-80")}>
            {/* Command line */}
            <div className="flex items-center gap-2 text-primary-400">
                <span className="text-accent-400">{entry.cwd}$</span>
                <span>{entry.command}</span>
                {entry.status === "running" && (
                    <span className="animate-pulse text-accent-400">●</span>
                )}
            </div>

            {/* stdout */}
            {entry.stdout && (
                <pre className="mt-1 whitespace-pre-wrap text-primary-100">
                    {entry.stdout}
                </pre>
            )}

            {/* stderr */}
            {entry.stderr && (
                <pre className="mt-1 whitespace-pre-wrap text-red-400">
                    {entry.stderr}
                </pre>
            )}

            {/* Exit code */}
            {entry.status === "done" && (
                <div
                    className={cn(
                        "mt-1 text-xs",
                        isSuccess ? "text-green-400" : "text-red-400"
                    )}
                >
                    Exit code: {entry.code ?? "unknown"}
                    {entry.endedAt && (
                        <span className="ml-2 text-primary-600">
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

export default Terminal;
