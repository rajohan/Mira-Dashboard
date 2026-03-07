import { Send, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
import { Input } from "../components/ui/Input";
import {
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

        // Handle cd command locally
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
        <div className="flex h-full flex-col p-4">
            <Card className="flex flex-1 flex-col overflow-hidden">
                {/* Terminal Output */}
                <div
                    ref={outputRef}
                    onScroll={handleScroll}
                    className="relative flex-1 overflow-auto bg-black p-4 font-mono text-sm"
                >
                    {/* Scroll to bottom button - sticky to always show when scrolled up */}
                    {!isAtBottom && (
                        <button
                            type="button"
                            onClick={scrollToBottom}
                            className="sticky top-2 z-10 float-right mb-2 rounded-full bg-accent-500 px-3 py-1 text-xs text-white shadow-lg hover:bg-accent-600"
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
                                    <span className="text-primary-500">$</span> {command}
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
                <div className="border-t border-primary-700 bg-primary-900 p-3">
                    {/* Current directory display */}
                    <div className="mb-2 flex items-center gap-2 font-mono text-sm text-accent-400">
                        <span>{shortenPath(cwd)}</span>
                        <span className="text-primary-500">$</span>
                    </div>
                    <form onSubmit={handleSubmit} className="flex items-center gap-2">
                        <div className="flex-1">
                            <Input
                                ref={inputRef}
                                type="text"
                                value={command}
                                onChange={(e) => setCommand(e.target.value)}
                                onKeyDown={handleKeyDown}
                                placeholder="Enter command..."
                                className="w-full bg-black font-mono"
                                disabled={startCommand.isPending}
                                autoFocus
                                autoComplete="off"
                                autoCorrect="off"
                                autoCapitalize="off"
                                spellCheck="false"
                            />
                        </div>
                        {jobData?.status === "running" && currentJobId ? (
                            <Button
                                type="button"
                                variant="danger"
                                onClick={() => stopTerminalJob(currentJobId)}
                            >
                                ■ Stop
                            </Button>
                        ) : (
                            <Button
                                type="submit"
                                disabled={!command.trim() || startCommand.isPending}
                            >
                                <Send size={16} />
                                Run
                            </Button>
                        )}
                        <Button
                            variant="secondary"
                            type="button"
                            onClick={clearHistory}
                            disabled={history.length === 0}
                        >
                            <Trash2 size={16} />
                            Clear
                        </Button>
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
