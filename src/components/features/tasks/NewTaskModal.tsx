import { Loader2, Plus, X } from "lucide-react";
import { useForm } from "@tanstack/react-form";

import { Button } from "../../ui/Button";
import { Input } from "../../ui/Input";
import { Modal } from "../../ui/Modal";
import { Textarea } from "../../ui/Textarea";

const PRIORITY_COLORS: Record<string, string> = {
    high: "bg-red-500/20 text-red-400 border-red-500/30",
    medium: "bg-purple-500/20 text-purple-400 border-purple-500/30",
    low: "bg-slate-500/20 text-slate-400 border-slate-500/30",
};

interface NewTaskModalProps {
    isOpen: boolean;
    onClose: () => void;
    onSubmit: (title: string, body?: string, priority?: "high" | "medium" | "low") => Promise<void>;
}

export function NewTaskModal({ isOpen, onClose, onSubmit }: NewTaskModalProps) {
    const form = useForm({
        defaultValues: {
            title: "",
            body: "",
            priority: "medium" as "high" | "medium" | "low",
        },
        onSubmit: async ({ value }) => {
            if (!value.title.trim()) return;
            const trimmedBody = value.body.trim();
            await onSubmit(value.title.trim(), trimmedBody || undefined, value.priority);
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
                    <h2 className="text-lg font-semibold text-slate-100">New Task</h2>
                    <Button variant="ghost" size="sm" type="button" onClick={onClose} className="text-slate-400 hover:text-slate-200">
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
                            <label className="mb-1.5 block text-sm font-medium text-slate-300">
                                Priority
                            </label>
                            <div className="flex gap-2">
                                {(["low", "medium", "high"] as const).map((p) => (
                                    <Button
                                        key={p}
                                        variant={field.state.value === p ? "primary" : "secondary"}
                                        type="button"
                                        onClick={() => field.handleChange(p)}
                                        className={
                                            field.state.value === p
                                                ? PRIORITY_COLORS[p] + " border-current"
                                                : ""
                                        }
                                    >
                                        {p.charAt(0).toUpperCase() + p.slice(1)}
                                    </Button>
                                ))}
                            </div>
                        </div>
                    )}
                </form.Field>

                <div className="flex justify-end gap-2 pt-2">
                    <Button
                        type="button"
                        variant="secondary"
                        onClick={onClose}
                        disabled={form.state.isSubmitting}
                    >
                        Cancel
                    </Button>
                    <Button
                        type="submit"
                        variant="primary"
                        disabled={!form.state.values.title.trim() || form.state.isSubmitting}
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