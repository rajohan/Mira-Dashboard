import {
    taskAssignees,
    type TaskAssigneeId,
    type TaskPriority,
    type TaskStatus,
} from "../../contracts/taskModel.ts";
import { firstFormFieldError } from "../ui/formErrors.ts";
import { FormField } from "../ui/FormField.tsx";
import { Input } from "../ui/Input.tsx";
import { Select, type SelectOption } from "../ui/Select.tsx";
import { Textarea } from "../ui/Textarea.tsx";
import { unassignedTaskOwner } from "./taskEditorForm.ts";
import type { TaskEditorFormApi } from "./useTaskEditorController.ts";

type EditorAssignee = TaskAssigneeId | typeof unassignedTaskOwner;

const priorityOptions: readonly SelectOption<TaskPriority>[] = Object.freeze([
    { label: "Low", value: "low" },
    { label: "Medium", value: "medium" },
    { label: "High", value: "high" },
]);
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

interface TaskEditorFieldsProps {
    readonly busy: boolean;
    readonly creating: boolean;
    readonly form: TaskEditorFormApi;
}

/** @returns The general task fields shared by create and edit flows. */
export function TaskEditorFields({ busy, creating, form }: TaskEditorFieldsProps) {
    return (
        <div className="grid gap-4 sm:grid-cols-2">
            <form.Field name="title">
                {(field) => (
                    <FormField
                        className="sm:col-span-2"
                        disabled={busy}
                        error={firstFormFieldError(field.state.meta.errors)}
                        label="Title"
                    >
                        <Input
                            className="mt-2"
                            name={field.name}
                            onBlur={field.handleBlur}
                            onChange={(event) =>
                                field.handleChange(event.currentTarget.value)
                            }
                            placeholder="Example: Review database backups"
                            required
                            value={field.state.value}
                        />
                    </FormField>
                )}
            </form.Field>
            {creating && (
                <>
                    <form.Field name="status">
                        {(field) => (
                            <FormField
                                disabled={busy}
                                error={firstFormFieldError(field.state.meta.errors)}
                                label="Status"
                            >
                                <Select
                                    className="mt-2"
                                    name={field.name}
                                    onChange={field.handleChange}
                                    options={statusOptions}
                                    value={field.state.value}
                                />
                            </FormField>
                        )}
                    </form.Field>
                    <form.Field name="assignee">
                        {(field) => (
                            <FormField
                                disabled={busy}
                                error={firstFormFieldError(field.state.meta.errors)}
                                label="Assignee"
                            >
                                <Select
                                    className="mt-2"
                                    name={field.name}
                                    onChange={field.handleChange}
                                    options={assigneeOptions}
                                    value={field.state.value}
                                />
                            </FormField>
                        )}
                    </form.Field>
                </>
            )}
            <form.Field name="priority">
                {(field) => (
                    <FormField
                        disabled={busy}
                        error={firstFormFieldError(field.state.meta.errors)}
                        label="Priority"
                    >
                        <Select
                            className="mt-2"
                            name={field.name}
                            onChange={field.handleChange}
                            options={priorityOptions}
                            value={field.state.value}
                        />
                    </FormField>
                )}
            </form.Field>
            <form.Field name="labelsText">
                {(field) => (
                    <FormField
                        description="One label per line. Commas remain part of a label."
                        disabled={busy}
                        error={firstFormFieldError(field.state.meta.errors)}
                        label="Labels"
                    >
                        <Textarea
                            className="mt-2 min-h-24"
                            name={field.name}
                            onBlur={field.handleBlur}
                            onChange={(event) =>
                                field.handleChange(event.currentTarget.value)
                            }
                            placeholder={"delivery\ndatabase"}
                            value={field.state.value}
                        />
                    </FormField>
                )}
            </form.Field>
            <form.Field name="bodyMarkdown">
                {(field) => (
                    <FormField
                        className="sm:col-span-2"
                        description="Markdown is rendered without raw HTML."
                        disabled={busy}
                        error={firstFormFieldError(field.state.meta.errors)}
                        label="Description"
                    >
                        <Textarea
                            className="mt-2 min-h-40"
                            name={field.name}
                            onBlur={field.handleBlur}
                            onChange={(event) =>
                                field.handleChange(event.currentTarget.value)
                            }
                            placeholder="Example: Check the latest backup report and resolve any warnings."
                            value={field.state.value}
                        />
                    </FormField>
                )}
            </form.Field>
        </div>
    );
}
