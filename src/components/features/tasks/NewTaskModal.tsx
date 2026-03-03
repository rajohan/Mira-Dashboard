import { Loader2, Plus, X } from "lucide-react";
import { useState } from "react";
import type { SubmitEvent } from "react";

import { Button } from "../../ui/Button";
import { Input } from "../../ui/Input";
import { Modal } from "../../ui/Modal";

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
    const [title, setTitle] = useState("");
    const [body, setBody] = useState("");
    const [priority, setPriority] = useState<"high" | "medium" | "low">("medium");
    const [isSubmitting, setIsSubmitting] = useState(false);

    const handleSubmit = async (e: SubmitEvent<HTMLFormElement>) => {
        e.preventDefault();
        if (!title.trim()) return;

        setIsSubmitting(true);
        try {
            const trimmedBody = body.trim();
            await onSubmit(title.trim(), trimmedBody || undefined, priority);
            setTitle("");
            setBody("");
            setPriority("medium");
            onClose();
        } finally {
            setIsSubmitting(false);
        }
    };

    return (
        <Modal isOpen={isOpen} onClose={onClose} size="lg">
            <form onSubmit={handleSubmit} className="space-y-4">
                <div className="flex items-center justify-between">
                    <h2 className="text-lg font-semibold text-slate-100">New Task</h2>
                    <Button variant="ghost" size="sm" type="button" onClick={onClose} className="text-slate-400 hover:text-slate-200">
                        <X className="h-5 w-5" />
                    </Button>
                </div>

                <div>
                    <label className="mb-1.5 block text-sm font-medium text-slate-300">
                        Title
                    </label>
                    <Input
                        type="text"
                        value={title}
                        onChange={(e) => setTitle(e.target.value)}
                        placeholder="Task title..."
                        autoFocus
                    />
                </div>

                <div>
                    <label className="mb-1.5 block text-sm font-medium text-slate-300">
                        Description (optional)
                    </label>
                    <textarea
                        value={body}
                        onChange={(e) => setBody(e.target.value)}
                        placeholder="Task description..."
                        rows={4}
                        className="w-full resize-none rounded-lg border border-slate-600 bg-slate-700 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:border-accent-500 focus:outline-none"
                    />
                </div>

                <div>
                    <label className="mb-1.5 block text-sm font-medium text-slate-300">
                        Priority
                    </label>
                    <div className="flex gap-2">
                        {(["low", "medium", "high"] as const).map((p) => (
                            <Button
                                key={p}
                                variant={priority === p ? "primary" : "secondary"}
                                type="button"
                                onClick={() => setPriority(p)}
                                className={
                                    priority === p
                                        ? PRIORITY_COLORS[p] + " border-current"
                                        : ""
                                }
                            >
                                {p.charAt(0).toUpperCase() + p.slice(1)}
                            </Button>
                        ))}
                    </div>
                </div>

                <div className="flex justify-end gap-2 pt-2">
                    <Button
                        type="button"
                        variant="secondary"
                        onClick={onClose}
                        disabled={isSubmitting}
                    >
                        Cancel
                    </Button>
                    <Button
                        type="submit"
                        variant="primary"
                        disabled={!title.trim() || isSubmitting}
                    >
                        {isSubmitting ? (
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