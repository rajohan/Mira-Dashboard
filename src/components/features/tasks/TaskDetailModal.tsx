import { Trash2, X } from "lucide-react";
import ReactMarkdown from "react-markdown";
import { useEffect, useMemo, useState } from "react";
import remarkGfm from "remark-gfm";

import { TASK_ASSIGNEES, type TaskAssigneeId } from "../../../constants/taskActors";
import type { ColumnId, Task, TaskUpdate } from "../../../types/task";
import { formatDate, formatDuration } from "../../../utils/format";
import { getColumnId, getPriority, PRIORITY_COLORS } from "../../../utils/taskUtils";
import { Button } from "../../ui/Button";
import { Input } from "../../ui/Input";
import { Modal } from "../../ui/Modal";
import { Textarea } from "../../ui/Textarea";

interface TaskDetailModalProps {
    task: Task | null;
    onClose: () => void;
    onMove: (column: ColumnId) => Promise<void>;
    onAssign: (assignee: TaskAssigneeId) => Promise<void>;
    onDelete: () => Promise<void>;
    onUpdate: (updates: {
        title?: string;
        body?: string;
        labels?: string[];
    }) => Promise<Task>;
    updates: TaskUpdate[];
    onAddUpdate: (messageMd: string) => Promise<void>;
    onEditUpdate: (updateId: number, messageMd: string) => Promise<void>;
    onDeleteUpdate: (updateId: number) => Promise<void>;
}

export function TaskDetailModal({
    task,
    onClose,
    onMove,
    onAssign,
    onDelete,
    onUpdate,
    updates,
    onAddUpdate,
    onEditUpdate,
    onDeleteUpdate,
}: TaskDetailModalProps) {
    const [isAssigning, setIsAssigning] = useState(false);
    const [isDeleting, setIsDeleting] = useState(false);

    const [isEditingTask, setIsEditingTask] = useState(false);
    const [editTitle, setEditTitle] = useState(task?.title || "");
    const [editBody, setEditBody] = useState(task?.body || "");
    const [editPriority, setEditPriority] = useState<"low" | "medium" | "high">(
        getPriority(task?.labels || [])
    );

    const [progressMessage, setProgressMessage] = useState("");

    const [editingUpdateId, setEditingUpdateId] = useState<number | null>(null);
    const [editingUpdateMessage, setEditingUpdateMessage] = useState("");

    if (!task) {
        return null;
    }

    const priority = getPriority(task.labels);
    const currentColumn = getColumnId(task) || "todo";
    const assigneeLogin = task.assignees[0]?.login || task.assignees[0]?.name;

    useEffect(() => {
        setEditTitle(task.title);
        setEditBody(task.body || "");
        setEditPriority(getPriority(task.labels || []));

    }, [task, assigneeLogin]);

    const assigneeProfileUrl = useMemo(() => {
        if (assigneeLogin === TASK_ASSIGNEES.mira.id) {
            return TASK_ASSIGNEES.mira.githubUrl;
        }
        if (assigneeLogin === TASK_ASSIGNEES.raymond.id) {
            return TASK_ASSIGNEES.raymond.githubUrl;
        }
        return null;
    }, [assigneeLogin]);

    const handleMove = async (column: ColumnId) => {
        await onMove(column);
    };

    const handleAssign = async (assignee: TaskAssigneeId) => {
        setIsAssigning(true);
        await onAssign(assignee);
        setIsAssigning(false);
    };

    const handleDeleteTask = async () => {
        setIsDeleting(true);
        await onDelete();
        setIsDeleting(false);
    };

    const handleSaveTask = async () => {
        const nextLabels = task.labels
            .map((label) => label.name)
            .filter((name) => {
                const normalized = name.toLowerCase();
                return (
                    !normalized.startsWith("priority-") &&
                    !["high", "medium", "low"].includes(normalized)
                );
            });

        nextLabels.push(`priority-${editPriority}`);

        await onUpdate({
            title: editTitle.trim(),
            body: editBody,
            labels: nextLabels,
        });

        setIsEditingTask(false);
    };

    const handleAddUpdate = async () => {
        if (!progressMessage.trim()) {
            return;
        }

        await onAddUpdate(progressMessage.trim());
        setProgressMessage("");
    };

    const startEditUpdate = (update: TaskUpdate) => {
        setEditingUpdateId(update.id);
        setEditingUpdateMessage(update.messageMd);
    };

    const saveUpdateEdit = async () => {
        if (!editingUpdateId || !editingUpdateMessage.trim()) {
            return;
        }

        await onEditUpdate(editingUpdateId, editingUpdateMessage.trim());

        setEditingUpdateId(null);
        setEditingUpdateMessage("");
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
                                {task.state === "CLOSED" ? "DONE" : currentColumn.toUpperCase()}
                            </span>
                            <span
                                className={
                                    "rounded-full border px-2 py-0.5 text-xs font-medium " +
                                    PRIORITY_COLORS[priority]
                                }
                            >
                                {priority.toUpperCase()}
                            </span>
                        </div>

                        {isEditingTask ? (
                            <div className="space-y-2">
                                <Input
                                    label="Title"
                                    value={editTitle}
                                    onChange={(event) => setEditTitle(event.target.value)}
                                />
                                <Textarea
                                    label="Description"
                                    value={editBody}
                                    onChange={(event) => setEditBody(event.target.value)}
                                    rows={4}
                                />
                                <div>
                                    <label className="mb-1.5 block text-sm font-medium text-slate-300">
                                        Priority
                                    </label>
                                    <div className="flex gap-2">
                                        {(["low", "medium", "high"] as const).map((p) => (
                                            <Button
                                                key={p}
                                                type="button"
                                                variant={editPriority === p ? "primary" : "secondary"}
                                                onClick={() => setEditPriority(p)}
                                            >
                                                {p}
                                            </Button>
                                        ))}
                                    </div>
                                </div>
                            </div>
                        ) : (
                            <h2 className="text-lg font-semibold text-slate-100">
                                #{task.number}: {task.title}
                            </h2>
                        )}
                    </div>
                    <Button variant="ghost" size="sm" onClick={onClose}>
                        <X className="h-5 w-5" />
                    </Button>
                </div>

                <div className="flex flex-wrap items-center gap-4 text-sm text-slate-400">
                    {assigneeLogin && (
                        <span>
                            Assigned:{" "}
                            {assigneeProfileUrl ? (
                                <a href={assigneeProfileUrl} target="_blank" rel="noreferrer">
                                    @{assigneeLogin}
                                </a>
                            ) : (
                                `@${assigneeLogin}`
                            )}
                        </span>
                    )}
                    <span>Created {formatDate(task.createdAt)}</span>
                    <span>Updated {formatDuration(new Date(task.updatedAt).getTime())}</span>
                </div>

                {task.body && !isEditingTask && (
                    <div className="rounded-lg border border-slate-700 bg-slate-800/50 p-4">
                        <h3 className="mb-2 text-sm font-semibold text-slate-300">Description</h3>
                        <div className="prose prose-invert max-w-none text-sm prose-p:my-1">
                            <ReactMarkdown remarkPlugins={[remarkGfm]}>{task.body}</ReactMarkdown>
                        </div>
                    </div>
                )}

                <div className="rounded-lg border border-slate-700 bg-slate-800/30 p-4">
                    <h3 className="mb-2 text-sm font-semibold text-slate-300">Progress updates</h3>
                    <div className="mb-3 space-y-2">
                        {updates.length === 0 ? (
                            <p className="text-sm text-slate-500">No updates yet.</p>
                        ) : (
                            updates.map((update) => {
                                const authorMeta =
                                    update.author === TASK_ASSIGNEES.mira.id
                                        ? TASK_ASSIGNEES.mira
                                        : TASK_ASSIGNEES.raymond;
                                const isEditingThis = editingUpdateId === update.id;

                                return (
                                    <div
                                        key={update.id}
                                        className="rounded border border-slate-700 bg-slate-900/40 p-2"
                                    >
                                        <div className="mb-1 flex items-center justify-between text-xs text-slate-500">
                                            <span>
                                                <a
                                                    href={authorMeta.githubUrl}
                                                    target="_blank"
                                                    rel="noreferrer"
                                                >
                                                    @{authorMeta.id}
                                                </a>{" "}
                                                · {formatDate(update.createdAt)}
                                            </span>
                                            <div className="flex gap-2">
                                                <Button
                                                    size="sm"
                                                    variant="ghost"
                                                    onClick={() => startEditUpdate(update)}
                                                >
                                                    Edit
                                                </Button>
                                                <Button
                                                    size="sm"
                                                    variant="ghost"
                                                    onClick={() => onDeleteUpdate(update.id)}
                                                >
                                                    Delete
                                                </Button>
                                            </div>
                                        </div>

                                        {isEditingThis ? (
                                            <div className="space-y-2">
                                                <Textarea
                                                    value={editingUpdateMessage}
                                                    onChange={(event) =>
                                                        setEditingUpdateMessage(event.target.value)
                                                    }
                                                    rows={3}
                                                />
                                                <div className="flex gap-2">
                                                    <Button size="sm" variant="primary" onClick={saveUpdateEdit}>
                                                        Save
                                                    </Button>
                                                    <Button
                                                        size="sm"
                                                        variant="secondary"
                                                        onClick={() => setEditingUpdateId(null)}
                                                    >
                                                        Cancel
                                                    </Button>
                                                </div>
                                            </div>
                                        ) : (
                                            <div className="prose prose-invert max-w-none text-sm prose-p:my-1">
                                                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                                                    {update.messageMd}
                                                </ReactMarkdown>
                                            </div>
                                        )}
                                    </div>
                                );
                            })
                        )}
                    </div>

                    <div className="space-y-2">
                        <Textarea
                            label="Add progress update"
                            value={progressMessage}
                            onChange={(event) => setProgressMessage(event.target.value)}
                            rows={3}
                            placeholder="Markdown supported"
                        />
                        <Button variant="secondary" onClick={handleAddUpdate}>
                            Add Update
                        </Button>
                    </div>
                </div>

                <div className="space-y-3 pt-2">
                    <div className="flex flex-wrap gap-2">
                        {currentColumn !== "todo" && (
                            <Button variant="secondary" onClick={() => handleMove("todo")}>
                                Move to New
                            </Button>
                        )}
                        {currentColumn !== "in-progress" && (
                            <Button variant="secondary" onClick={() => handleMove("in-progress")}>
                                Move to In Progress
                            </Button>
                        )}
                        {currentColumn !== "blocked" && (
                            <Button variant="secondary" onClick={() => handleMove("blocked")}>
                                Move to Blocked
                            </Button>
                        )}
                        {currentColumn !== "done" && (
                            <Button variant="primary" onClick={() => handleMove("done")}>
                                Mark Done
                            </Button>
                        )}
                    </div>

                    <div className="flex flex-wrap gap-2 border-t border-slate-700 pt-3">
                        {isEditingTask ? (
                            <>
                                <Button variant="primary" onClick={handleSaveTask}>
                                    Save Changes
                                </Button>
                                <Button variant="secondary" onClick={() => setIsEditingTask(false)}>
                                    Cancel Edit
                                </Button>
                            </>
                        ) : (
                            <Button variant="secondary" onClick={() => setIsEditingTask(true)}>
                                Edit
                            </Button>
                        )}

                        {assigneeLogin !== TASK_ASSIGNEES.mira.id && (
                            <Button
                                variant="secondary"
                                onClick={() => handleAssign(TASK_ASSIGNEES.mira.id)}
                                disabled={isAssigning}
                            >
                                Assign to Mira
                            </Button>
                        )}
                        {assigneeLogin !== TASK_ASSIGNEES.raymond.id && (
                            <Button
                                variant="secondary"
                                onClick={() => handleAssign(TASK_ASSIGNEES.raymond.id)}
                                disabled={isAssigning}
                            >
                                Assign to Raymond
                            </Button>
                        )}

                        <Button
                            variant="danger"
                            onClick={handleDeleteTask}
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
