import { Plus } from "lucide-react";

import { TASK_ASSIGNEES, type TaskAssigneeId } from "../../../../../contracts/tasks";
import { Button } from "../../ui/Button";
import { FilterButtonGroup } from "../../ui/FilterButtonGroup";
import { RefreshButton } from "../../ui/RefreshButton";
import { SearchInput } from "../../ui/SearchInput";

const ASSIGNMENT_FILTERS = [
    { value: "all", label: "All" },
    { value: TASK_ASSIGNEES.mira.id, label: TASK_ASSIGNEES.mira.label },
    { value: TASK_ASSIGNEES.raymond.id, label: TASK_ASSIGNEES.raymond.label },
] as const;

const AUTOMATION_FILTERS = [
    { value: "all", label: "All tasks" },
    { value: "recurring", label: "Recurring" },
    { value: "manual", label: "Manual" },
] as const;

export type TaskAssigneeFilter = "all" | TaskAssigneeId;
export type TaskAutomationFilter = (typeof AUTOMATION_FILTERS)[number]["value"];

interface TaskBoardToolbarProperties {
    assigneeFilter: TaskAssigneeFilter;
    automationFilter: TaskAutomationFilter;
    hasActiveFilters: boolean;
    isEmpty: boolean;
    isLoading: boolean;
    onAssigneeFilterChange: (filter: TaskAssigneeFilter) => void;
    onAutomationFilterChange: (filter: TaskAutomationFilter) => void;
    onClearFilters: () => void;
    onCreateTask: () => void;
    onRefresh: () => void;
    onSearchChange: (search: string) => void;
    search: string;
}

/**
 * Renders task-board filters, actions, and the filtered empty state.
 * @param properties Task filter state and board callbacks.
 * @returns Rendered task-board toolbar.
 */
export function TaskBoardToolbar({
    assigneeFilter,
    automationFilter,
    hasActiveFilters,
    isEmpty,
    isLoading,
    onAssigneeFilterChange,
    onAutomationFilterChange,
    onClearFilters,
    onCreateTask,
    onRefresh,
    onSearchChange,
    search,
}: TaskBoardToolbarProperties) {
    return (
        <>
            <div className="mb-4 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                <div className="flex min-w-0 flex-1 flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center lg:gap-4">
                    <SearchInput
                        value={search}
                        onChange={onSearchChange}
                        placeholder="Search tasks..."
                        clearLabel="Clear task search"
                    />
                    <FilterButtonGroup
                        ariaLabel="Task assignee"
                        options={ASSIGNMENT_FILTERS}
                        value={assigneeFilter}
                        onChange={onAssigneeFilterChange}
                    />
                    <FilterButtonGroup
                        ariaLabel="Task automation"
                        options={AUTOMATION_FILTERS}
                        value={automationFilter}
                        onChange={onAutomationFilterChange}
                    />
                </div>

                <div className="grid grid-cols-[1fr_auto] items-center gap-2 sm:flex sm:justify-end">
                    <Button
                        variant="primary"
                        size="sm"
                        onClick={onCreateTask}
                        className="w-full sm:w-auto"
                    >
                        <Plus className="size-4" />
                        New Task
                    </Button>
                    <RefreshButton
                        onClick={onRefresh}
                        isLoading={isLoading}
                        label=""
                        variant="secondary"
                    />
                </div>
            </div>

            {isEmpty ? (
                <div className="mb-4 flex flex-col gap-3 rounded-lg border border-primary-700 bg-primary-800/60 p-4 sm:flex-row sm:items-center sm:justify-between">
                    <div className="min-w-0">
                        <p className="text-sm font-medium text-primary-100">
                            {hasActiveFilters
                                ? "No tasks match the current filters."
                                : "No tasks yet."}
                        </p>
                        <p className="mt-1 text-xs text-primary-300">
                            {hasActiveFilters
                                ? "Clear search, assignee, and automation filters to return to the full board."
                                : "Create a task when there is new work to track."}
                        </p>
                    </div>
                    {hasActiveFilters ? (
                        <Button
                            variant="secondary"
                            size="sm"
                            onClick={onClearFilters}
                            className="w-full sm:w-auto"
                        >
                            Clear filters
                        </Button>
                    ) : undefined}
                </div>
            ) : undefined}
        </>
    );
}
