import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, jest } from "bun:test";
import { createElement, type ReactNode } from "react";

import { apiFetch, UnauthorizedError } from "./hooks/useApi";
import { Tasks } from "./pages/Tasks";
import { authActions, authStore } from "./stores/authStore";
import type { Task } from "./types/task";
import { getColumnId, getPriority, isTaskMatchSearch } from "./utils/taskUtilities";

function task(overrides: Partial<Task> & Pick<Task, "number" | "title">): Task {
    return {
        number: overrides.number,
        title: overrides.title,
        body: overrides.body ?? "",
        state: overrides.state ?? "OPEN",
        labels: overrides.labels ?? [],
        assignees: overrides.assignees ?? [{ login: "mira-2026", name: "Mira" }],
        createdAt: overrides.createdAt ?? "2026-06-19T08:00:00.000Z",
        updatedAt: overrides.updatedAt ?? "2026-06-19T08:00:00.000Z",
        url: overrides.url ?? `/tasks/${overrides.number}`,
        automation: overrides.automation,
    };
}

function createApi(tasks: Task[]) {
    return jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";

        if (url === "/api/tasks" && method === "GET") {
            return Response.json(tasks);
        }

        if (url === "/api/tasks" && method === "POST") {
            const payload = JSON.parse(String(init?.body ?? "{}")) as {
                title: string;
                body: string;
                labels: string[];
                assignee: string;
            };
            const created = task({
                number: tasks.length + 1,
                title: payload.title,
                body: payload.body,
                labels: payload.labels.map((name) => ({ name })),
                assignees: [{ login: payload.assignee, name: payload.assignee }],
                updatedAt: "2026-06-19T09:00:00.000Z",
            });
            tasks.unshift(created);
            return Response.json(created, { status: 201 });
        }

        throw new Error(`Unexpected frontend API call: ${method} ${url}`);
    });
}

function renderWithQueryClient(children: ReactNode) {
    const queryClient = new QueryClient({
        defaultOptions: {
            queries: { retry: false },
            mutations: { retry: false },
        },
    });

    const view = render(
        createElement(QueryClientProvider, { client: queryClient }, children)
    );

    return {
        ...view,
        queryClient,
    };
}

describe("Mira Dashboard frontend behavior", () => {
    beforeEach(() => {
        authActions.clearSession();
    });

    afterEach(() => {
        authActions.clearSession();
    });

    it("handles API authorization failures through the shared auth boundary", async () => {
        authActions.setSession({
            authenticated: true,
            isBootstrapRequired: false,
            user: { id: 1, username: "raymond" },
        });
        const unauthorizedEvents: Event[] = [];
        addEventListener("openclaw:unauthorized", (event) => {
            unauthorizedEvents.push(event);
        });
        Object.defineProperty(globalThis, "fetch", {
            configurable: true,
            value: jest.fn(async () =>
                Response.json({ error: "Unauthorized" }, { status: 401 })
            ),
            writable: true,
        });

        await expect(apiFetch("/tasks")).rejects.toBeInstanceOf(UnauthorizedError);

        expect(authStore.state.isAuthenticated).toBe(false);
        expect(unauthorizedEvents).toHaveLength(1);
    });

    it("renders the task board from the API and creates a task through the real hooks", async () => {
        const tasks = [
            task({
                number: 1,
                title: "Ship Bun test reset",
                labels: [{ name: "priority-high" }, { name: "in-progress" }],
            }),
        ];
        const fetchMock = createApi(tasks);
        Object.defineProperty(globalThis, "fetch", {
            configurable: true,
            value: fetchMock,
            writable: true,
        });
        const user = userEvent.setup();

        renderWithQueryClient(createElement(Tasks));

        expect(await screen.findByText("Ship Bun test reset")).toBeInTheDocument();
        expect(screen.getByText("In Progress")).toBeInTheDocument();

        await user.click(screen.getByRole("button", { name: /new task/i }));
        await user.type(screen.getByLabelText("Title"), "Write useful tests");
        await user.type(
            screen.getByLabelText("Description (optional)"),
            "Cover behavior"
        );
        await user.click(
            within(screen.getByRole("dialog")).getByRole("button", { name: "Raymond" })
        );
        await user.click(screen.getByRole("button", { name: /^Create Task$/i }));

        await waitFor(() =>
            expect(fetchMock).toHaveBeenCalledWith(
                "/api/tasks",
                expect.objectContaining({ method: "POST" })
            )
        );
        expect(await screen.findByText("Write useful tests")).toBeInTheDocument();
    });

    it("keeps task classification and search aligned with dashboard behavior", () => {
        const unlabelled = task({ number: 2, title: "Default priority" });
        const lowPriority = task({
            number: 4,
            title: "Low priority task",
            labels: [{ name: "priority-low" }],
        });
        const blocked = task({
            number: 3,
            title: "Waiting on deploy",
            labels: [{ name: "blocked" }],
            automation: {
                type: "cron",
                recurring: true,
                cronJobId: "daily-check",
                scheduleSummary: "Every 1h",
            },
        });

        expect(getPriority(unlabelled.labels)).toBe("medium");
        expect(getPriority(lowPriority.labels)).toBe("low");
        expect(getColumnId(blocked)).toBe("blocked");
        expect(isTaskMatchSearch(blocked, "daily-check")).toBe(true);
        expect(isTaskMatchSearch(blocked, "#3")).toBe(true);
        expect(isTaskMatchSearch(blocked, "not-present")).toBe(false);
    });
});
