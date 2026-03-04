import { Trash2, X } from "lucide-react";
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
    onAssign: (assignee: string | null) => Promise<void>;
    onDelete: () => Promise<void>;
}

export function TaskDetailModal({
    task,
    onClose,
    onMove,
    onAssign,
    onDelete,
}: TaskDetailModalProps) {
    const [isMoving, setIsMoving] = useState(false);
    const [isAssigning, setIsAssigning] = useState(false);
    const [isDeleting, setIsDeleting] = useState(false);

    if (!task) return null;

    const priority = getPriority(task.labels);
    const assignee = task.assignees[0];
    const currentColumn = getColumnId(task);

    const handleMove = async (column: ColumnId) => {
        setIsMoving(true);
        await onMove(column);
        setIsMoving(false);
    };

    const handleAssign = async (nextAssignee: string | null) => {
        setIsAssigning(true);
        await onAssign(nextAssignee);
        setIsAssigning(false);
    };

    const handleDelete = async () => {
        setIsDeleting(true);
        await onDelete();
        setIsDeleting(false);
    };

    return (
        <Modal isOpen={!!task} onClose={onClose} size="2xl">
            <div className="space-y-4">
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
                                .filter((l: { name: string }) => {
                                    const normalized = l.name.toLowerCase();
                                    return (
                                        !normalized.startsWith("priority-") &&
                                        !["todo", "in-progress", "blocked", "done"].includes(
                                            normalized
                                        )
                                    );
                                })
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

                <div className="flex flex-wrap items-center gap-4 text-sm text-slate-400">
                    {assignee && <span>Assigned: @{assignee.login || assignee.name}</span>}
                    <span>Created {formatDate(task.createdAt)}</span>
                    <span>Updated {formatDuration(new Date(task.updatedAt).getTime())}</span>
                </div>

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

                <div className="space-y-3 pt-2">
                    <div className="flex flex-wrap gap-2">
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
                    </div>

                    <div className="flex flex-wrap gap-2 border-t border-slate-700 pt-3">
                        <Button
                            variant="secondary"
                            onClick={() => handleAssign("mira-2026")}
                            disabled={isAssigning}
                        >
                            Assign to Mira
                        </Button>
                        <Button
                            variant="secondary"
                            onClick={() => handleAssign("rajohan")}
                            disabled={isAssigning}
                        >
                            Assign to Raymond
                        </Button>
                        <Button
                            variant="ghost"
                            onClick={() => handleAssign(null)}
                            disabled={isAssigning}
                        >
                            Unassign
                        </Button>
                        <Button
                            variant="danger"
                            onClick={handleDelete}
                            disabled={isDeleting}
                            className="ml-auto"
                        >
                            <Trash2 className="mr-2 h-4 w-4" />
                            Delete
                        </Button>
                    </div>
                </div>
            </div>
        </Modal>
    );
}
