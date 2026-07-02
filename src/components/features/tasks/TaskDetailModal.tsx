import {
    ArrowRight,
    Check,
    Circle,
    Pencil,
    Plus,
    Save,
    Trash2,
    UserPlus,
    X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { TASK_ASSIGNEES, type TaskAssigneeId } from "../../../constants/taskActors";
import type { ColumnId, Task, TaskAutomation, TaskUpdate } from "../../../types/task";
import {
    formatCronLastStatus,
    formatCronTimestamp,
    getCronStatusVariant,
} from "../../../utils/cronUtilities";
import { timestampFromDateString } from "../../../utils/date";
import { formatDate, formatDuration } from "../../../utils/format";
import { getColumnId, getPriority, PRIORITY_COLORS } from "../../../utils/taskUtilities";
import { Badge } from "../../ui/Badge";
import { Button } from "../../ui/Button";
import { Input } from "../../ui/Input";
import { Modal } from "../../ui/Modal";
import { Textarea } from "../../ui/Textarea";

const CLEAR_TASK_AUTOMATION = JSON.parse("null") as null;

/** Returns a stable task column for movement controls. */
export function normalizeTaskDetailColumn(column?: ColumnId | undefined): ColumnId {
    return column ?? "todo";
}

/** Formats the task status badge without coercing nullish columns. */
export function formatTaskColumnBadge(column?: ColumnId | undefined): string {
    return column?.toUpperCase() ?? "UNASSIGNED";
}

/** Formats elapsed milliseconds into a short human-readable duration. */
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

/** Provides task data and callbacks used by the task detail modal. */
interface TaskDetailModalProperties {
    task: Task | undefined;
    onClose: () => void;
    onMove: (column: ColumnId) => Promise<void>;
    onAssign: (assignee: TaskAssigneeId) => Promise<void>;
    onDelete: () => Promise<void>;
    onUpdate: (updates: {
        title?: string;
        body?: string;
        labels?: string[];
        automation?:
            | Pick<TaskAutomation, "cronJobId" | "scheduleSummary" | "sessionTarget">
            | null
            | undefined;
    }) => Promise<Task>;
    updates: TaskUpdate[];
    onAddUpdate: (messageMd: string) => Promise<void>;
    onEditUpdate: (updateId: number, messageMd: string) => Promise<void>;
    onDeleteUpdate: (updateId: number) => Promise<void>;
}

/** Renders the task detail modal UI. */
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
}: TaskDetailModalProperties) {
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

    const [editingUpdateId, setEditingUpdateId] = useState<number | undefined>(undefined);
    const [editingUpdateMessage, setEditingUpdateMessage] = useState("");
    const previousTaskNumberReference = useRef<number | undefined>(
        task?.number ?? undefined
    );

    useEffect(() => {
        if (!task) {
            previousTaskNumberReference.current = undefined;
            setIsEditingTask(false);
            setProgressMessage("");
            setEditingUpdateId(undefined);
            setEditingUpdateMessage("");
            return;
        }

        const previousTaskNumber = previousTaskNumberReference.current;
        previousTaskNumberReference.current = task.number;

        const isNewTask = previousTaskNumber !== task.number;

        if (isNewTask) {
            setIsEditingTask(false);
            setProgressMessage("");
            setEditingUpdateId(undefined);
            setEditingUpdateMessage("");
        }

        if (isNewTask || !isEditingTask) {
            setEditTitle(task.title);
            setEditBody(task.body || "");
            setEditPriority(getPriority(task.labels));
            setEditCronJobId(task.automation?.cronJobId || "");
            setEditScheduleSummary(task.automation?.scheduleSummary || "");
            setEditSessionTarget(task.automation?.sessionTarget || "");
        }
    }, [isEditingTask, task]);

    if (!task) {
        return;
    }

    const priority = getPriority(task.labels);
    const rawColumn = getColumnId(task);
    const currentColumn = normalizeTaskDetailColumn(rawColumn);
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
    const trimmedProgressMessage = progressMessage.trim();
    const trimmedEditingUpdateMessage = editingUpdateMessage.trim();

    const assigneeProfileUrl =
        assigneeLogin === TASK_ASSIGNEES.mira.id
            ? TASK_ASSIGNEES.mira.githubUrl
            : assigneeLogin === TASK_ASSIGNEES.raymond.id
              ? TASK_ASSIGNEES.raymond.githubUrl
              : undefined;

    /** Moves the task to the selected column. */
    const handleMove = async (column: ColumnId) => {
        await onMove(column);
    };

    /** Assigns the task to the selected assignee. */
    const handleAssign = async (assignee: TaskAssigneeId) => {
        setIsAssigning(true);
        try {
            await onAssign(assignee);
        } catch (error_) {
            console.error("Failed to assign task:", error_);
        } finally {
            setIsAssigning(false);
        }
    };

    /** Deletes the current task. */
    const handleDeleteTask = async () => {
        setIsDeleting(true);
        try {
            await onDelete();
        } catch (error_) {
            console.error("Failed to delete task:", error_);
        } finally {
            setIsDeleting(false);
        }
    };

    /** Persists task edits, including priority and automation metadata. */
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
                : CLEAR_TASK_AUTOMATION,
        });

        setIsEditingTask(false);
    };

    /** Adds a new progress update when the message is non-empty. */
    const handleAddUpdate = async () => {
        if (!trimmedProgressMessage) {
            return;
        }

        await onAddUpdate(trimmedProgressMessage);
        setProgressMessage("");
    };

    /** Starts editing the selected progress update. */
    const startEditUpdate = (update: TaskUpdate) => {
        setEditingUpdateId(update.id);
        setEditingUpdateMessage(update.messageMd);
    };

    /** Saves the in-progress edit for a progress update. */
    const saveUpdateEdit = async () => {
        if (!editingUpdateId || !trimmedEditingUpdateMessage) {
            return;
        }

        await onEditUpdate(editingUpdateId, trimmedEditingUpdateMessage);

        setEditingUpdateId(undefined);
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
                                    : formatTaskColumnBadge(rawColumn)}
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
                                <fieldset>
                                    <legend className="mb-1.5 block text-sm font-medium text-primary-300">
                                        Priority
                                    </legend>
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
                                                <Circle className="size-4" />
                                                {p}
                                            </Button>
                                        ))}
                                    </div>
                                </fieldset>
                                <div className="space-y-3 rounded-lg border border-primary-700 bg-primary-900/30 p-3">
                                    <div>
                                        <h3 className="text-sm font-semibold text-primary-200">
                                            Recurring automation
                                        </h3>
                                        <p className="text-xs text-primary-500">
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
                            <h2 className="text-lg font-semibold wrap-break-word text-primary-100">
                                #{task.number}: {task.title}
                            </h2>
                        )}
                    </div>
                    <Button
                        variant="ghost"
                        size="sm"
                        aria-label="Close task details"
                        onClick={onClose}
                    >
                        <X className="size-5" />
                    </Button>
                </div>

                <div className="flex flex-col gap-1 text-sm text-primary-400 sm:flex-row sm:flex-wrap sm:items-center sm:gap-4">
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
                        Updated {formatDuration(timestampFromDateString(task.updatedAt))}
                    </span>
                </div>

                {automation && !isEditingTask && (
                    <div className="rounded-lg border border-primary-700 bg-primary-800/50 p-4">
                        <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                            <div>
                                <h3 className="text-sm font-semibold text-primary-300">
                                    Backed by OpenClaw cron
                                </h3>
                                <p className="mt-1 text-xs text-primary-500">
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
                                <dt className="text-xs tracking-wide text-primary-500 uppercase">
                                    Cron job
                                </dt>
                                <dd className="break-all text-primary-200">
                                    <a
                                        href={`/jobs?view=openclaw&job=${encodeURIComponent(automation.cronJobId)}`}
                                        className="hover:text-primary-100"
                                    >
                                        {automation.jobName || automation.cronJobId}
                                    </a>
                                </dd>
                            </div>
                            <div>
                                <dt className="text-xs tracking-wide text-primary-500 uppercase">
                                    Schedule
                                </dt>
                                <dd className="text-primary-200">
                                    {automation.scheduleSummary || "—"}
                                </dd>
                            </div>
                            <div>
                                <dt className="text-xs tracking-wide text-primary-500 uppercase">
                                    Next run
                                </dt>
                                <dd className="text-primary-200">
                                    {formatCronTimestamp(automation.nextRunAtMs)}
                                </dd>
                            </div>
                            <div>
                                <dt className="text-xs tracking-wide text-primary-500 uppercase">
                                    Last run
                                </dt>
                                <dd className="text-primary-200">
                                    {formatCronTimestamp(automation.lastRunAtMs)}
                                </dd>
                            </div>
                            <div>
                                <dt className="text-xs tracking-wide text-primary-500 uppercase">
                                    Session
                                </dt>
                                <dd className="break-all text-primary-200">
                                    {automation.sessionTarget || "—"}
                                </dd>
                            </div>
                            <div>
                                <dt className="text-xs tracking-wide text-primary-500 uppercase">
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
                                    <dt className="text-xs tracking-wide text-primary-500 uppercase">
                                        Last duration
                                    </dt>
                                    <dd className="text-primary-200">
                                        {formatElapsedMs(automation.lastDurationMs)}
                                    </dd>
                                </div>
                            )}
                            <div>
                                <dt className="text-xs tracking-wide text-primary-500 uppercase">
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
                    <div className="rounded-lg border border-primary-700 bg-primary-800/50 p-4">
                        <h3 className="mb-2 text-sm font-semibold text-primary-300">
                            Description
                        </h3>
                        <div className="prose max-w-none text-sm prose-invert prose-p:my-1">
                            <ReactMarkdown remarkPlugins={[remarkGfm]}>
                                {task.body}
                            </ReactMarkdown>
                        </div>
                    </div>
                )}

                <div className="rounded-lg border border-primary-700 bg-primary-800/30 p-4">
                    <h3 className="mb-2 text-sm font-semibold text-primary-300">
                        Progress updates
                    </h3>
                    <div className="mb-3 space-y-2">
                        {updates.length === 0 ? (
                            <p className="text-sm text-primary-500">No updates yet.</p>
                        ) : (
                            updates.map((update) => {
                                const authorMeta =
                                    TASK_ASSIGNEES[
                                        update.author === TASK_ASSIGNEES.mira.id
                                            ? "mira"
                                            : "raymond"
                                    ];
                                const isEditingThis = editingUpdateId === update.id;

                                return (
                                    <div
                                        key={update.id}
                                        className="rounded border border-primary-700 bg-primary-900/40 p-2"
                                    >
                                        <div className="mb-1 flex flex-col gap-2 text-xs text-primary-500 sm:flex-row sm:items-center sm:justify-between">
                                            <span className="min-w-0 wrap-break-word">
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
                                                    aria-label={`Edit progress update #${update.id}`}
                                                    onClick={() =>
                                                        startEditUpdate(update)
                                                    }
                                                >
                                                    <Pencil className="size-4" />
                                                    Edit
                                                </Button>
                                                <Button
                                                    size="sm"
                                                    variant="ghost"
                                                    aria-label={`Delete progress update #${update.id}`}
                                                    onClick={() =>
                                                        onDeleteUpdate(update.id)
                                                    }
                                                >
                                                    <Trash2 className="size-4" />
                                                    Delete
                                                </Button>
                                            </div>
                                        </div>

                                        {isEditingThis ? (
                                            <div className="space-y-2">
                                                <Textarea
                                                    aria-label={`Message for progress update #${update.id}`}
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
                                                        disabled={
                                                            !trimmedEditingUpdateMessage
                                                        }
                                                    >
                                                        <Save className="size-4" />
                                                        Save
                                                    </Button>
                                                    <Button
                                                        size="sm"
                                                        variant="secondary"
                                                        onClick={() =>
                                                            setEditingUpdateId(undefined)
                                                        }
                                                    >
                                                        <X className="size-4" />
                                                        Cancel
                                                    </Button>
                                                </div>
                                            </div>
                                        ) : (
                                            <div className="prose max-w-none text-sm prose-invert prose-p:my-1">
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
                            disabled={!trimmedProgressMessage}
                            className="w-full sm:w-auto"
                        >
                            <Plus className="size-4" />
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
                                <ArrowRight className="size-4" />
                                Move to New
                            </Button>
                        )}
                        {currentColumn !== "in-progress" && (
                            <Button
                                variant="secondary"
                                onClick={() => handleMove("in-progress")}
                            >
                                <ArrowRight className="size-4" />
                                Move to In Progress
                            </Button>
                        )}
                        {currentColumn !== "blocked" && (
                            <Button
                                variant="secondary"
                                onClick={() => handleMove("blocked")}
                            >
                                <ArrowRight className="size-4" />
                                Move to Blocked
                            </Button>
                        )}
                        {currentColumn !== "done" && (
                            <Button variant="primary" onClick={() => handleMove("done")}>
                                <Check className="size-4" />
                                Mark Done
                            </Button>
                        )}
                    </div>

                    <div className="grid grid-cols-1 gap-2 border-t border-primary-700 pt-3 sm:flex sm:flex-wrap">
                        {isEditingTask ? (
                            <>
                                <Button variant="primary" onClick={handleSaveTask}>
                                    <Save className="size-4" />
                                    Save Changes
                                </Button>
                                <Button
                                    variant="secondary"
                                    onClick={() => setIsEditingTask(false)}
                                >
                                    <X className="size-4" />
                                    Cancel Edit
                                </Button>
                            </>
                        ) : (
                            <Button
                                variant="secondary"
                                onClick={() => setIsEditingTask(true)}
                            >
                                <Pencil className="size-4" />
                                Edit
                            </Button>
                        )}

                        {assigneeLogin !== TASK_ASSIGNEES.mira.id && (
                            <Button
                                variant="secondary"
                                onClick={() => handleAssign(TASK_ASSIGNEES.mira.id)}
                                disabled={isAssigning}
                            >
                                <UserPlus className="size-4" />
                                Assign to Mira
                            </Button>
                        )}
                        {assigneeLogin !== TASK_ASSIGNEES.raymond.id && (
                            <Button
                                variant="secondary"
                                onClick={() => handleAssign(TASK_ASSIGNEES.raymond.id)}
                                disabled={isAssigning}
                            >
                                <UserPlus className="size-4" />
                                Assign to Raymond
                            </Button>
                        )}

                        <Button
                            variant="danger"
                            onClick={handleDeleteTask}
                            disabled={isDeleting}
                            className="w-full sm:ml-auto sm:w-auto"
                        >
                            <Trash2 className="size-4" />
                            Delete
                        </Button>
                    </div>
                </div>
            </div>
        </Modal>
    );
}
