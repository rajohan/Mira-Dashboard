import { useForm } from "@tanstack/react-form";
import { useRef } from "react";
import * as v from "valibot";

import type { TaskDetail } from "../../contracts/taskModel.ts";
import {
    createTaskInputFromEditor,
    taskEditorFormSchema,
    taskEditorValues,
    updateTaskInputFromEditor,
} from "./taskEditorForm.ts";
import { useTaskMutation } from "./taskMutations.ts";

interface TaskEditorControllerOptions {
    readonly onSaved: (task: TaskDetail) => void;
    readonly task?: TaskDetail;
}

/**
 * Owns task-editor validation, mutation state, and completed-submit sequencing.
 * @returns The form API and its mutation lifecycle.
 */
export function useTaskEditorController({ onSaved, task }: TaskEditorControllerOptions) {
    const createTask = useTaskMutation("tasks.create");
    const updateTask = useTaskMutation("tasks.update");
    const savedTask = useRef<TaskDetail | undefined>(undefined);
    const form = useForm({
        defaultValues: taskEditorValues(task),
        onSubmit: async ({ value }) => {
            const parsed = v.parse(taskEditorFormSchema, value);
            savedTask.current =
                task === undefined
                    ? await createTask.mutateAsync(createTaskInputFromEditor(parsed))
                    : await updateTask.mutateAsync(
                          updateTaskInputFromEditor(task, parsed)
                      );
        },
        validators: { onSubmit: taskEditorFormSchema },
    });

    async function submit(): Promise<void> {
        try {
            await form.handleSubmit();
            const saved = savedTask.current;
            savedTask.current = undefined;
            if (saved !== undefined) onSaved(saved);
        } catch {
            savedTask.current = undefined;
        }
    }

    return {
        busy: createTask.isPending || updateTask.isPending,
        failure: createTask.error ?? updateTask.error,
        form,
        submit,
    } as const;
}

export type TaskEditorFormApi = ReturnType<typeof useTaskEditorController>["form"];
