import { Disclosure, DisclosureButton, DisclosurePanel } from "@headlessui/react";
import {
    Bot,
    ChevronDown,
    CircleAlert,
    CircleCheck,
    ListChecks,
    Square,
    Timer,
    X,
} from "lucide-react";
import { type FormEvent, type KeyboardEvent, type Ref, useRef, useState } from "react";

import { cn } from "../lib/classNames.ts";
import { Badge } from "../ui/Badge.tsx";
import { Button } from "../ui/Button.tsx";
import { Heading } from "../ui/Heading.tsx";
import { Icon } from "../ui/Icon.tsx";
import { Input } from "../ui/Input.tsx";
import { LoadingState } from "../ui/LoadingState.tsx";
import { Text } from "../ui/Text.tsx";
import type {
    ChatActivePlanView,
    ChatBackgroundTaskView,
    ChatCompanionView,
} from "./chatTypes.ts";
/* eslint-disable jsx-a11y/no-noninteractive-element-interactions -- The responsive aside traps Tab and Escape only while styled as the mobile modal drawer. */

function planStatusIcon(status: ChatActivePlanView["items"][number]["status"]) {
    if (status === "completed") return CircleCheck;
    if (status === "in-progress") return Timer;
    return ListChecks;
}

function taskBadgeVariant(
    status: ChatBackgroundTaskView["status"]
): "danger" | "default" | "success" {
    if (status === "failed" || status === "timed_out") return "danger";
    if (status === "completed") return "success";
    return "default";
}

interface ChatSidePanelProps {
    readonly canAskCompanion: boolean;
    readonly className?: string;
    readonly closeButtonRef?: Ref<HTMLButtonElement>;
    readonly companion: ChatCompanionView;
    readonly companionError?: string;
    readonly onAskCompanion: (question: string) => void;
    readonly onCancelTask: (taskId: string) => void;
    readonly onLoadMoreTasks: () => void;
    readonly onClose?: () => void;
    readonly onResetCompanion: () => void;
    readonly onReturnTasksToLatest?: () => void;
    readonly onRetryCompanion?: () => void;
    readonly onRetryTasks?: () => void;
    readonly onSelectTask: (taskId: string) => void;
    readonly plans: readonly ChatActivePlanView[];
    readonly providerWritesDisabled?: boolean;
    readonly selectedTaskId?: string;
    readonly sessionKey: string;
    readonly taskCancelGatedIds: readonly string[];
    readonly taskDetailError?: string;
    readonly tasks: readonly ChatBackgroundTaskView[];
    readonly tasksHasNextPage: boolean;
    readonly tasksLoading: boolean;
    readonly tasksLoadingMore: boolean;
    readonly tasksWindowLimited?: boolean;
    readonly tasksError?: string;
    readonly id?: string;
}

function companionBadgeVariant(
    status: ChatCompanionView["status"]
): "danger" | "default" | "info" | "success" | "warning" {
    if (status === "error") return "danger";
    if (status === "ready") return "success";
    if (status === "answering") return "info";
    if (status === "resetting") return "warning";
    return "default";
}

function companionStatusLabel(status: ChatCompanionView["status"]): string {
    if (status === "answering") return "Asking";
    if (status === "resetting") return "Resetting";
    if (status === "ready") return "Ready";
    if (status === "error") return "Error";
    return "Idle";
}

function Plan({ plan }: Readonly<{ plan: ChatActivePlanView }>) {
    return (
        <section aria-label={`Active plan: ${plan.title}`} className="shrink-0 space-y-2">
            <Heading level={3}>{plan.title}</Heading>
            <ol className="space-y-1.5">
                {plan.items.map((item) => (
                    <li className="flex items-start gap-2 text-sm" key={item.id}>
                        <Icon
                            className={cn(
                                "mt-0.5 shrink-0",
                                item.status === "in-progress" &&
                                    "animate-pulse motion-reduce:animate-none"
                            )}
                            icon={planStatusIcon(item.status)}
                            size="sm"
                            tone={item.status === "completed" ? "success" : "inherit"}
                        />
                        <span
                            className={
                                item.status === "completed"
                                    ? "text-primary-400"
                                    : "text-primary-200"
                            }
                        >
                            {item.label}
                        </span>
                    </li>
                ))}
            </ol>
        </section>
    );
}

/**
 * Renders ephemeral plan, companion, and durable background-task detail.
 * @returns The activity side panel.
 */
export function ChatSidePanel({
    canAskCompanion,
    className,
    closeButtonRef,
    companion,
    companionError,
    onAskCompanion,
    onCancelTask,
    onLoadMoreTasks,
    onClose,
    onResetCompanion,
    onReturnTasksToLatest,
    onRetryCompanion,
    onRetryTasks,
    onSelectTask,
    plans,
    providerWritesDisabled = false,
    selectedTaskId,
    sessionKey,
    taskCancelGatedIds,
    taskDetailError,
    tasks,
    tasksHasNextPage,
    tasksLoading,
    tasksLoadingMore,
    tasksWindowLimited = false,
    tasksError,
    id,
}: ChatSidePanelProps) {
    const [questions, setQuestions] = useState<Readonly<Record<string, string>>>({});
    const panel = useRef<HTMLElement>(null);
    const question = questions[sessionKey] ?? "";
    const setQuestion = (value: string) =>
        setQuestions((current) => ({ ...current, [sessionKey]: value }));
    const selectedTask = tasks.find((task) => task.id === selectedTaskId) ?? tasks[0];
    const companionAskBusy = companion.status === "answering";
    const companionResetBusy = companion.status === "resetting";

    function ask(event: FormEvent<HTMLFormElement>): void {
        event.preventDefault();
        const nextQuestion = question.trim();
        if (
            nextQuestion === "" ||
            companionAskBusy ||
            companionResetBusy ||
            providerWritesDisabled ||
            !canAskCompanion
        ) {
            return;
        }
        onAskCompanion(nextQuestion);
    }

    function handlePanelKeyDown(event: KeyboardEvent<HTMLElement>): void {
        if (globalThis.matchMedia?.("(min-width: 1024px)").matches === true) return;
        if (event.key === "Escape" && onClose !== undefined) {
            event.preventDefault();
            onClose();
            return;
        }
        if (event.key !== "Tab") return;
        const focusable = [
            ...(panel.current?.querySelectorAll<HTMLElement>(
                'button:not([disabled]), input:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])'
            ) ?? []),
        ].filter((element) => element.getClientRects().length > 0);
        if (focusable.length === 0) return;
        const first = focusable[0]!;
        const last = focusable.at(-1)!;
        if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
        }
    }

    return (
        <aside
            aria-label="Chat activity"
            className={cn(
                "border-primary-700 bg-primary-900 h-auto min-h-0 min-w-0 flex-col gap-4 overflow-x-hidden overflow-y-auto px-3 pt-0 pb-3 lg:h-full lg:w-80 lg:shrink-0 lg:border-l xl:w-96",
                className
            )}
            id={id}
            onKeyDown={handlePanelKeyDown}
            ref={panel}
        >
            <header className="border-primary-700 bg-primary-900 sticky top-0 z-10 -mx-3 flex min-h-13 min-w-0 shrink-0 items-center justify-between gap-3 border-b px-3 py-2">
                <div className="flex min-w-0 items-center gap-2">
                    <Icon icon={ListChecks} size="sm" tone="accent" />
                    <Heading level={2} size="subsection">
                        Activity &amp; tasks
                    </Heading>
                </div>
                {onClose !== undefined && (
                    <Button
                        aria-controls={id}
                        aria-expanded="true"
                        aria-label="Close activity panel"
                        className="focus-visible:ring-accent-400 min-h-11 shrink-0 focus-visible:ring-1 focus-visible:ring-offset-0 sm:min-h-9"
                        onClick={onClose}
                        ref={closeButtonRef}
                        size="sm"
                        variant="ghost"
                    >
                        <Icon icon={X} size="sm" tone="inherit" />
                        Close
                    </Button>
                )}
            </header>
            {plans.map((plan) => (
                <Plan key={plan.runId} plan={plan} />
            ))}
            {plans.length === 0 && (
                <Text className="shrink-0" size="sm" tone="muted">
                    Active-run plans appear here and disappear when their run settles.
                </Text>
            )}

            <Disclosure
                as="section"
                className="border-primary-600 bg-primary-950 min-w-0 shrink-0 overflow-hidden rounded-xl border"
                defaultOpen={
                    companion.status !== "idle" ||
                    companion.answer !== undefined ||
                    companion.error !== undefined ||
                    companionError !== undefined
                }
            >
                <DisclosureButton className="hover:bg-primary-800 focus-visible:ring-accent-400 group flex w-full min-w-0 items-center gap-2 p-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset">
                    <Icon icon={Bot} size="sm" tone="accent" />
                    <span className="text-primary-100 min-w-0 flex-1 font-medium">
                        Companion
                    </span>
                    <Badge variant={companionBadgeVariant(companion.status)}>
                        {companionStatusLabel(companion.status)}
                    </Badge>
                    <Icon
                        className="shrink-0 transition-transform group-data-open:rotate-180 motion-reduce:transition-none"
                        icon={ChevronDown}
                        size="sm"
                        tone="default"
                    />
                </DisclosureButton>
                <DisclosurePanel className="border-primary-700 min-w-0 space-y-3 border-t p-3">
                    {(companion.question !== undefined ||
                        companion.answer !== undefined) && (
                        <div className="space-y-2">
                            {companion.question !== undefined && (
                                <div className="min-w-0">
                                    <p className="text-primary-400 text-xs font-medium tracking-wide uppercase">
                                        Question
                                    </p>
                                    <p className="text-primary-200 mt-1 text-sm wrap-break-word whitespace-pre-wrap">
                                        {companion.question}
                                    </p>
                                </div>
                            )}
                            {companion.answer !== undefined && (
                                <output
                                    aria-label="Companion answer"
                                    className="border-primary-600 bg-primary-800 text-primary-100 block min-w-0 rounded-lg border p-2.5 text-sm wrap-break-word whitespace-pre-wrap"
                                >
                                    {companion.answer}
                                </output>
                            )}
                        </div>
                    )}
                    {(companion.error !== undefined || companionError !== undefined) && (
                        <div className="space-y-2">
                            {companion.error !== undefined && (
                                <p
                                    className="flex min-w-0 items-start gap-1.5 text-sm wrap-break-word text-red-300"
                                    role="alert"
                                >
                                    <Icon
                                        className="mt-0.5 shrink-0"
                                        icon={CircleAlert}
                                        size="sm"
                                        tone="danger"
                                    />
                                    {companion.error}
                                </p>
                            )}
                            {companionError !== undefined && (
                                <p className="text-sm text-amber-200" role="alert">
                                    {companionError}
                                </p>
                            )}
                            {onRetryCompanion !== undefined && (
                                <Button
                                    className="w-full min-w-0 justify-center"
                                    onClick={onRetryCompanion}
                                    size="sm"
                                    variant="secondary"
                                >
                                    Retry companion
                                </Button>
                            )}
                        </div>
                    )}
                    <form className="min-w-0 space-y-2" onSubmit={ask}>
                        <div className="flex min-w-0 items-center justify-between gap-2">
                            <label
                                className="text-primary-300 min-w-0 text-xs font-medium"
                                htmlFor="chat-companion-question"
                            >
                                Ask about this session
                            </label>
                            <span
                                className="text-primary-400 shrink-0 text-xs"
                                id="chat-companion-limit"
                            >
                                {question.length}/400
                            </span>
                        </div>
                        <Input
                            aria-describedby="chat-companion-limit"
                            aria-label="Ask companion"
                            disabled={
                                providerWritesDisabled ||
                                !canAskCompanion ||
                                companionAskBusy ||
                                companionResetBusy
                            }
                            id="chat-companion-question"
                            maxLength={400}
                            onChange={(event) => setQuestion(event.currentTarget.value)}
                            placeholder="Ask a short question"
                            value={question}
                        />
                        <fieldset
                            aria-label="Companion actions"
                            className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-[minmax(0,1fr)_auto]"
                        >
                            <Button
                                busy={companion.status === "answering"}
                                busyLabel="Asking…"
                                className="w-full min-w-0 justify-center"
                                disabled={
                                    providerWritesDisabled ||
                                    !canAskCompanion ||
                                    companionAskBusy ||
                                    companionResetBusy ||
                                    question.trim() === ""
                                }
                                size="sm"
                                type="submit"
                            >
                                Ask companion
                            </Button>
                            <Button
                                busy={companion.status === "resetting"}
                                busyLabel="Resetting…"
                                className="w-full min-w-0 justify-center"
                                disabled={providerWritesDisabled || companionResetBusy}
                                onClick={onResetCompanion}
                                size="sm"
                                variant="ghost"
                            >
                                Reset
                            </Button>
                        </fieldset>
                    </form>
                </DisclosurePanel>
            </Disclosure>

            <section className="border-primary-700 min-w-0 shrink-0 border-t pt-4">
                <Heading level={2} size="subsection">
                    Background tasks
                </Heading>
                {tasksLoading && tasks.length === 0 && (
                    <LoadingState label="Loading background tasks…" size="sm" />
                )}
                {tasksError !== undefined && (
                    <div className="mt-2">
                        <p className="text-sm text-amber-200" role="alert">
                            {tasksError}
                        </p>
                        {onRetryTasks !== undefined && (
                            <Button
                                className="mt-2 w-full min-w-0 justify-center"
                                onClick={onRetryTasks}
                                size="sm"
                                variant="secondary"
                            >
                                Retry background tasks
                            </Button>
                        )}
                    </div>
                )}
                {!tasksLoading && tasks.length === 0 && tasksError === undefined && (
                    <Text className="mt-2" size="sm" tone="muted">
                        No background tasks for this session.
                    </Text>
                )}
                {tasks.length > 0 && (
                    <>
                        <ul aria-label="Background tasks" className="mt-2 space-y-1">
                            {tasks.map((task) => (
                                <li key={task.id}>
                                    <button
                                        aria-pressed={task.id === selectedTask?.id}
                                        className={cn(
                                            "hover:bg-primary-800 focus-visible:ring-accent-400 flex w-full min-w-0 items-center gap-2 rounded-lg p-2 text-left text-sm outline-none focus-visible:ring-2",
                                            task.id === selectedTask?.id &&
                                                "bg-primary-800"
                                        )}
                                        onClick={() => onSelectTask(task.id)}
                                        type="button"
                                    >
                                        <span className="min-w-0 flex-1 truncate">
                                            {task.label}
                                        </span>
                                        <Badge
                                            className="shrink-0"
                                            variant={taskBadgeVariant(task.status)}
                                        >
                                            {task.status}
                                        </Badge>
                                    </button>
                                </li>
                            ))}
                        </ul>
                        {selectedTask !== undefined && (
                            <section
                                aria-label={`Task detail: ${selectedTask.label}`}
                                className="border-primary-700 bg-primary-950/50 mt-2 rounded-lg border p-3"
                            >
                                <p className="text-primary-100 font-medium">
                                    {selectedTask.label}
                                </p>
                                <Text className="mt-1" size="sm" tone="muted">
                                    {selectedTask.summary ??
                                        "No task detail is available yet."}
                                </Text>
                                {selectedTask.detail !== undefined && (
                                    <pre className="border-primary-700 text-primary-300 mt-2 min-w-0 border-t pt-2 text-xs wrap-break-word whitespace-pre-wrap">
                                        {selectedTask.detail}
                                    </pre>
                                )}
                                {taskDetailError !== undefined && (
                                    <p
                                        className="mt-2 text-sm text-amber-200"
                                        role="alert"
                                    >
                                        {taskDetailError}
                                    </p>
                                )}
                                {selectedTask.updatedAtMs !== undefined && (
                                    <time
                                        className="text-primary-400 mt-1 block text-xs"
                                        dateTime={new Date(
                                            selectedTask.updatedAtMs
                                        ).toISOString()}
                                    >
                                        Updated{" "}
                                        {new Intl.DateTimeFormat("en-GB", {
                                            dateStyle: "medium",
                                            timeStyle: "short",
                                        }).format(selectedTask.updatedAtMs)}
                                    </time>
                                )}
                                {(selectedTask.status === "running" ||
                                    selectedTask.status === "queued") && (
                                    <Button
                                        busy={taskCancelGatedIds.includes(
                                            selectedTask.id
                                        )}
                                        busyLabel="Reconciling task…"
                                        className="mt-3 w-full min-w-0 justify-center"
                                        disabled={providerWritesDisabled}
                                        onClick={() => onCancelTask(selectedTask.id)}
                                        size="sm"
                                        variant="danger"
                                    >
                                        <Icon icon={Square} size="sm" tone="inherit" />
                                        Cancel task
                                    </Button>
                                )}
                            </section>
                        )}
                        {tasksHasNextPage && (
                            <Button
                                busy={tasksLoadingMore}
                                busyLabel="Loading more tasks…"
                                className="mt-3 w-full"
                                onClick={onLoadMoreTasks}
                                size="sm"
                                variant="secondary"
                            >
                                Load more tasks
                            </Button>
                        )}
                        {tasksWindowLimited && (
                            <div className="text-primary-300 mt-3 text-center text-xs">
                                <p>Older tasks are capped to this browser window.</p>
                                {onReturnTasksToLatest !== undefined && (
                                    <Button
                                        className="mt-2 w-full"
                                        onClick={onReturnTasksToLatest}
                                        size="sm"
                                        variant="secondary"
                                    >
                                        Return to latest tasks
                                    </Button>
                                )}
                            </div>
                        )}
                    </>
                )}
            </section>
        </aside>
    );
}
