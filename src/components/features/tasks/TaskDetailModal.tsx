import { Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { TASK_ASSIGNEES, type TaskAssigneeId } from "../../../constants/taskActors";
import type { ColumnId, Task, TaskAutomation, TaskUpdate } from "../../../types/task";
import {
    formatCronLastStatus,
    formatCronTimestamp,
    getCronStatusVariant,
} from "../../../utils/cronUtils";
import { formatDate, formatDuration } from "../../../utils/format";
import { getColumnId, getPriority, PRIORITY_COLORS } from "../../../utils/taskUtils";
import { Badge } from "../../ui/Badge";
import { Button } from "../../ui/Button";
import { Input } from "../../ui/Input";
import { Modal } from "../../ui/Modal";
import { Textarea } from "../../ui/Textarea";

function formatElapsedMs(value: number): string {
    if (!Number.isFinite(value) || value < 0) {
        return "—";
    }

    const seconds = Math.round(value / 1000);
    if (seconds < 60) {
        return `${seconds}s`;
    }

    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    if (minutes < 60) {
        return remainingSeconds > 0 ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`;
    }

    const hours = Math.floor(minutes / 60);
    const remainingMinutes = minutes % 60;
    return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}

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
        automation?: Pick<
            TaskAutomation,
            "cronJobId" | "scheduleSummary" | "sessionTarget"
        > | null;
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
    const [editCronJobId, setEditCronJobId] = useState(task?.automation?.cronJobId || "");
    const [editScheduleSummary, setEditScheduleSummary] = useState(
        task?.automation?.scheduleSummary || ""
    );
    const [editSessionTarget, setEditSessionTarget] = useState(
        task?.automation?.sessionTarget || ""
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
    const automation = task.automation;
    const automationStatus = automation?.runningAtMs
        ? "RUNNING"
        : automation?.enabled === false
          ? "DISABLED"
          : automation?.lastRunStatus
            ? formatCronLastStatus(automation.lastRunStatus)
            : automation
              ? "SCHEDULED"
              : "";
    const automationStatusVariant = automation?.runningAtMs
        ? "warning"
        : automation?.enabled === false
          ? "default"
          : getCronStatusVariant(automation?.lastRunStatus || "");

    useEffect(() => {
        setEditTitle(task.title);
        setEditBody(task.body || "");
        setEditPriority(getPriority(task.labels || []));
        setEditCronJobId(task.automation?.cronJobId || "");
        setEditScheduleSummary(task.automation?.scheduleSummary || "");
        setEditSessionTarget(task.automation?.sessionTarget || "");
    }, [task, assigneeLogin]);

    const assigneeProfileUrl =
        assigneeLogin === TASK_ASSIGNEES.mira.id
            ? TASK_ASSIGNEES.mira.githubUrl
            : assigneeLogin === TASK_ASSIGNEES.raymond.id
              ? TASK_ASSIGNEES.raymond.githubUrl
              : null;

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

        const cronJobId = editCronJobId.trim();
        const scheduleSummary = editScheduleSummary.trim();
        const sessionTarget = editSessionTarget.trim();

        await onUpdate({
            title: editTitle.trim(),
            body: editBody,
            labels: nextLabels,
            automation: cronJobId
                ? {
                      cronJobId,
                      scheduleSummary,
                      sessionTarget,
                  }
                : null,
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
                <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
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
                                    <label className="text-primary-300 mb-1.5 block text-sm font-medium">
                                        Priority
                                    </label>
                                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                                        {(["low", "medium", "high"] as const).map((p) => (
                                            <Button
                                                key={p}
                                                type="button"
                                                variant={
                                                    editPriority === p
                                                        ? "primary"
                                                        : "secondary"
                                                }
                                                onClick={() => setEditPriority(p)}
                                            >
                                                {p}
                                            </Button>
                                        ))}
                                    </div>
                                </div>
                                <div className="border-primary-700 bg-primary-900/30 space-y-3 rounded-lg border p-3">
                                    <div>
                                        <h3 className="text-primary-200 text-sm font-semibold">
                                            Recurring automation
                                        </h3>
                                        <p className="text-primary-500 text-xs">
                                            Link this task to an OpenClaw cron job for
                                            live run state.
                                        </p>
                                    </div>
                                    <Input
                                        label="Cron job ID"
                                        value={editCronJobId}
                                        onChange={(event) =>
                                            setEditCronJobId(event.target.value)
                                        }
                                        placeholder="1ae8a485-..."
                                    />
                                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                                        <Input
                                            label="Schedule summary"
                                            value={editScheduleSummary}
                                            onChange={(event) =>
                                                setEditScheduleSummary(event.target.value)
                                            }
                                            placeholder="Twice daily at 09:30 and 18:30"
                                        />
                                        <Input
                                            label="Session target"
                                            value={editSessionTarget}
                                            onChange={(event) =>
                                                setEditSessionTarget(event.target.value)
                                            }
                                            placeholder="session:dashboard-autopilot"
                                        />
                                    </div>
                                </div>
                            </div>
                        ) : (
                            <h2 className="text-primary-100 text-lg font-semibold break-words">
                                #{task.number}: {task.title}
                            </h2>
                        )}
                    </div>
                    <Button variant="ghost" size="sm" onClick={onClose}>
                        <X className="h-5 w-5" />
                    </Button>
                </div>

                <div className="text-primary-400 flex flex-col gap-1 text-sm sm:flex-row sm:flex-wrap sm:items-center sm:gap-4">
                    {assigneeLogin && (
                        <span>
                            Assigned:{" "}
                            {assigneeProfileUrl ? (
                                <a
                                    href={assigneeProfileUrl}
                                    target="_blank"
                                    rel="noreferrer"
                                >
                                    @{assigneeLogin}
                                </a>
                            ) : (
                                `@${assigneeLogin}`
                            )}
                        </span>
                    )}
                    <span>Created {formatDate(task.createdAt)}</span>
                    <span>
                        Updated {formatDuration(new Date(task.updatedAt).getTime())}
                    </span>
                </div>

                {automation && !isEditingTask && (
                    <div className="border-primary-700 bg-primary-800/50 rounded-lg border p-4">
                        <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                            <div>
                                <h3 className="text-primary-300 text-sm font-semibold">
                                    Backed by OpenClaw cron
                                </h3>
                                <p className="text-primary-500 mt-1 text-xs">
                                    This task tracks a recurring automation job.
                                </p>
                            </div>
                            {automationStatus && (
                                <Badge variant={automationStatusVariant}>
                                    {automationStatus}
                                </Badge>
                            )}
                        </div>
                        <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
                            <div>
                                <dt className="text-primary-500 text-xs tracking-wide uppercase">
                                    Cron job
                                </dt>
                                <dd className="text-primary-200 break-all">
                                    <a href="/cron" className="hover:text-primary-100">
                                        {automation.jobName || automation.cronJobId}
                                    </a>
                                </dd>
                            </div>
                            <div>
                                <dt className="text-primary-500 text-xs tracking-wide uppercase">
                                    Schedule
                                </dt>
                                <dd className="text-primary-200">
                                    {automation.scheduleSummary || "—"}
                                </dd>
                            </div>
                            <div>
                                <dt className="text-primary-500 text-xs tracking-wide uppercase">
                                    Next run
                                </dt>
                                <dd className="text-primary-200">
                                    {formatCronTimestamp(automation.nextRunAtMs)}
                                </dd>
                            </div>
                            <div>
                                <dt className="text-primary-500 text-xs tracking-wide uppercase">
                                    Last run
                                </dt>
                                <dd className="text-primary-200">
                                    {formatCronTimestamp(automation.lastRunAtMs)}
                                </dd>
                            </div>
                            <div>
                                <dt className="text-primary-500 text-xs tracking-wide uppercase">
                                    Session
                                </dt>
                                <dd className="text-primary-200 break-all">
                                    {automation.sessionTarget || "—"}
                                </dd>
                            </div>
                            <div>
                                <dt className="text-primary-500 text-xs tracking-wide uppercase">
                                    Runtime
                                </dt>
                                <dd className="text-primary-200">
                                    {[automation.model, automation.thinking]
                                        .filter(Boolean)
                                        .join(" · ") || "—"}
                                </dd>
                            </div>
                            {automation.lastDurationMs !== undefined && (
                                <div>
                                    <dt className="text-primary-500 text-xs tracking-wide uppercase">
                                        Last duration
                                    </dt>
                                    <dd className="text-primary-200">
                                        {formatElapsedMs(automation.lastDurationMs)}
                                    </dd>
                                </div>
                            )}
                            <div>
                                <dt className="text-primary-500 text-xs tracking-wide uppercase">
                                    Source
                                </dt>
                                <dd className="text-primary-200">
                                    {automation.source === "cron"
                                        ? "Live cron state"
                                        : "Stored metadata"}
                                </dd>
                            </div>
                        </dl>
                    </div>
                )}

                {task.body && !isEditingTask && (
                    <div className="border-primary-700 bg-primary-800/50 rounded-lg border p-4">
                        <h3 className="text-primary-300 mb-2 text-sm font-semibold">
                            Description
                        </h3>
                        <div className="prose prose-invert prose-p:my-1 max-w-none text-sm">
                            <ReactMarkdown remarkPlugins={[remarkGfm]}>
                                {task.body}
                            </ReactMarkdown>
                        </div>
                    </div>
                )}

                <div className="border-primary-700 bg-primary-800/30 rounded-lg border p-4">
                    <h3 className="text-primary-300 mb-2 text-sm font-semibold">
                        Progress updates
                    </h3>
                    <div className="mb-3 space-y-2">
                        {updates.length === 0 ? (
                            <p className="text-primary-500 text-sm">No updates yet.</p>
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
                                        className="border-primary-700 bg-primary-900/40 rounded border p-2"
                                    >
                                        <div className="text-primary-500 mb-1 flex flex-col gap-2 text-xs sm:flex-row sm:items-center sm:justify-between">
                                            <span className="min-w-0 break-words">
                                                <a
                                                    href={authorMeta.githubUrl}
                                                    target="_blank"
                                                    rel="noreferrer"
                                                >
                                                    @{authorMeta.id}
                                                </a>{" "}
                                                · {formatDate(update.createdAt)}
                                            </span>
                                            <div className="grid grid-cols-2 gap-2 sm:flex">
                                                <Button
                                                    size="sm"
                                                    variant="ghost"
                                                    onClick={() =>
                                                        startEditUpdate(update)
                                                    }
                                                >
                                                    Edit
                                                </Button>
                                                <Button
                                                    size="sm"
                                                    variant="ghost"
                                                    onClick={() =>
                                                        onDeleteUpdate(update.id)
                                                    }
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
                                                        setEditingUpdateMessage(
                                                            event.target.value
                                                        )
                                                    }
                                                    rows={3}
                                                />
                                                <div className="grid grid-cols-1 gap-2 sm:flex">
                                                    <Button
                                                        size="sm"
                                                        variant="primary"
                                                        onClick={saveUpdateEdit}
                                                    >
                                                        Save
                                                    </Button>
                                                    <Button
                                                        size="sm"
                                                        variant="secondary"
                                                        onClick={() =>
                                                            setEditingUpdateId(null)
                                                        }
                                                    >
                                                        Cancel
                                                    </Button>
                                                </div>
                                            </div>
                                        ) : (
                                            <div className="prose prose-invert prose-p:my-1 max-w-none text-sm">
                                                <ReactMarkdown
                                                    remarkPlugins={[remarkGfm]}
                                                >
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
                        <Button
                            variant="secondary"
                            onClick={handleAddUpdate}
                            className="w-full sm:w-auto"
                        >
                            Add Update
                        </Button>
                    </div>
                </div>

                <div className="space-y-3 pt-2">
                    <div className="grid grid-cols-1 gap-2 sm:flex sm:flex-wrap">
                        {currentColumn !== "todo" && (
                            <Button
                                variant="secondary"
                                onClick={() => handleMove("todo")}
                            >
                                Move to New
                            </Button>
                        )}
                        {currentColumn !== "in-progress" && (
                            <Button
                                variant="secondary"
                                onClick={() => handleMove("in-progress")}
                            >
                                Move to In Progress
                            </Button>
                        )}
                        {currentColumn !== "blocked" && (
                            <Button
                                variant="secondary"
                                onClick={() => handleMove("blocked")}
                            >
                                Move to Blocked
                            </Button>
                        )}
                        {currentColumn !== "done" && (
                            <Button variant="primary" onClick={() => handleMove("done")}>
                                Mark Done
                            </Button>
                        )}
                    </div>

                    <div className="border-primary-700 grid grid-cols-1 gap-2 border-t pt-3 sm:flex sm:flex-wrap">
                        {isEditingTask ? (
                            <>
                                <Button variant="primary" onClick={handleSaveTask}>
                                    Save Changes
                                </Button>
                                <Button
                                    variant="secondary"
                                    onClick={() => setIsEditingTask(false)}
                                >
                                    Cancel Edit
                                </Button>
                            </>
                        ) : (
                            <Button
                                variant="secondary"
                                onClick={() => setIsEditingTask(true)}
                            >
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
                            className="w-full sm:ml-auto sm:w-auto"
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
