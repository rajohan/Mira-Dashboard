import { ExternalLink, X } from "lucide-react";
import { useState } from "react";

import type { ColumnId, Task } from "../../../types/task";
import { formatDate, formatDuration } from "../../../utils/format";
import { getColumnId, getPriority, PRIORITY_COLORS } from "../../../utils/taskUtils";
import { Button } from "../../ui/Button";
import { Modal } from "../../ui/Modal";

interface TaskDetailModalProps {
    task: Task | null;
    onClose: () => void;
    onMove: (column: ColumnId) => Promise<void>;
}

export function TaskDetailModal({ task, onClose, onMove }: TaskDetailModalProps) {
    const [isMoving, setIsMoving] = useState(false);

    if (!task) return null;

    const priority = getPriority(task.labels);
    const assignee = task.assignees[0];
    const currentColumn = getColumnId(task);

    const handleMove = async (column: ColumnId) => {
        setIsMoving(true);
        await onMove(column);
        setIsMoving(false);
    };

    return (
        <Modal isOpen={!!task} onClose={onClose} size="2xl">
            <div className="space-y-4">
                {/* Header */}
                <div className="flex items-start justify-between">
                    <div className="flex-1">
                        <div className="mb-2 flex flex-wrap items-center gap-2">
                            <span
                                className={
                                    "rounded-full border px-2 py-0.5 text-xs font-medium " +
                                    (task.state === "CLOSED"
                                        ? "border-green-500/30 bg-green-500/20 text-green-400"
                                        : "border-blue-500/30 bg-blue-500/20 text-blue-400")
                                }
                            >
                                {task.state === "CLOSED"
                                    ? "DONE"
                                    : currentColumn.toUpperCase()}
                            </span>
                            <span
                                className={
                                    "rounded-full border px-2 py-0.5 text-xs font-medium " +
                                    PRIORITY_COLORS[priority]
                                }
                            >
                                {priority.toUpperCase()}
                            </span>
                            {task.labels
                                .filter(
                                    (l: { name: string }) =>
                                        !l.name.startsWith("priority-") &&
                                        l.name !== "blocked" &&
                                        l.name !== "in-progress"
                                )
                                .map((label: { name: string; color?: string }) => (
                                    <span
                                        key={label.name}
                                        className="rounded-full bg-slate-700 px-2 py-0.5 text-xs text-slate-300"
                                    >
                                        {label.name}
                                    </span>
                                ))}
                        </div>
                        <h2 className="text-lg font-semibold text-slate-100">
                            #{task.number}: {task.title}
                        </h2>
                    </div>
                    <Button
                        variant="ghost"
                        size="sm"
                        onClick={onClose}
                        className="text-slate-400 hover:text-slate-200"
                    >
                        <X className="h-5 w-5" />
                    </Button>
                </div>

                {/* Metadata */}
                <div className="flex flex-wrap items-center gap-4 text-sm text-slate-400">
                    {assignee && (
                        <div className="flex items-center gap-2">
                            {assignee.avatar_url ? (
                                <img
                                    src={assignee.avatar_url}
                                    alt={assignee.login || "Avatar"}
                                    className="h-5 w-5 rounded-full"
                                />
                            ) : (
                                <div className="flex h-5 w-5 items-center justify-center rounded-full bg-slate-700 text-xs text-slate-300">
                                    {(assignee.login ||
                                        assignee.name ||
                                        "?")[0].toUpperCase()}
                                </div>
                            )}
                            <span>@{assignee.login || assignee.name}</span>
                        </div>
                    )}
                    <span>Created {formatDate(task.createdAt)}</span>
                    <span>
                        Updated {formatDuration(new Date(task.updatedAt).getTime())}
                    </span>
                </div>

                {/* Body */}
                {task.body && (
                    <div className="rounded-lg border border-slate-700 bg-slate-800/50 p-4">
                        <h3 className="mb-2 text-sm font-semibold text-slate-300">
                            Description
                        </h3>
                        <p className="whitespace-pre-wrap text-sm text-slate-400">
                            {task.body}
                        </p>
                    </div>
                )}

                {/* Actions */}
                <div className="flex flex-wrap gap-2 pt-2">
                    {currentColumn !== "todo" && (
                        <Button
                            variant="secondary"
                            onClick={() => handleMove("todo")}
                            disabled={isMoving}
                        >
                            Move to New
                        </Button>
                    )}
                    {currentColumn !== "in-progress" && (
                        <Button
                            variant="secondary"
                            onClick={() => handleMove("in-progress")}
                            disabled={isMoving}
                        >
                            Move to In Progress
                        </Button>
                    )}
                    {currentColumn !== "blocked" && (
                        <Button
                            variant="secondary"
                            onClick={() => handleMove("blocked")}
                            disabled={isMoving}
                        >
                            Move to Blocked
                        </Button>
                    )}
                    {currentColumn !== "done" && (
                        <Button
                            variant="primary"
                            onClick={() => handleMove("done")}
                            disabled={isMoving}
                        >
                            Mark Done
                        </Button>
                    )}
                    <Button
                        variant="secondary"
                        onClick={() => window.open(task.url, "_blank")}
                        className="ml-auto"
                    >
                        <ExternalLink className="mr-2 h-4 w-4" />
                        Open in GitHub
                    </Button>
                </div>
            </div>
        </Modal>
    );
}
