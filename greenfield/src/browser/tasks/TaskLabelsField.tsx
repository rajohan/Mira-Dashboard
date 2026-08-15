import { taskMaximumLabels } from "../../contracts/taskModel.ts";
import { firstFormFieldError } from "../ui/formErrors.ts";
import { FormField } from "../ui/FormField.tsx";
import { TagInput } from "../ui/TagInput.tsx";
import type { TaskEditorFormApi } from "./useTaskEditorController.ts";

interface TaskLabelsFieldProps {
    readonly availableLabels?: readonly string[];
    readonly busy: boolean;
    readonly form: TaskEditorFormApi;
}

function labelsFromEditorValue(value: string): readonly string[] {
    return value
        .split(/\r?\n/u)
        .map((label) => label.trim())
        .filter((label) => label.length > 0);
}

/** @returns A token-based task-label editor backed by the form's canonical text value. */
export function TaskLabelsField({
    availableLabels = [],
    busy,
    form,
}: TaskLabelsFieldProps) {
    return (
        <form.Field name="labelsText">
            {(field) => (
                <FormField
                    description="Press Enter to add a label."
                    disabled={busy}
                    error={firstFormFieldError(field.state.meta.errors)}
                    label="Labels (optional)"
                >
                    <TagInput
                        ariaLabel="Labels"
                        className="mt-2"
                        disabled={busy}
                        maxTags={taskMaximumLabels}
                        name={field.name}
                        onBlur={field.handleBlur}
                        onChange={(labels) =>
                            field.handleChange([...new Set(labels)].join("\n"))
                        }
                        placeholder="Add a label"
                        suggestions={availableLabels}
                        value={labelsFromEditorValue(field.state.value)}
                    />
                </FormField>
            )}
        </form.Field>
    );
}
