import {
    taskAssignees,
    type TaskAssigneeId,
    type TaskPriority,
    type TaskStatus,
} from "../../contracts/taskModel.ts";
import { cn } from "../lib/classNames.ts";
import { Button } from "../ui/Button.tsx";
import { ExpandableCard } from "../ui/ExpandableCard.tsx";
import { Fieldset } from "../ui/Fieldset.tsx";
import { firstFormFieldError } from "../ui/formErrors.ts";
import { FormField } from "../ui/FormField.tsx";
import { Input } from "../ui/Input.tsx";
import { Select, type SelectOption } from "../ui/Select.tsx";
import { Textarea } from "../ui/Textarea.tsx";
import { unassignedTaskOwner } from "./taskEditorForm.ts";
import { TaskLabelsField } from "./TaskLabelsField.tsx";
import type { TaskEditorFormApi } from "./useTaskEditorController.ts";

type EditorAssignee = TaskAssigneeId | typeof unassignedTaskOwner;

const priorityOptions = Object.freeze([
    { label: "Low", value: "low" },
    { label: "Medium", value: "medium" },
    { label: "High", value: "high" },
] as const satisfies readonly { label: string; value: TaskPriority }[]);

const selectedPriorityClassNames: Readonly<Record<TaskPriority, string>> = Object.freeze({
    high: "border-red-500/50 bg-red-500/15 text-red-200 data-hover:bg-red-500/25 hover:bg-red-500/25",
    low: "border-emerald-500/50 bg-emerald-500/15 text-emerald-200 data-hover:bg-emerald-500/25 hover:bg-emerald-500/25",
    medium: "border-amber-500/50 bg-amber-500/15 text-amber-200 data-hover:bg-amber-500/25 hover:bg-amber-500/25",
});

const assigneeOptions = Object.freeze([
    { label: "Unassigned", value: unassignedTaskOwner },
    ...taskAssignees.map(({ id, label }) => ({ label, value: id })),
] as const satisfies readonly { label: string; value: EditorAssignee }[]);

const statusOptions: readonly SelectOption<TaskStatus>[] = Object.freeze([
    { label: "To do", value: "todo" },
    { label: "In progress", value: "in-progress" },
    { label: "Blocked", value: "blocked" },
    { label: "Done", value: "done" },
]);

interface TaskCreateFieldsProps {
    readonly availableLabels: readonly string[];
    readonly busy: boolean;
    readonly creating: boolean;
    readonly form: TaskEditorFormApi;
}

/** @returns Legacy-aligned primary fields shared by task creation and editing. */
export function TaskCreateFields({
    availableLabels,
    busy,
    creating,
    form,
}: TaskCreateFieldsProps) {
    return (
        <div className="space-y-4">
            <form.Field name="title">
                {(field) => (
                    <FormField
                        disabled={busy}
                        error={firstFormFieldError(field.state.meta.errors)}
                        label="Title"
                    >
                        <Input
                            className="mt-2"
                            data-autofocus
                            name={field.name}
                            onBlur={field.handleBlur}
                            onChange={(event) =>
                                field.handleChange(event.currentTarget.value)
                            }
                            placeholder="Task title"
                            required
                            value={field.state.value}
                        />
                    </FormField>
                )}
            </form.Field>
            <form.Field name="bodyMarkdown">
                {(field) => (
                    <FormField
                        disabled={busy}
                        error={firstFormFieldError(field.state.meta.errors)}
                        label="Description (optional)"
                    >
                        <Textarea
                            className="mt-2 min-h-28 resize-none"
                            name={field.name}
                            onBlur={field.handleBlur}
                            onChange={(event) =>
                                field.handleChange(event.currentTarget.value)
                            }
                            placeholder="Task description"
                            rows={4}
                            value={field.state.value}
                        />
                    </FormField>
                )}
            </form.Field>
            <form.Field name="priority">
                {(field) => {
                    const error = firstFormFieldError(field.state.meta.errors);
                    return (
                        <Fieldset disabled={busy} error={error} legend="Priority">
                            <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-3">
                                {priorityOptions.map((option) => {
                                    const selected = field.state.value === option.value;
                                    return (
                                        <Button
                                            aria-pressed={selected}
                                            className={cn(
                                                "w-full border border-transparent",
                                                selected &&
                                                    selectedPriorityClassNames[
                                                        option.value
                                                    ]
                                            )}
                                            key={option.value}
                                            onClick={() =>
                                                field.handleChange(option.value)
                                            }
                                            variant="secondary"
                                        >
                                            {option.label}
                                        </Button>
                                    );
                                })}
                            </div>
                        </Fieldset>
                    );
                }}
            </form.Field>
            {creating && (
                <form.Field name="assignee">
                    {(field) => {
                        const error = firstFormFieldError(field.state.meta.errors);
                        return (
                            <Fieldset
                                className="pt-2"
                                disabled={busy}
                                error={error}
                                legend="Assignee"
                            >
                                <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-3">
                                    {assigneeOptions.map((option) => {
                                        const selected =
                                            field.state.value === option.value;
                                        return (
                                            <Button
                                                aria-pressed={selected}
                                                className="w-full"
                                                key={option.value}
                                                onClick={() =>
                                                    field.handleChange(option.value)
                                                }
                                                variant={
                                                    selected ? "primary" : "secondary"
                                                }
                                            >
                                                {option.label}
                                            </Button>
                                        );
                                    })}
                                </div>
                            </Fieldset>
                        );
                    }}
                </form.Field>
            )}
            <div className="mt-6">
                <ExpandableCard
                    className="bg-primary-900/30"
                    compact
                    defaultOpen={!creating}
                    description={
                        creating
                            ? "Set the initial status and optional labels."
                            : "Manage optional task labels."
                    }
                    title="Additional details (optional)"
                >
                    <div className="grid gap-4">
                        {creating && (
                            <form.Field name="status">
                                {(field) => (
                                    <FormField
                                        disabled={busy}
                                        error={firstFormFieldError(
                                            field.state.meta.errors
                                        )}
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
                        )}
                        <TaskLabelsField
                            availableLabels={availableLabels}
                            busy={busy}
                            form={form}
                        />
                    </div>
                </ExpandableCard>
            </div>
        </div>
    );
}
