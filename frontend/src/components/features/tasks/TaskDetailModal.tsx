import {
    ArrowRight,
    Check,
    Circle,
    Pencil,
    Save,
    Trash2,
    UserPlus,
    X,
} from "lucide-react";
import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import {
    type ColumnId,
    type Task,
    TASK_ASSIGNEES,
    type TaskAssigneeId,
    type TaskAutomationInput,
    type TaskUpdate,
} from "../../../../../contracts/tasks";
import { timestampFromDateString } from "../../../utils/date";
import { formatDate, formatDuration } from "../../../utils/format";
import {
    formatTaskColumnBadge,
    getColumnId,
    getPriority,
    normalizeTaskDetailColumn,
    PRIORITY_COLORS,
} from "../../../utils/taskUtilities";
import { Button } from "../../ui/Button";
import { Input } from "../../ui/Input";
import { Modal } from "../../ui/Modal";
import { Textarea } from "../../ui/Textarea";
import { TaskAutomationSummary } from "./TaskAutomationSummary";
import { TaskProgressUpdates } from "./TaskProgressUpdates";

/** Provides task data and callbacks used by the task detail modal. */
interface TaskDetailModalProperties {
    task: Task | undefined;
    onClose: () => void;
    onMove: (column: ColumnId) => Promise<void>;
    onAssign: (assignee: TaskAssigneeId) => Promise<void>;
    onDelete: () => void;
    onUpdate: (updates: {
        title?: string;
        body?: string;
        labels?: string[];
        automation?: TaskAutomationInput | null | undefined;
    }) => Promise<Task>;
    updates: TaskUpdate[];
    onAddUpdate: (messageMd: string) => Promise<void>;
    onEditUpdate: (updateId: number, messageMd: string) => Promise<void>;
    onDeleteUpdate: (updateId: number) => void;
}

/**
 * Renders the task detail modal UI.
 * @returns Rendered the task detail modal UI.
 */
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
    const [isEditingTask, setIsEditingTask] = useState(false);
    const [editTitle, setEditTitle] = useState(task?.title || "");
    const [editBody, setEditBody] = useState(task?.body || "");
    const [editPriority, setEditPriority] = useState<"low" | "medium" | "high">(() =>
        getPriority(task?.labels || [])
    );
    const [editCronJobId, setEditCronJobId] = useState(task?.automation?.cronJobId || "");
    const [editScheduleSummary, setEditScheduleSummary] = useState(
        task?.automation?.scheduleSummary || ""
    );
    const [editSessionTarget, setEditSessionTarget] = useState(
        task?.automation?.sessionTarget || ""
    );

    if (!task) {
        return;
    }

    const priority = getPriority(task.labels);
    const rawColumn = getColumnId(task);
    const currentColumn = normalizeTaskDetailColumn(rawColumn);
    const assigneeLogin = task.assignees[0]?.login || task.assignees[0]?.name;
    const automation = task.automation;
    let assigneeProfileUrl: string | undefined;
    if (assigneeLogin === TASK_ASSIGNEES.mira.id) {
        assigneeProfileUrl = TASK_ASSIGNEES.mira.githubUrl;
    } else if (assigneeLogin === TASK_ASSIGNEES.raymond.id) {
        assigneeProfileUrl = TASK_ASSIGNEES.raymond.githubUrl;
    }

    /** Refreshes the edit form from the current task before editing starts. */
    const beginTaskEdit = (): void => {
        setEditTitle(task.title);
        setEditBody(task.body || "");
        setEditPriority(getPriority(task.labels));
        setEditCronJobId(task.automation?.cronJobId || "");
        setEditScheduleSummary(task.automation?.scheduleSummary || "");
        setEditSessionTarget(task.automation?.sessionTarget || "");
        setIsEditingTask(true);
    };

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
                : null,
        });

        setIsEditingTask(false);
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

                {automation && !isEditingTask ? (
                    <TaskAutomationSummary automation={automation} />
                ) : undefined}

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

                <TaskProgressUpdates
                    onAddUpdate={onAddUpdate}
                    onDeleteUpdate={onDeleteUpdate}
                    onEditUpdate={onEditUpdate}
                    updates={updates}
                />

                <div className="space-y-3 pt-2">
                    <div className="grid grid-cols-1 gap-2 sm:flex sm:flex-wrap">
                        {currentColumn !== "todo" && (
                            <Button
                                variant="secondary"
                                onClick={() => {
                                    void handleMove("todo");
                                }}
                            >
                                <ArrowRight className="size-4" />
                                Move to New
                            </Button>
                        )}
                        {currentColumn !== "in-progress" && (
                            <Button
                                variant="secondary"
                                onClick={() => {
                                    void handleMove("in-progress");
                                }}
                            >
                                <ArrowRight className="size-4" />
                                Move to In Progress
                            </Button>
                        )}
                        {currentColumn !== "blocked" && (
                            <Button
                                variant="secondary"
                                onClick={() => {
                                    void handleMove("blocked");
                                }}
                            >
                                <ArrowRight className="size-4" />
                                Move to Blocked
                            </Button>
                        )}
                        {currentColumn !== "done" && (
                            <Button
                                variant="primary"
                                onClick={() => {
                                    void handleMove("done");
                                }}
                            >
                                <Check className="size-4" />
                                Mark Done
                            </Button>
                        )}
                    </div>

                    <div className="grid grid-cols-1 gap-2 border-t border-primary-700 pt-3 sm:flex sm:flex-wrap">
                        {isEditingTask ? (
                            <>
                                <Button
                                    variant="primary"
                                    onClick={() => {
                                        void handleSaveTask();
                                    }}
                                >
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
                            <Button variant="secondary" onClick={beginTaskEdit}>
                                <Pencil className="size-4" />
                                Edit
                            </Button>
                        )}

                        {assigneeLogin !== TASK_ASSIGNEES.mira.id && (
                            <Button
                                variant="secondary"
                                onClick={() => {
                                    void handleAssign(TASK_ASSIGNEES.mira.id);
                                }}
                                disabled={isAssigning}
                            >
                                <UserPlus className="size-4" />
                                Assign to Mira
                            </Button>
                        )}
                        {assigneeLogin !== TASK_ASSIGNEES.raymond.id && (
                            <Button
                                variant="secondary"
                                onClick={() => {
                                    void handleAssign(TASK_ASSIGNEES.raymond.id);
                                }}
                                disabled={isAssigning}
                            >
                                <UserPlus className="size-4" />
                                Assign to Raymond
                            </Button>
                        )}

                        <Button
                            variant="danger"
                            onClick={onDelete}
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
