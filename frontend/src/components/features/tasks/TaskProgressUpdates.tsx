import { Pencil, Plus, Save, Trash2, X } from "lucide-react";
import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { TASK_ASSIGNEES, type TaskUpdate } from "../../../../../contracts/tasks";
import { formatDate } from "../../../utils/format";
import { Button } from "../../ui/Button";
import { Textarea } from "../../ui/Textarea";

interface TaskProgressUpdatesProperties {
    onAddUpdate: (messageMd: string) => Promise<void>;
    onDeleteUpdate: (updateId: number) => void;
    onEditUpdate: (updateId: number, messageMd: string) => Promise<void>;
    updates: TaskUpdate[];
}

/**
 * Renders and owns the task progress-update editor and timeline.
 * @returns Task progress editor and update timeline.
 */
export function TaskProgressUpdates({
    onAddUpdate,
    onDeleteUpdate,
    onEditUpdate,
    updates,
}: TaskProgressUpdatesProperties) {
    const [progressMessage, setProgressMessage] = useState("");
    const [editingUpdateId, setEditingUpdateId] = useState<number | undefined>();
    const [editingUpdateMessage, setEditingUpdateMessage] = useState("");
    const trimmedProgressMessage = progressMessage.trim();
    const trimmedEditingUpdateMessage = editingUpdateMessage.trim();

    const handleAddUpdate = async () => {
        if (!trimmedProgressMessage) return;
        await onAddUpdate(trimmedProgressMessage);
        setProgressMessage("");
    };

    const startEditUpdate = (update: TaskUpdate) => {
        setEditingUpdateId(update.id);
        setEditingUpdateMessage(update.messageMd);
    };

    const saveUpdateEdit = async () => {
        if (!editingUpdateId || !trimmedEditingUpdateMessage) return;
        await onEditUpdate(editingUpdateId, trimmedEditingUpdateMessage);
        setEditingUpdateId(undefined);
        setEditingUpdateMessage("");
    };

    return (
        <div className="rounded-lg border border-primary-700 bg-primary-800/30 p-4">
            <h3 className="mb-2 text-sm font-semibold text-primary-300">
                Progress updates
            </h3>
            <div className="mb-3 space-y-2">
                {updates.length === 0 ? (
                    <p className="text-sm text-primary-500">No updates yet.</p>
                ) : (
                    updates.map((update) => {
                        const authorMeta =
                            TASK_ASSIGNEES[
                                update.author === TASK_ASSIGNEES.mira.id
                                    ? "mira"
                                    : "raymond"
                            ];
                        const isEditingThis = editingUpdateId === update.id;

                        return (
                            <div
                                key={update.id}
                                className="rounded border border-primary-700 bg-primary-900/40 p-2"
                            >
                                <div className="mb-1 flex flex-col gap-2 text-xs text-primary-500 sm:flex-row sm:items-center sm:justify-between">
                                    <span className="min-w-0 wrap-break-word">
                                        <a
                                            href={authorMeta.githubUrl}
                                            target="_blank"
                                            rel="noreferrer"
                                        >
                                            @{authorMeta.id}
                                        </a>{" "}
                                        · {formatDate(update.createdAt)}
                                    </span>
                                    <div className="grid grid-cols-2 gap-2 sm:flex">
                                        <Button
                                            size="sm"
                                            variant="ghost"
                                            aria-label={`Edit progress update #${update.id}`}
                                            onClick={() => startEditUpdate(update)}
                                        >
                                            <Pencil className="size-4" />
                                            Edit
                                        </Button>
                                        <Button
                                            size="sm"
                                            variant="ghost"
                                            aria-label={`Delete progress update #${update.id}`}
                                            onClick={() => onDeleteUpdate(update.id)}
                                        >
                                            <Trash2 className="size-4" />
                                            Delete
                                        </Button>
                                    </div>
                                </div>

                                {isEditingThis ? (
                                    <div className="space-y-2">
                                        <Textarea
                                            aria-label={`Message for progress update #${update.id}`}
                                            value={editingUpdateMessage}
                                            onChange={(event) =>
                                                setEditingUpdateMessage(
                                                    event.target.value
                                                )
                                            }
                                            rows={3}
                                        />
                                        <div className="grid grid-cols-1 gap-2 sm:flex">
                                            <Button
                                                size="sm"
                                                variant="primary"
                                                onClick={() => {
                                                    void saveUpdateEdit();
                                                }}
                                                disabled={!trimmedEditingUpdateMessage}
                                            >
                                                <Save className="size-4" />
                                                Save
                                            </Button>
                                            <Button
                                                size="sm"
                                                variant="secondary"
                                                onClick={() =>
                                                    setEditingUpdateId(undefined)
                                                }
                                            >
                                                <X className="size-4" />
                                                Cancel
                                            </Button>
                                        </div>
                                    </div>
                                ) : (
                                    <div className="prose max-w-none text-sm prose-invert prose-p:my-1">
                                        <ReactMarkdown remarkPlugins={[remarkGfm]}>
                                            {update.messageMd}
                                        </ReactMarkdown>
                                    </div>
                                )}
                            </div>
                        );
                    })
                )}
            </div>

            <div className="space-y-2">
                <Textarea
                    label="Add progress update"
                    value={progressMessage}
                    onChange={(event) => setProgressMessage(event.target.value)}
                    rows={3}
                    placeholder="Markdown supported"
                />
                <Button
                    variant="secondary"
                    onClick={() => {
                        void handleAddUpdate();
                    }}
                    disabled={!trimmedProgressMessage}
                    className="w-full sm:w-auto"
                >
                    <Plus className="size-4" />
                    Add Update
                </Button>
            </div>
        </div>
    );
}
