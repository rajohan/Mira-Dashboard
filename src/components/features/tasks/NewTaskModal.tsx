import { useForm } from "@tanstack/react-form";
import { Loader2, Plus, X } from "lucide-react";

import { TASK_ASSIGNEES, type TaskAssigneeId } from "../../../constants/taskActors";
import { PRIORITY_COLORS } from "../../../utils/taskUtils";
import { Button } from "../../ui/Button";
import { Input } from "../../ui/Input";
import { Modal } from "../../ui/Modal";
import { Textarea } from "../../ui/Textarea";

interface NewTaskModalProps {
    isOpen: boolean;
    onClose: () => void;
    onSubmit: (
        title: string,
        body?: string,
        priority?: "high" | "medium" | "low",
        assignee?: TaskAssigneeId
    ) => Promise<void>;
}

export function NewTaskModal({ isOpen, onClose, onSubmit }: NewTaskModalProps) {
    const form = useForm({
        defaultValues: {
            title: "",
            body: "",
            priority: "medium" as "high" | "medium" | "low",
            assignee: TASK_ASSIGNEES.mira.id as TaskAssigneeId,
        },
        onSubmit: async ({ value }) => {
            if (!value.title.trim()) return;
            const trimmedBody = value.body.trim();
            await onSubmit(
                value.title.trim(),
                trimmedBody || undefined,
                value.priority,
                value.assignee
            );
            form.reset();
            onClose();
        },
    });

    return (
        <Modal isOpen={isOpen} onClose={onClose} size="lg">
            <form
                onSubmit={(e) => {
                    e.preventDefault();
                    form.handleSubmit();
                }}
                className="space-y-4"
            >
                <div className="flex items-center justify-between">
                    <h2 className="text-lg font-semibold text-primary-100">New Task</h2>
                    <Button
                        variant="ghost"
                        size="sm"
                        type="button"
                        onClick={onClose}
                        className="text-primary-400 hover:text-primary-200"
                    >
                        <X className="h-5 w-5" />
                    </Button>
                </div>

                <form.Field name="title">
                    {(field) => (
                        <Input
                            label="Title"
                            type="text"
                            value={field.state.value}
                            onChange={(e) => field.handleChange(e.target.value)}
                            placeholder="Task title..."
                            autoFocus
                        />
                    )}
                </form.Field>

                <form.Field name="body">
                    {(field) => (
                        <Textarea
                            label="Description (optional)"
                            value={field.state.value}
                            onChange={(e) => field.handleChange(e.target.value)}
                            placeholder="Task description..."
                            rows={4}
                            className="resize-none"
                        />
                    )}
                </form.Field>

                <form.Field name="priority">
                    {(field) => (
                        <div>
                            <label className="mb-1.5 block text-sm font-medium text-primary-300">
                                Priority
                            </label>
                            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                                {(["low", "medium", "high"] as const).map((p) => (
                                    <Button
                                        key={p}
                                        variant={
                                            field.state.value === p
                                                ? "primary"
                                                : "secondary"
                                        }
                                        type="button"
                                        onClick={() => field.handleChange(p)}
                                        className={
                                            "w-full " +
                                            (field.state.value === p
                                                ? PRIORITY_COLORS[p] + " border-current"
                                                : "")
                                        }
                                    >
                                        {p.charAt(0).toUpperCase() + p.slice(1)}
                                    </Button>
                                ))}
                            </div>
                        </div>
                    )}
                </form.Field>

                <form.Field name="assignee">
                    {(field) => (
                        <div>
                            <label className="mb-1.5 block text-sm font-medium text-primary-300">
                                Assignee
                            </label>
                            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                                <Button
                                    type="button"
                                    variant={
                                        field.state.value === TASK_ASSIGNEES.mira.id
                                            ? "primary"
                                            : "secondary"
                                    }
                                    onClick={() =>
                                        field.handleChange(TASK_ASSIGNEES.mira.id)
                                    }
                                    className="w-full"
                                >
                                    Mira
                                </Button>
                                <Button
                                    type="button"
                                    variant={
                                        field.state.value === TASK_ASSIGNEES.raymond.id
                                            ? "primary"
                                            : "secondary"
                                    }
                                    onClick={() =>
                                        field.handleChange(TASK_ASSIGNEES.raymond.id)
                                    }
                                    className="w-full"
                                >
                                    Raymond
                                </Button>
                            </div>
                        </div>
                    )}
                </form.Field>

                <div className="grid grid-cols-1 gap-2 pt-2 sm:flex sm:justify-end">
                    <Button
                        type="button"
                        variant="secondary"
                        onClick={onClose}
                        disabled={form.state.isSubmitting}
                        className="w-full sm:w-auto"
                    >
                        Cancel
                    </Button>
                    <Button
                        type="submit"
                        variant="primary"
                        disabled={form.state.isSubmitting}
                        className="w-full sm:w-auto"
                    >
                        {form.state.isSubmitting ? (
                            <>
                                <Loader2 className="h-4 w-4 animate-spin" />
                                Creating...
                            </>
                        ) : (
                            <>
                                <Plus className="h-4 w-4" />
                                Create Task
                            </>
                        )}
                    </Button>
                </div>
            </form>
        </Modal>
    );
}
