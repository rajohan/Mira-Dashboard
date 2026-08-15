import { TaskCreateFields } from "./TaskCreateFields.tsx";
import type { TaskEditorFormApi } from "./useTaskEditorController.ts";

interface TaskEditorFieldsProps {
    readonly availableLabels: readonly string[];
    readonly busy: boolean;
    readonly creating: boolean;
    readonly form: TaskEditorFormApi;
}

/** @returns The general task fields shared by create and edit flows. */
export function TaskEditorFields({
    availableLabels,
    busy,
    creating,
    form,
}: TaskEditorFieldsProps) {
    return (
        <TaskCreateFields
            availableLabels={availableLabels}
            busy={busy}
            creating={creating}
            form={form}
        />
    );
}
