import type {
    TaskAssigneeId,
    TaskDetail,
    TaskStatus,
} from "../../contracts/taskModel.ts";
import { taskAssignees } from "../../contracts/taskModel.ts";
import { dashboardBrowserFailureMessage } from "../api/trpcError.ts";
import { Alert } from "../ui/Alert.tsx";
import { FormField } from "../ui/FormField.tsx";
import { Select, type SelectOption } from "../ui/Select.tsx";
import { unassignedTaskOwner } from "./taskEditorForm.ts";
import { useTaskMutation } from "./taskMutations.ts";

type EditorAssignee = TaskAssigneeId | typeof unassignedTaskOwner;

const statusOptions: readonly SelectOption<TaskStatus>[] = Object.freeze([
    { label: "To do", value: "todo" },
    { label: "In progress", value: "in-progress" },
    { label: "Blocked", value: "blocked" },
    { label: "Done", value: "done" },
]);
const assigneeOptions: readonly SelectOption<EditorAssignee>[] = Object.freeze([
    { label: "Unassigned", value: unassignedTaskOwner },
    ...taskAssignees.map(({ id, label }) => ({ label, value: id })),
]);

interface TaskMetadataControlsProps {
    readonly task: TaskDetail;
}

/** @returns Independently audited task status and assignment controls. */
export function TaskMetadataControls({ task }: TaskMetadataControlsProps) {
    const moveTask = useTaskMutation("tasks.move");
    const assignTask = useTaskMutation("tasks.assign");
    const busy = moveTask.isPending || assignTask.isPending;
    const failure = moveTask.error ?? assignTask.error;

    return (
        <div>
            <Alert
                className="mb-4"
                message={
                    failure === null ? undefined : dashboardBrowserFailureMessage(failure)
                }
            />
            <div className="grid gap-4 sm:grid-cols-2">
                <FormField disabled={busy} label="Status">
                    <Select
                        className="mt-2"
                        disabled={busy}
                        onChange={(status) =>
                            moveTask.mutate({
                                expectedVersion: task.version,
                                id: task.id,
                                status,
                            })
                        }
                        options={statusOptions}
                        value={task.status}
                    />
                </FormField>
                <FormField disabled={busy} label="Assignee">
                    <Select
                        className="mt-2"
                        disabled={busy}
                        onChange={(assignee) =>
                            assignTask.mutate({
                                assignee:
                                    assignee === unassignedTaskOwner ? null : assignee,
                                expectedVersion: task.version,
                                id: task.id,
                            })
                        }
                        options={assigneeOptions}
                        value={task.assignee ?? unassignedTaskOwner}
                    />
                </FormField>
            </div>
        </div>
    );
}
