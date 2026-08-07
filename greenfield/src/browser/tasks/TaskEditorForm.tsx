import { Save, Sparkles } from "lucide-react";

import type { TaskDetail } from "../../contracts/taskModel.ts";
import { dashboardBrowserFailureMessage } from "../api/trpcError.ts";
import { Alert } from "../ui/Alert.tsx";
import { Button } from "../ui/Button.tsx";
import { Form } from "../ui/Form.tsx";
import { Icon } from "../ui/Icon.tsx";
import { TaskAutomationFields } from "./TaskAutomationFields.tsx";
import { TaskEditorFields } from "./TaskEditorFields.tsx";
import { useTaskEditorController } from "./useTaskEditorController.ts";

interface TaskEditorFormProps {
    readonly onCancel: () => void;
    readonly onSaved: (task: TaskDetail) => void;
    readonly task?: TaskDetail;
}

/**
 * Renders the shared TanStack Form editor for task creation and content updates.
 * @returns A contract-validated task editor.
 */
export function TaskEditorForm({ onCancel, onSaved, task }: TaskEditorFormProps) {
    const { busy, failure, form, submit } = useTaskEditorController({
        onSaved,
        task,
    });
    const creating = task === undefined;

    return (
        <Form onSubmit={submit}>
            <Alert
                className="mb-4"
                message={
                    failure === null ? undefined : dashboardBrowserFailureMessage(failure)
                }
            />
            <TaskEditorFields busy={busy} creating={creating} form={form} />
            <TaskAutomationFields busy={busy} form={form} />
            <div className="mt-5 flex justify-end gap-2">
                <Button disabled={busy} onClick={onCancel} variant="secondary">
                    Cancel
                </Button>
                <form.Subscribe
                    selector={(state) => [state.canSubmit, state.isSubmitting] as const}
                >
                    {([canSubmit, isSubmitting]) => (
                        <Button
                            busy={busy || isSubmitting}
                            busyLabel={creating ? "Creating…" : "Saving…"}
                            disabled={!canSubmit}
                            type="submit"
                        >
                            <Icon
                                icon={creating ? Sparkles : Save}
                                size="sm"
                                tone="inherit"
                            />
                            {creating ? "Create task" : "Save changes"}
                        </Button>
                    )}
                </form.Subscribe>
            </div>
        </Form>
    );
}
