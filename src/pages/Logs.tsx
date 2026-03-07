import { Download, FileText } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { LevelFilter, LogLine } from "../components/features/logs";
import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
import { Checkbox } from "../components/ui/Checkbox";
import { Input } from "../components/ui/Input";
import { RefreshButton } from "../components/ui/RefreshButton";
import { Select } from "../components/ui/Select";
import { useLogContent, useLogFiles } from "../hooks";
import type { LogEntry } from "../types/log";
import { formatDateStamp } from "../utils/format";
import { LINE_OPTIONS, LOG_LEVELS, parseLogLine } from "../utils/logUtils";

export function Logs() {
    const [autoFollow, setAutoFollow] = useState(true);
    const [selectedFile, setSelectedFile] = useState<string | null>(null);
    const [lineCount, setLineCount] = useState<number>(100);
    const [levelFilter, setLevelFilter] = useState<Set<string>>(
        new Set(["trace", "debug", "info", "warn", "error", "fatal"])
    );
    const [search, setSearch] = useState("");
    const [logs, setLogs] = useState<LogEntry[]>([]);
    const [isLoading, setIsLoading] = useState(false);

    const logContainerRef = useRef<HTMLDivElement>(null);
    const requestSeqRef = useRef(0);

    const { data: logFiles = [] } = useLogFiles();
    const { refetch: refetchContent } = useLogContent(
        selectedFile || null,
        lineCount,
        false
    );

    useEffect(() => {
        if (logFiles.length > 0 && !selectedFile) {
            const sorted = [...logFiles].sort((a, b) => b.name.localeCompare(a.name));
            const today = formatDateStamp();
            const todayFile = sorted.find((f) => f.name.includes(today));
            setSelectedFile(todayFile?.name || sorted[0]?.name || "");
        }
    }, [logFiles, selectedFile]);

    const scrollToBottomExact = () => {
        const el = logContainerRef.current;
        if (!el) return;

        const doScroll = () => {
            el.scrollTop = el.scrollHeight;
        };

        requestAnimationFrame(() => {
            doScroll();
            requestAnimationFrame(() => {
                doScroll();
                setTimeout(doScroll, 60);
            });
        });
    };

    const loadLogContent = async () => {
        if (!selectedFile) return;
        const seq = ++requestSeqRef.current;
        setIsLoading(true);
        try {
            const result = await refetchContent();
            if (seq !== requestSeqRef.current) return;

            const content = result.data || "";
            const lines = content.split("\n").filter((l) => l.trim());
            const parsed = lines
                .map((line, i) => parseLogLine(line, i))
                .filter((entry): entry is LogEntry => entry !== null);

            setLogs(parsed);
        } finally {
            if (seq === requestSeqRef.current) {
                setIsLoading(false);
            }
        }
    };

    useEffect(() => {
        if (selectedFile && logFiles.length > 0) {
            void loadLogContent();
        }
    }, [selectedFile, lineCount, logFiles.length]);

    useEffect(() => {
        if (autoFollow && logs.length > 0) {
            scrollToBottomExact();
        }
    }, [autoFollow, logs.length, selectedFile, lineCount]);

    const handleScroll = () => {
        const el = logContainerRef.current;
        if (!el) return;
        const isAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 30;
        if (isAtBottom && !autoFollow) setAutoFollow(true);
        else if (!isAtBottom && autoFollow) setAutoFollow(false);
    };

    const filteredLogs = logs.filter((log) => {
        if (log.level && !levelFilter.has(log.level.toLowerCase())) return false;
        if (search && !log.raw.toLowerCase().includes(search.toLowerCase())) return false;
        return true;
    });

    const toggleLevel = (level: string) => {
        const next = new Set(levelFilter);
        if (next.has(level)) next.delete(level);
        else next.add(level);
        setLevelFilter(next);
    };

    const handleExport = () => {
        const content = filteredLogs.map((l) => l.raw).join("\n");
        const blob = new Blob([content], { type: "text/plain" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `${selectedFile || "logs"}-${formatDateStamp()}.txt`;
        a.click();
        URL.revokeObjectURL(url);
    };

    const clearLogs = () => {
        setLogs([]);
    };

    const sortedLogFiles = [...logFiles].sort((a, b) => b.name.localeCompare(a.name));

    return (
        <div className="flex h-full min-h-0 flex-col p-6">
            <div className="mb-4 flex flex-wrap items-center gap-3">
                <Select
                    value={selectedFile || ""}
                    onChange={(v) => setSelectedFile(v || null)}
                    options={sortedLogFiles.map((f) => ({
                        value: f.name,
                        label: f.name,
                    }))}
                    placeholder="Select file..."
                    icon={<FileText className="h-4 w-4" />}
                    width="min-w-[220px]"
                />

                <Select
                    value={lineCount.toString()}
                    onChange={(v) => setLineCount(Number.parseInt(v, 10))}
                    options={LINE_OPTIONS.map((n) => ({
                        value: n.toString(),
                        label: `${n} lines`,
                    }))}
                    width="min-w-[100px]"
                />

                <Input
                    placeholder="Search logs..."
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    className="min-w-[200px] max-w-md"
                />

                <LevelFilter
                    levels={LOG_LEVELS}
                    activeLevels={levelFilter}
                    onToggle={toggleLevel}
                />
            </div>

            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                <div className="text-sm text-primary-400">
                    {isLoading
                        ? "Loading..."
                        : `${filteredLogs.length} of ${logs.length} entries`}
                </div>

                <div className="flex items-center gap-3">
                    <Checkbox
                        checked={autoFollow}
                        onChange={setAutoFollow}
                        label="Auto-follow"
                    />

                    <div className="flex items-center gap-2">
                        <RefreshButton
                            onClick={() => void loadLogContent()}
                            isLoading={isLoading}
                        />
                        <Button
                            variant="secondary"
                            size="sm"
                            onClick={handleExport}
                            disabled={filteredLogs.length === 0}
                        >
                            <Download className="mr-1 h-4 w-4" />
                            Export
                        </Button>
                        <Button
                            variant="secondary"
                            size="sm"
                            onClick={clearLogs}
                            disabled={logs.length === 0}
                        >
                            Clear
                        </Button>
                    </div>
                </div>
            </div>

            <Card className="flex-1 overflow-hidden" variant="bordered">
                <div
                    ref={logContainerRef}
                    onScroll={handleScroll}
                    className="relative h-full overflow-y-auto bg-primary-900/50 font-mono text-xs"
                >
                    {!autoFollow && filteredLogs.length > 0 && (
                        <button
                            type="button"
                            onClick={() => {
                                setAutoFollow(true);
                                scrollToBottomExact();
                            }}
                            className="sticky top-2 z-10 float-right mb-2 mr-2 rounded-full bg-accent-500 px-3 py-1 text-xs text-white shadow-lg hover:bg-accent-600"
                        >
                            ↓ Follow
                        </button>
                    )}

                    {filteredLogs.length === 0 ? (
                        <div className="py-8 text-center text-primary-400">
                            {logs.length === 0
                                ? "Waiting for logs..."
                                : "No logs match your filter."}
                        </div>
                    ) : (
                        <div className="space-y-0">
                            {filteredLogs.map((log) => (
                                <LogLine key={log.id} log={log} />
                            ))}
                        </div>
                    )}
                </div>
            </Card>
        </div>
    );
}

export default Logs;
