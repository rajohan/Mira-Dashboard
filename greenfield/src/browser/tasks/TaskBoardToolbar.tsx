import { Plus, RefreshCw } from "lucide-react";

import { taskAssignees, type TaskAssigneeId } from "../../contracts/taskModel.ts";
import type { ListTasksInput } from "../../contracts/tasks.ts";
import { Button } from "../ui/Button.tsx";
import { Icon } from "../ui/Icon.tsx";
import { SearchInput } from "../ui/SearchInput.tsx";
import { Select, type SelectOption } from "../ui/Select.tsx";

export type TaskAssigneeFilter = "all" | TaskAssigneeId;
export type TaskAutomationFilter =
    | "all"
    | NonNullable<NonNullable<ListTasksInput["filters"]>["automation"]>;

const assigneeOptions: readonly SelectOption<TaskAssigneeFilter>[] = Object.freeze([
    { label: "All assignees", value: "all" },
    ...taskAssignees.map(({ id, label }) => ({ label, value: id })),
]);
const automationOptions: readonly SelectOption<TaskAutomationFilter>[] = Object.freeze([
    { label: "All tasks", value: "all" },
    { label: "Recurring", value: "recurring" },
    { label: "Manual", value: "manual" },
]);

interface TaskBoardToolbarProps {
    readonly assignee: TaskAssigneeFilter;
    readonly automation: TaskAutomationFilter;
    readonly busy: boolean;
    readonly onAssigneeChange: (value: TaskAssigneeFilter) => void;
    readonly onAutomationChange: (value: TaskAutomationFilter) => void;
    readonly onCreate: () => void;
    readonly onRefresh: () => void;
    readonly onSearchChange: (value: string) => void;
    readonly search: string;
}

/** @returns Task search, filters, refresh, and creation controls. */
export function TaskBoardToolbar({
    assignee,
    automation,
    busy,
    onAssigneeChange,
    onAutomationChange,
    onCreate,
    onRefresh,
    onSearchChange,
    search,
}: TaskBoardToolbarProps) {
    return (
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div className="grid min-w-0 flex-1 gap-3 sm:grid-cols-[minmax(12rem,1fr)_11rem_11rem]">
                <SearchInput
                    disabled={busy}
                    label="Search tasks"
                    onChange={onSearchChange}
                    placeholder="Search tasks…"
                    value={search}
                />
                <Select
                    ariaLabel="Filter tasks by assignee"
                    disabled={busy}
                    onChange={onAssigneeChange}
                    options={assigneeOptions}
                    value={assignee}
                />
                <Select
                    ariaLabel="Filter tasks by automation"
                    disabled={busy}
                    onChange={onAutomationChange}
                    options={automationOptions}
                    value={automation}
                />
            </div>
            <div className="flex shrink-0 gap-2">
                <Button disabled={busy} onClick={onRefresh} variant="secondary">
                    <Icon icon={RefreshCw} size="sm" tone="inherit" />
                    Refresh
                </Button>
                <Button disabled={busy} onClick={onCreate}>
                    <Icon icon={Plus} size="sm" tone="inherit" />
                    New task
                </Button>
            </div>
        </div>
    );
}
