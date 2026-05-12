import { Send, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
import { Input } from "../components/ui/Input";
import {
    changeDirectory,
    type CommandHistoryEntry,
    getCompletions,
    stopTerminalJob,
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
    const [isAtBottom, setIsAtBottom] = useState(true);
    const outputRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLInputElement>(null);

    const startCommand = useStartTerminalCommand();
    const { data: jobData } = useTerminalJob(currentJobId);
    const { history, addCommand, updateCommand, clearHistory } = useTerminalHistory();

    // Stop polling when component unmounts
    useEffect(() => {
        return () => {
            setCurrentJobId(null);
        };
    }, []);

    // Check if user is near bottom (within 30px)
    const checkIsAtBottom = () => {
        if (!outputRef.current) return true;
        const { scrollTop, scrollHeight, clientHeight } = outputRef.current;
        return scrollHeight - scrollTop - clientHeight < 30;
    };

    // Auto-scroll only when user is at bottom
    useEffect(() => {
        if (outputRef.current && isAtBottom) {
            outputRef.current.scrollTop = outputRef.current.scrollHeight;
        }
    }, [history, jobData?.stdout, jobData?.stderr, isAtBottom]);

    // Track scroll position
    const handleScroll = () => {
        const atBottom = checkIsAtBottom();
        setIsAtBottom((prev) => (prev === atBottom ? prev : atBottom));
    };

    // Scroll to bottom manually
    const scrollToBottom = () => {
        if (outputRef.current) {
            outputRef.current.scrollTop = outputRef.current.scrollHeight;
            setIsAtBottom(true);
        }
    };

    // Update command status when job data changes - only if actually different
    useEffect(() => {
        if (jobData && currentJobId) {
            const entry = history.find((h) => h.jobId === currentJobId);
            if (entry) {
                // Only update if data actually changed
                const hasChanged =
                    entry.status !== jobData.status ||
                    entry.stdout !== jobData.stdout ||
                    entry.stderr !== jobData.stderr ||
                    entry.code !== jobData.code;

                if (hasChanged) {
                    updateCommand(entry.id, {
                        status: jobData.status,
                        code: jobData.code,
                        stdout: jobData.stdout,
                        stderr: jobData.stderr,
                        endedAt: jobData.endedAt,
                    });
                }

                // Refocus input when job completes
                if (jobData.status === "done") {
                    setTimeout(() => inputRef.current?.focus(), 0);
                }
            }
        }
    }, [jobData, currentJobId, history, updateCommand]);

    async function handleTabCompletion() {
        if (!command.trim()) return;

        try {
            const result = await getCompletions(command, cwd);

            if (result.completions.length === 1) {
                // Single match - complete fully
                setCommand(result.completions[0].completion);
            } else if (result.completions.length > 1 && result.commonPrefix) {
                // Multiple matches - complete to common prefix
                setCommand(result.commonPrefix);
            }
            // No matches - do nothing
        } catch {
            // Ignore errors
        }
    }

    const handleSubmit = async (event: React.FormEvent) => {
        event.preventDefault();
        if (!command.trim() || startCommand.isPending) return;

        const trimmedCommand = command.trim();

        // Handle cd command with validation
        if (trimmedCommand.startsWith("cd ") || trimmedCommand === "cd") {
            const targetPath =
                trimmedCommand === "cd" ? HOME_DIR : trimmedCommand.slice(3).trim();

            try {
                const result = await changeDirectory(targetPath, cwd);

                if (result.success) {
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
                    setCwd(result.newCwd);
                } else {
                    addCommand({
                        command: trimmedCommand,
                        cwd: shortenPath(cwd),
                        jobId: null,
                        status: "done",
                        code: 1,
                        stdout: "",
                        stderr: result.error || "cd failed",
                        startedAt: Date.now(),
                        endedAt: Date.now(),
                    });
                }
            } catch {
                addCommand({
                    command: trimmedCommand,
                    cwd: shortenPath(cwd),
                    jobId: null,
                    status: "error",
                    code: 1,
                    stdout: "",
                    stderr: "Failed to change directory",
                    startedAt: Date.now(),
                    endedAt: Date.now(),
                });
            }

            setCommand("");
            setHistoryIndex(-1);
            setTimeout(() => inputRef.current?.focus(), 0);
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
            // Refocus input after pwd
            setTimeout(() => inputRef.current?.focus(), 0);
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
            // Refocus input after command starts
            setTimeout(() => inputRef.current?.focus(), 0);
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
            // Refocus input after error
            setTimeout(() => inputRef.current?.focus(), 0);
        }
    };

    const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
        // Handle Tab for completion
        if (event.key === "Tab") {
            event.preventDefault();
            void handleTabCompletion();
            return;
        }

        // Handle command history navigation
        if (event.key === "ArrowUp") {
            event.preventDefault();
            const commands = history.map((h) => h.command).reverse();
            if (commands.length > 0) {
                const newIndex = Math.min(historyIndex + 1, commands.length - 1);
                setHistoryIndex(newIndex);
                setCommand(commands[newIndex] || "");
            }
            return;
        }
        if (event.key === "ArrowDown") {
            event.preventDefault();
            const commands = history.map((h) => h.command).reverse();
            const newIndex = Math.max(historyIndex - 1, -1);
            setHistoryIndex(newIndex);
            setCommand(newIndex >= 0 ? commands[newIndex] || "" : "");
            return;
        }
    };

    return (
        <div className="flex h-full min-h-0 flex-col overflow-hidden p-3 sm:p-4 lg:p-6">
            <Card className="flex min-h-0 flex-1 flex-col overflow-hidden p-0">
                {/* Terminal Output */}
                <div
                    ref={outputRef}
                    onScroll={handleScroll}
                    className="relative min-h-0 flex-1 overflow-auto bg-black p-3 font-mono text-xs sm:p-4 sm:text-sm"
                >
                    {/* Scroll to bottom button - sticky to always show when scrolled up */}
                    {!isAtBottom && (
                        <button
                            type="button"
                            onClick={scrollToBottom}
                            className="bg-accent-500 hover:bg-accent-600 sticky top-2 z-10 float-right mb-2 rounded-full px-3 py-1 text-xs text-white shadow-lg"
                        >
                            ↓ Follow
                        </button>
                    )}
                    {history.length === 0 ? (
                        <div className="text-primary-400">
                            Welcome to Mira Dashboard Terminal.
                            <br />
                            Type a command and press Enter to execute.
                            <br />
                            Use cd to change directory, pwd to show current path.
                            <br />
                            Press Tab for path completion.
                            <br />
                            <br />
                            Use ↑/↓ arrows to navigate command history.
                        </div>
                    ) : (
                        history.map((entry) => (
                            <TerminalOutput key={entry.id} entry={entry} />
                        ))
                    )}

                    {/* Current running job output */}
                    {jobData &&
                        currentJobId &&
                        !history.some((h) => h.jobId === currentJobId) && (
                            <div className="mt-2">
                                <div className="text-primary-400">
                                    <span className="text-accent-400">
                                        {shortenPath(cwd)}
                                    </span>
                                    <span className="text-primary-500">$</span>{" "}
                                    <span className="text-primary-100 break-all">
                                        {command}
                                    </span>
                                </div>
                                {jobData.stdout && (
                                    <pre className="text-primary-100 mt-1 max-w-full break-words whitespace-pre-wrap">
                                        {jobData.stdout}
                                    </pre>
                                )}
                                {jobData.stderr && (
                                    <pre className="mt-1 max-w-full break-words whitespace-pre-wrap text-red-400">
                                        {jobData.stderr}
                                    </pre>
                                )}
                                {jobData.status === "running" && (
                                    <div className="text-accent-400 mt-1">Running...</div>
                                )}
                            </div>
                        )}
                </div>

                {/* Command Input */}
                <div className="border-primary-700 bg-primary-900 border-t p-3">
                    {/* Current directory display */}
                    <div className="text-accent-400 mb-2 flex min-w-0 items-center gap-2 font-mono text-xs sm:text-sm">
                        <span className="min-w-0 truncate">{shortenPath(cwd)}</span>
                        <span className="text-primary-500 shrink-0">$</span>
                    </div>
                    <form
                        onSubmit={handleSubmit}
                        className="flex flex-col gap-2 sm:flex-row sm:items-center"
                    >
                        <div className="min-w-0 flex-1">
                            <Input
                                ref={inputRef}
                                type="text"
                                value={command}
                                onChange={(e) => setCommand(e.target.value)}
                                onKeyDown={handleKeyDown}
                                placeholder="Enter command..."
                                className="w-full bg-black font-mono text-base sm:text-sm"
                                disabled={startCommand.isPending}
                                autoFocus
                                autoComplete="off"
                                autoCorrect="off"
                                autoCapitalize="off"
                                spellCheck="false"
                            />
                        </div>
                        <div className="grid grid-cols-2 gap-2 sm:flex sm:shrink-0">
                            {jobData?.status === "running" && currentJobId ? (
                                <Button
                                    type="button"
                                    variant="danger"
                                    className="w-full sm:w-auto"
                                    onClick={async () => {
                                        try {
                                            await stopTerminalJob(currentJobId);
                                        } catch {
                                            // Ignore errors - process might already be stopped
                                        }
                                    }}
                                >
                                    ■ Stop
                                </Button>
                            ) : (
                                <Button
                                    type="submit"
                                    className="w-full sm:w-auto"
                                    disabled={!command.trim() || startCommand.isPending}
                                >
                                    <Send size={16} />
                                    Run
                                </Button>
                            )}
                            <Button
                                variant="secondary"
                                type="button"
                                className="w-full sm:w-auto"
                                onClick={clearHistory}
                                disabled={history.length === 0}
                            >
                                <Trash2 size={16} />
                                Clear
                            </Button>
                        </div>
                    </form>
                </div>
            </Card>
        </div>
    );
}

function TerminalOutput({ entry }: { entry: CommandHistoryEntry }) {
    const isSuccess = entry.status === "done" && entry.code === 0;

    return (
        <div className={cn("mb-4", entry.status === "running" && "opacity-80")}>
            {/* Command line */}
            <div className="text-primary-400 flex flex-wrap items-start gap-x-2 gap-y-1">
                <span className="text-accent-400 shrink-0">{entry.cwd}$</span>
                <span className="text-primary-100 min-w-0 break-all">
                    {entry.command}
                </span>
                {entry.status === "running" && (
                    <span className="text-accent-400 animate-pulse">●</span>
                )}
            </div>

            {/* stdout */}
            {entry.stdout && (
                <pre className="text-primary-100 mt-1 max-w-full break-words whitespace-pre-wrap">
                    {entry.stdout}
                </pre>
            )}

            {/* stderr */}
            {entry.stderr && (
                <pre className="mt-1 max-w-full break-words whitespace-pre-wrap text-red-400">
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
                        <span className="text-primary-600 ml-0 block sm:ml-2 sm:inline">
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
