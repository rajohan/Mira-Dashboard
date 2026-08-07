import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Bot, Pencil, Trash2, TriangleAlert } from "lucide-react";
import { useState } from "react";

import { useDashboardTrpcClient } from "../api/trpcContextValue.ts";
import { dashboardBrowserFailureMessage } from "../api/trpcError.ts";
import { Alert } from "../ui/Alert.tsx";
import { Badge } from "../ui/Badge.tsx";
import { Button } from "../ui/Button.tsx";
import { Icon } from "../ui/Icon.tsx";
import { LoadingState } from "../ui/LoadingState.tsx";
import { Markdown } from "../ui/Markdown.tsx";
import { Modal } from "../ui/Modal.tsx";
import { Text } from "../ui/Text.tsx";
import { TaskEditorForm } from "./TaskEditorForm.tsx";
import { TaskMetadataControls } from "./TaskMetadataControls.tsx";
import { useDeleteTaskMutation } from "./taskMutations.ts";
import { TaskProgressSection } from "./TaskProgressSection.tsx";
import { taskDetailQueryKey, taskDetailQueryOptions } from "./taskQueries.ts";

interface TaskDetailModalProps {
    readonly onClose: () => void;
    readonly taskId: string;
}

/** @returns Complete task detail, edit, progress, and deletion dialog. */
export function TaskDetailModal({ onClose, taskId }: TaskDetailModalProps) {
    const client = useDashboardTrpcClient();
    const queryClient = useQueryClient();
    const task = useQuery(taskDetailQueryOptions(client, taskId));
    const deleteTask = useDeleteTaskMutation(onClose);
    const [editing, setEditing] = useState(false);
    const [confirmingDelete, setConfirmingDelete] = useState(false);

    return (
        <Modal
            dismissible={!deleteTask.isPending}
            onClose={onClose}
            open
            size="lg"
            title={task.data?.title ?? "Task details"}
        >
            {task.isPending && <LoadingState label="Loading task…" />}
            {task.isError && (
                <Alert message={dashboardBrowserFailureMessage(task.error)} />
            )}
            {task.data !== undefined && editing && (
                <TaskEditorForm
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
                    <div className="mt-5 flex flex-wrap items-center gap-2">
                        <Badge>{task.data.priority} priority</Badge>
                        {task.data.labels.map((label) => (
                            <Badge key={label}>{label}</Badge>
                        ))}
                        {task.data.automation !== undefined && (
                            <Badge variant="info">
                                <Icon icon={Bot} size="sm" tone="inherit" />
                                {task.data.automation.scheduleSummary ??
                                    task.data.automation.cronJobId}
                            </Badge>
                        )}
                    </div>
                    <div className="border-primary-700 mt-5 border-t pt-5">
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
                            Edit content
                        </Button>
                    </div>
                    <TaskProgressSection taskId={taskId} />
                </div>
            )}
        </Modal>
    );
}
