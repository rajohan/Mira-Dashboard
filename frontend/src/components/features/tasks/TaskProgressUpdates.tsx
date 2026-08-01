import { Pencil, Plus, Save, Trash2, X } from "lucide-react";
import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { TASK_ASSIGNEES, type TaskUpdate } from "../../../../../contracts/tasks";
import { messageFromError } from "../../../lib/errorMessage";
import { formatDate } from "../../../utils/format";
import { Alert } from "../../ui/Alert";
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
    const [isAddingUpdate, setIsAddingUpdate] = useState(false);
    const [isSavingUpdate, setIsSavingUpdate] = useState(false);
    const [submissionError, setSubmissionError] = useState<string | undefined>();
    const trimmedProgressMessage = progressMessage.trim();
    const trimmedEditingUpdateMessage = editingUpdateMessage.trim();

    const handleAddUpdate = async () => {
        if (!trimmedProgressMessage || isAddingUpdate) return;
        setIsAddingUpdate(true);
        setSubmissionError(undefined);
        try {
            await onAddUpdate(trimmedProgressMessage);
            setProgressMessage("");
        } catch (error) {
            setSubmissionError(messageFromError(error, "Failed to add progress update"));
        } finally {
            setIsAddingUpdate(false);
        }
    };

    const startEditUpdate = (update: TaskUpdate) => {
        setEditingUpdateId(update.id);
        setEditingUpdateMessage(update.messageMd);
    };

    const saveUpdateEdit = async () => {
        if (
            editingUpdateId === undefined ||
            !trimmedEditingUpdateMessage ||
            isSavingUpdate
        ) {
            return;
        }
        setIsSavingUpdate(true);
        setSubmissionError(undefined);
        try {
            await onEditUpdate(editingUpdateId, trimmedEditingUpdateMessage);
            setEditingUpdateId(undefined);
            setEditingUpdateMessage("");
        } catch (error) {
            setSubmissionError(messageFromError(error, "Failed to edit progress update"));
        } finally {
            setIsSavingUpdate(false);
        }
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
                        const authorMeta = Object.values(TASK_ASSIGNEES).find(
                            (assignee) => assignee.id === update.author
                        );
                        const isEditingThis = editingUpdateId === update.id;

                        return (
                            <div
                                key={update.id}
                                className="rounded border border-primary-700 bg-primary-900/40 p-2"
                            >
                                <div className="mb-1 flex flex-col gap-2 text-xs text-primary-500 sm:flex-row sm:items-center sm:justify-between">
                                    <span className="min-w-0 wrap-break-word">
                                        {authorMeta ? (
                                            <a
                                                href={authorMeta.githubUrl}
                                                target="_blank"
                                                rel="noreferrer"
                                            >
                                                @{authorMeta.id}
                                            </a>
                                        ) : (
                                            `@${update.author}`
                                        )}{" "}
                                        · {formatDate(update.createdAt)}
                                    </span>
                                    <div className="grid grid-cols-2 gap-2 sm:flex">
                                        <Button
                                            size="sm"
                                            variant="ghost"
                                            aria-label={`Edit progress update #${update.id}`}
                                            onClick={() => startEditUpdate(update)}
                                            disabled={isSavingUpdate}
                                        >
                                            <Pencil className="size-4" />
                                            Edit
                                        </Button>
                                        <Button
                                            size="sm"
                                            variant="ghost"
                                            aria-label={`Delete progress update #${update.id}`}
                                            onClick={() => onDeleteUpdate(update.id)}
                                            disabled={isSavingUpdate}
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
                                            disabled={isSavingUpdate}
                                        />
                                        <div className="grid grid-cols-1 gap-2 sm:flex">
                                            <Button
                                                size="sm"
                                                variant="primary"
                                                onClick={() => {
                                                    void saveUpdateEdit();
                                                }}
                                                disabled={
                                                    !trimmedEditingUpdateMessage ||
                                                    isSavingUpdate
                                                }
                                            >
                                                <Save className="size-4" />
                                                {isSavingUpdate ? "Saving..." : "Save"}
                                            </Button>
                                            <Button
                                                size="sm"
                                                variant="secondary"
                                                onClick={() =>
                                                    setEditingUpdateId(undefined)
                                                }
                                                disabled={isSavingUpdate}
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
                {submissionError ? (
                    <Alert
                        variant="error"
                        onDismiss={() => setSubmissionError(undefined)}
                    >
                        {submissionError}
                    </Alert>
                ) : undefined}
                <Textarea
                    label="Add progress update"
                    value={progressMessage}
                    onChange={(event) => setProgressMessage(event.target.value)}
                    rows={3}
                    placeholder="Markdown supported"
                    disabled={isAddingUpdate}
                />
                <Button
                    variant="secondary"
                    onClick={() => {
                        void handleAddUpdate();
                    }}
                    disabled={!trimmedProgressMessage || isAddingUpdate}
                    className="w-full sm:w-auto"
                >
                    <Plus className="size-4" />
                    {isAddingUpdate ? "Adding..." : "Add Update"}
                </Button>
            </div>
        </div>
    );
}
