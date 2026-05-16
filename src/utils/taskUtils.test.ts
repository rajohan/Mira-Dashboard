import { describe, expect, it } from "vitest";

import type { Task } from "../types/task";
import { COLUMN_CONFIG, getColumnId, getPriority, taskMatchesSearch } from "./taskUtils";

/** Builds a task fixture with focused overrides for utility tests. */
function task(overrides: Partial<Task> = {}): Task {
    return {
        number: 1,
        title: "Task",
        body: "",
        state: "OPEN",
        labels: [],
        assignees: [],
        createdAt: "2026-05-10T00:00:00.000Z",
        updatedAt: "2026-05-10T00:00:00.000Z",
        url: "/tasks/1",
        ...overrides,
    };
}

describe("task utils", () => {
    it("derives priority from labels with low as default", () => {
        expect(getPriority([{ name: "priority-high" }])).toBe("high");
        expect(getPriority([{ name: "high" }])).toBe("high");
        expect(getPriority([{ name: "priority-medium" }])).toBe("medium");
        expect(getPriority([{ name: "medium" }])).toBe("medium");
        expect(getPriority([{ name: "priority-low" }])).toBe("low");
        expect(getPriority([])).toBe("low");
    });

    it("maps string ids to known columns only", () => {
        expect(getColumnId("todo")).toBe("todo");
        expect(getColumnId("in-progress")).toBe("in-progress");
        expect(getColumnId("blocked")).toBe("blocked");
        expect(getColumnId("done")).toBe("done");
        expect(getColumnId("unknown")).toBeNull();
    });

    it("maps tasks to columns by state and labels", () => {
        expect(getColumnId(task())).toBe("todo");
        expect(getColumnId(task({ labels: [{ name: "in-progress" }] }))).toBe(
            "in-progress"
        );
        expect(getColumnId(task({ labels: [{ name: "blocked" }] }))).toBe("blocked");
        expect(getColumnId(task({ state: "CLOSED" }))).toBe("done");
    });

    it("matches task board search across task metadata", () => {
        const searchableTask = task({
            assignees: [{ login: "mira-2026", name: "Mira" }],
            automation: {
                type: "cron",
                recurring: true,
                cronJobId: "cron-nightly",
                jobName: "Dashboard Autopilot",
                scheduleSummary: "30 9,18 * * *",
                sessionTarget: "session:dashboard-autopilot",
                model: "codex",
                thinking: "high",
                lastRunStatus: "ok",
            },
            body: "Review dashboard friction and open a small PR.",
            labels: [{ name: "in-progress" }, { name: "priority-medium" }],
            number: 8,
            title: "Autonomous improvement loop",
        });

        expect(taskMatchesSearch(searchableTask, "")).toBe(true);
        expect(taskMatchesSearch(searchableTask, "  AUTOPILOT  ")).toBe(true);
        expect(taskMatchesSearch(searchableTask, "friction")).toBe(true);
        expect(taskMatchesSearch(searchableTask, "priority-medium")).toBe(true);
        expect(taskMatchesSearch(searchableTask, "mira-2026")).toBe(true);
        expect(taskMatchesSearch(searchableTask, "30 9")).toBe(true);
        expect(taskMatchesSearch(searchableTask, "dashboard-autopilot")).toBe(true);
        expect(taskMatchesSearch(searchableTask, "missing")).toBe(false);
    });

    it("keeps column filters aligned with task column mapping", () => {
        const tasks = [
            task({ number: 1 }),
            task({ number: 2, labels: [{ name: "in-progress" }] }),
            task({ number: 3, labels: [{ name: "blocked" }] }),
            task({ number: 4, state: "CLOSED" }),
        ];

        for (const column of COLUMN_CONFIG) {
            const filteredIds = tasks.filter(column.filter).map((item) => item.number);
            const mappedIds = tasks
                .filter((item) => getColumnId(item) === column.id)
                .map((item) => item.number);
            expect(filteredIds).toEqual(mappedIds);
        }
    });
});
