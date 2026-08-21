import { useForm } from "@tanstack/react-form";
import { Send, Save } from "lucide-react";
import { useRef } from "react";
import * as v from "valibot";

import { taskProgressMarkdownSchema } from "../../contracts/taskModel.ts";
import { Button } from "../ui/Button.tsx";
import { Form } from "../ui/Form.tsx";
import { firstFormFieldError } from "../ui/formErrors.ts";
import { FormField } from "../ui/FormField.tsx";
import { Icon } from "../ui/Icon.tsx";
import { Textarea } from "../ui/Textarea.tsx";

const taskProgressFormSchema = v.strictObject({
    messageMarkdown: taskProgressMarkdownSchema,
});

interface TaskProgressFormProps {
    readonly busy: boolean;
    readonly initialValue?: string;
    readonly onCancel?: () => void;
    readonly onSubmit: (messageMarkdown: string) => Promise<void>;
    readonly onSubmitted?: () => void;
    readonly submitLabel?: string;
}

/** @returns Shared TanStack Form editor for new and existing progress entries. */
export function TaskProgressForm({
    busy,
    initialValue = "",
    onCancel,
    onSubmit,
    onSubmitted,
    submitLabel = "Add update",
}: TaskProgressFormProps) {
    const submitted = useRef(false);
    const form = useForm({
        defaultValues: { messageMarkdown: initialValue },
        onSubmit: async ({ formApi, value }) => {
            await onSubmit(value.messageMarkdown);
            submitted.current = true;
            formApi.setFieldValue("messageMarkdown", "");
        },
        validators: { onSubmit: taskProgressFormSchema },
    });
    const editing = onCancel !== undefined;

    async function submitForm(): Promise<void> {
        try {
            await form.handleSubmit();
            if (submitted.current) onSubmitted?.();
            submitted.current = false;
        } catch {
            submitted.current = false;
        }
    }

    return (
        <Form onSubmit={submitForm}>
            <form.Field name="messageMarkdown">
                {(field) => (
                    <FormField
                        disabled={busy}
                        error={firstFormFieldError(field.state.meta.errors)}
                        label={editing ? "Edit progress update" : "New progress update"}
                    >
                        <Textarea
                            className="mt-2 min-h-24"
                            name={field.name}
                            onBlur={field.handleBlur}
                            onChange={(event) =>
                                field.handleChange(event.currentTarget.value)
                            }
                            placeholder="Record the latest progress…"
                            value={field.state.value}
                        />
                    </FormField>
                )}
            </form.Field>
            <div className="mt-3 flex justify-end gap-2">
                {onCancel !== undefined && (
                    <Button disabled={busy} onClick={onCancel} size="sm" variant="ghost">
                        Cancel
                    </Button>
                )}
                <form.Subscribe
                    selector={(state) => [state.canSubmit, state.isSubmitting] as const}
                >
                    {([canSubmit, isSubmitting]) => (
                        <Button
                            busy={busy || isSubmitting}
                            busyLabel="Saving…"
                            disabled={!canSubmit}
                            size="sm"
                            type="submit"
                        >
                            <Icon icon={editing ? Save : Send} size="sm" tone="inherit" />
                            {submitLabel}
                        </Button>
                    )}
                </form.Subscribe>
            </div>
        </Form>
    );
}
