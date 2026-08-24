import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Pencil, Trash2 } from "lucide-react";
import { useState } from "react";

import type { TaskProgressUpdate } from "../../contracts/taskModel.ts";
import {
    liveHistoryRowIdentity,
    useAccumulatedLiveHistoryRows,
} from "../api/liveHistory.ts";
import { useDashboardTrpcClient } from "../api/trpcContextValue.ts";
import { dashboardBrowserFailureMessage } from "../api/trpcError.ts";
import { formatDashboardDateTimeToMinute } from "../lib/formatDateTime.ts";
import { Alert } from "../ui/Alert.tsx";
import { Button } from "../ui/Button.tsx";
import { ConfirmModal } from "../ui/ConfirmModal.tsx";
import { EmptyState } from "../ui/EmptyState.tsx";
import { Heading } from "../ui/Heading.tsx";
import { IconOnlyButton } from "../ui/IconOnlyButton.tsx";
import { LoadingState } from "../ui/LoadingState.tsx";
import { Markdown } from "../ui/Markdown.tsx";
import { Text } from "../ui/Text.tsx";
import { useTaskMutation } from "./taskMutations.ts";
import { TaskProgressForm } from "./TaskProgressForm.tsx";
import {
    taskProgressLiveHeadQueryOptions,
    taskProgressQueryOptions,
} from "./taskQueries.ts";

function taskProgressAuthorLabel(update: TaskProgressUpdate): string {
    return update.author.kind === "user"
        ? `@${update.author.username}`
        : `Automation · ${update.author.label}`;
}

interface TaskProgressEntryProps {
    readonly busy: boolean;
    readonly editing: boolean;
    readonly onCancelEdit: () => void;
    readonly onDelete: () => void;
    readonly onEdit: () => void;
    readonly onSave: (messageMarkdown: string) => Promise<void>;
    readonly update: TaskProgressUpdate;
}

function TaskProgressEntry({
    busy,
    editing,
    onCancelEdit,
    onDelete,
    onEdit,
    onSave,
    update,
}: TaskProgressEntryProps) {
    return (
        <li className="border-primary-700 bg-primary-900/40 rounded border p-3">
            <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                    <Text
                        className="wrap-break-word"
                        size="sm"
                        title={`Audit identity: ${update.author.kind}:${update.author.id}`}
                    >
                        {taskProgressAuthorLabel(update)} ·{" "}
                        <time dateTime={new Date(update.createdAtMs).toISOString()}>
                            {formatDashboardDateTimeToMinute(update.createdAtMs)}
                        </time>
                    </Text>
                </div>
                {!editing && (
                    <div className="flex shrink-0 gap-1">
                        <IconOnlyButton
                            disabled={busy}
                            icon={Pencil}
                            label="Edit progress update"
                            onClick={onEdit}
                            size="sm"
                            variant="ghost"
                        />
                        <IconOnlyButton
                            disabled={busy}
                            icon={Trash2}
                            label="Delete progress update"
                            onClick={onDelete}
                            size="sm"
                            variant="ghost"
                        />
                    </div>
                )}
            </div>
            {editing ? (
                <div className="mt-3">
                    <TaskProgressForm
                        busy={busy}
                        initialValue={update.messageMarkdown}
                        onCancel={onCancelEdit}
                        onSubmit={onSave}
                        onSubmitted={onCancelEdit}
                        submitLabel="Save update"
                    />
                </div>
            ) : (
                <Markdown className="mt-3" source={update.messageMarkdown} />
            )}
        </li>
    );
}

interface TaskProgressSectionProps {
    readonly taskId: string;
}

/** @returns Complete paginated task-progress CRUD surface. */
export function TaskProgressSection({ taskId }: TaskProgressSectionProps) {
    const client = useDashboardTrpcClient();
    const progress = useInfiniteQuery(taskProgressQueryOptions(client, taskId));
    const progressLiveHead = useQuery(taskProgressLiveHeadQueryOptions(client, taskId));
    const addProgress = useTaskMutation("tasks.addUpdate");
    const updateProgress = useTaskMutation("tasks.updateProgress");
    const deleteProgress = useTaskMutation("tasks.deleteProgress");
    const [editingId, setEditingId] = useState<string>();
    const [pendingDelete, setPendingDelete] = useState<TaskProgressUpdate>();
    const [evictedUpdateIds, setEvictedUpdateIds] = useState<ReadonlySet<string>>(
        () => new Set()
    );
    const archiveFirstPageResetKey = JSON.stringify(progress.data?.pages[0]);
    const updates = useAccumulatedLiveHistoryRows(
        progressLiveHead.data?.updates ?? [],
        progress.data?.pages.flatMap((page) => page.updates) ?? [],
        liveHistoryRowIdentity,
        taskId,
        evictedUpdateIds,
        archiveFirstPageResetKey
    );
    const progressFailure = progressLiveHead.error ?? progress.error;
    const failure =
        progressFailure ??
        addProgress.error ??
        updateProgress.error ??
        deleteProgress.error;
    const busy =
        addProgress.isPending || updateProgress.isPending || deleteProgress.isPending;

    return (
        <section aria-labelledby="task-progress-heading" className="mt-8">
            <Heading id="task-progress-heading" level={2}>
                Progress
            </Heading>
            <Text className="mt-1" tone="muted">
                Authenticated progress notes remain versioned and auditable.
            </Text>
            <Alert
                action={
                    progressFailure === null ? undefined : (
                        <Button
                            busy={progressLiveHead.isFetching || progress.isFetching}
                            onClick={() =>
                                void Promise.allSettled([
                                    progressLiveHead.refetch(),
                                    progress.refetch(),
                                ])
                            }
                            size="sm"
                            variant="secondary"
                        >
                            Try again
                        </Button>
                    )
                }
                className="mt-4"
                message={
                    failure === null ? undefined : dashboardBrowserFailureMessage(failure)
                }
            />
            <div className="mt-4">
                <TaskProgressForm
                    busy={busy}
                    onSubmit={async (messageMarkdown) => {
                        await addProgress.mutateAsync({ messageMarkdown, taskId });
                    }}
                />
            </div>
            {progress.isPending && (
                <LoadingState label="Loading task progress…" size="sm" />
            )}
            {progress.isSuccess && updates.length === 0 && (
                <EmptyState
                    className="mt-5"
                    description="Add an update when work begins or circumstances change."
                    title="No progress updates"
                />
            )}
            {updates.length > 0 && (
                <ol className="mt-5 space-y-3">
                    {updates.map((update) => (
                        <TaskProgressEntry
                            busy={busy}
                            editing={editingId === update.id}
                            key={update.id}
                            onCancelEdit={() => setEditingId(undefined)}
                            onDelete={() => setPendingDelete(update)}
                            onEdit={() => setEditingId(update.id)}
                            onSave={async (messageMarkdown) => {
                                await updateProgress.mutateAsync({
                                    expectedVersion: update.version,
                                    messageMarkdown,
                                    taskId,
                                    updateId: update.id,
                                });
                            }}
                            update={update}
                        />
                    ))}
                </ol>
            )}
            {progress.hasNextPage && (
                <Button
                    busy={progress.isFetchingNextPage}
                    busyLabel="Loading…"
                    className="mt-4"
                    onClick={() => void progress.fetchNextPage()}
                    variant="secondary"
                >
                    Load older updates
                </Button>
            )}
            <ConfirmModal
                busy={deleteProgress.isPending}
                confirmLabel="Delete update"
                danger
                description="This removes the progress entry while preserving the task audit event."
                onCancel={() => setPendingDelete(undefined)}
                onConfirm={() => {
                    if (pendingDelete === undefined) return;
                    deleteProgress.mutate(
                        {
                            expectedVersion: pendingDelete.version,
                            taskId,
                            updateId: pendingDelete.id,
                        },
                        {
                            onSuccess: () => {
                                setEvictedUpdateIds((current) =>
                                    new Set(current).add(pendingDelete.id)
                                );
                                setPendingDelete(undefined);
                            },
                        }
                    );
                }}
                open={pendingDelete !== undefined}
                title="Delete progress update?"
            />
        </section>
    );
}
