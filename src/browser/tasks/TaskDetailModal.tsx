import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil, Trash2, TriangleAlert } from "lucide-react";
import { useState } from "react";

import { useDashboardTrpcClient } from "../api/trpcContextValue.ts";
import { dashboardBrowserFailureMessage } from "../api/trpcError.ts";
import { formatDashboardDateTimeToMinute } from "../lib/formatDateTime.ts";
import { Alert } from "../ui/Alert.tsx";
import { Badge } from "../ui/Badge.tsx";
import { Button } from "../ui/Button.tsx";
import { Icon } from "../ui/Icon.tsx";
import { LoadingState } from "../ui/LoadingState.tsx";
import { Markdown } from "../ui/Markdown.tsx";
import { Modal } from "../ui/Modal.tsx";
import { Text } from "../ui/Text.tsx";
import { TaskAutomationSummary } from "./TaskAutomationSummary.tsx";
import { TaskEditorForm } from "./TaskEditorForm.tsx";
import { TaskLabelBadge } from "./TaskLabelBadge.tsx";
import { TaskMetadataControls } from "./TaskMetadataControls.tsx";
import { useDeleteTaskMutation } from "./taskMutations.ts";
import {
    taskPriorityBadgeVariant,
    taskRelativeTime,
    taskStatusBadgeVariant,
    taskStatusLabel,
} from "./taskPresentation.ts";
import { TaskProgressSection } from "./TaskProgressSection.tsx";
import { taskDetailQueryKey, taskDetailQueryOptions } from "./taskQueries.ts";

interface TaskDetailModalProps {
    readonly availableLabels?: readonly string[];
    readonly onClose: () => void;
    readonly taskId: string;
}

/** @returns Complete task detail, edit, progress, and deletion dialog. */
export function TaskDetailModal({
    availableLabels = [],
    onClose,
    taskId,
}: TaskDetailModalProps) {
    const client = useDashboardTrpcClient();
    const queryClient = useQueryClient();
    const task = useQuery(taskDetailQueryOptions(client, taskId));
    const deleteTask = useDeleteTaskMutation(onClose);
    const [editing, setEditing] = useState(false);
    const [confirmingDelete, setConfirmingDelete] = useState(false);
    let modalTitle = "Task details";
    if (task.data !== undefined) {
        modalTitle = editing
            ? `Edit task #${task.data.number}`
            : `#${task.data.number}: ${task.data.title}`;
    }

    return (
        <Modal
            description={
                task.data === undefined ? undefined : (
                    <span className="block">
                        <span className="flex flex-col gap-0.5 sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-4">
                            <time
                                dateTime={new Date(task.data.createdAtMs).toISOString()}
                            >
                                Created{" "}
                                {formatDashboardDateTimeToMinute(
                                    task.data.createdAtMs
                                ).replace(" · ", ", ")}
                            </time>
                            <time
                                dateTime={new Date(task.data.updatedAtMs).toISOString()}
                                title={formatDashboardDateTimeToMinute(
                                    task.data.updatedAtMs
                                )}
                            >
                                Updated {taskRelativeTime(task.data.updatedAtMs)}
                            </time>
                        </span>
                        {task.data.labels.length > 0 && (
                            <span className="mt-2 flex flex-wrap items-center gap-1.5">
                                {task.data.labels.map((label) => (
                                    <TaskLabelBadge key={label} label={label} />
                                ))}
                            </span>
                        )}
                    </span>
                )
            }
            dismissible={!deleteTask.isPending}
            eyebrow={
                !editing && task.data !== undefined ? (
                    <>
                        <Badge variant={taskStatusBadgeVariant(task.data.status)}>
                            {taskStatusLabel(task.data.status)}
                        </Badge>
                        <Badge
                            className="capitalize"
                            variant={taskPriorityBadgeVariant(task.data.priority)}
                        >
                            {task.data.priority}
                        </Badge>
                    </>
                ) : undefined
            }
            onClose={onClose}
            open
            scrollOwner={editing ? "content" : "page"}
            size={editing ? "md" : "lg"}
            title={modalTitle}
        >
            {task.isPending && <LoadingState label="Loading task…" />}
            {task.isError && (
                <Alert message={dashboardBrowserFailureMessage(task.error)} />
            )}
            {task.data !== undefined && editing && (
                <TaskEditorForm
                    availableLabels={availableLabels}
                    key={task.data.version}
                    onCancel={() => setEditing(false)}
                    onSaved={(saved) => {
                        queryClient.setQueryData(taskDetailQueryKey(taskId), saved);
                        setEditing(false);
                    }}
                    task={task.data}
                />
            )}
            {task.data !== undefined && !editing && confirmingDelete && (
                <div>
                    <div className="flex items-start gap-3">
                        <Icon
                            className="mt-0.5 shrink-0"
                            icon={TriangleAlert}
                            tone="danger"
                        />
                        <div>
                            <Text className="font-medium" tone="danger">
                                Delete this task permanently?
                            </Text>
                            <Text className="mt-1" tone="muted">
                                Progress entries are removed. The immutable audit history
                                is retained.
                            </Text>
                        </div>
                    </div>
                    <Alert
                        className="mt-4"
                        message={
                            deleteTask.error === null
                                ? undefined
                                : dashboardBrowserFailureMessage(deleteTask.error)
                        }
                    />
                    <div className="mt-5 flex justify-end gap-2">
                        <Button
                            disabled={deleteTask.isPending}
                            onClick={() => setConfirmingDelete(false)}
                            variant="secondary"
                        >
                            Cancel
                        </Button>
                        <Button
                            busy={deleteTask.isPending}
                            busyLabel="Deleting…"
                            onClick={() =>
                                deleteTask.mutate({
                                    expectedVersion: task.data.version,
                                    id: task.data.id,
                                })
                            }
                            variant="danger"
                        >
                            <Icon icon={Trash2} size="sm" tone="inherit" />
                            Delete task
                        </Button>
                    </div>
                </div>
            )}
            {task.data !== undefined && !editing && !confirmingDelete && (
                <div>
                    <TaskMetadataControls task={task.data} />
                    {task.data.automation !== undefined && (
                        <TaskAutomationSummary automation={task.data.automation} />
                    )}
                    <div className="border-primary-700 bg-primary-900/40 mt-5 rounded-lg border p-4">
                        {task.data.bodyMarkdown === undefined ? (
                            <Text tone="muted">No task description.</Text>
                        ) : (
                            <Markdown source={task.data.bodyMarkdown} />
                        )}
                    </div>
                    <div className="mt-5 flex justify-end gap-2">
                        <Button
                            onClick={() => setConfirmingDelete(true)}
                            variant="danger"
                        >
                            <Icon icon={Trash2} size="sm" tone="inherit" />
                            Delete
                        </Button>
                        <Button onClick={() => setEditing(true)} variant="secondary">
                            <Icon icon={Pencil} size="sm" tone="inherit" />
                            Edit
                        </Button>
                    </div>
                    <TaskProgressSection taskId={taskId} />
                </div>
            )}
        </Modal>
    );
}
