import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { Terminal } from "./Terminal";

const terminal = vi.hoisted(() => ({
    addCommand: vi.fn(),
    changeDirectory: vi.fn(),
    clearHistory: vi.fn(),
    getCompletions: vi.fn(),
    history: [] as Array<{
        code: number | null;
        command: string;
        cwd: string;
        endedAt: number | null;
        id: string;
        jobId: string | null;
        startedAt: number;
        status: string;
        stderr: string;
        stdout: string;
    }>,
    nextId: 1,
    startCommand: vi.fn(),
    stopTerminalJob: vi.fn(),
    updateCommand: vi.fn(),
    useStartTerminalCommand: vi.fn(),
    useTerminalHistory: vi.fn(),
    useTerminalJob: vi.fn(),
}));

vi.mock("../hooks/useTerminal", () => ({
    changeDirectory: terminal.changeDirectory,
    getCompletions: terminal.getCompletions,
    stopTerminalJob: terminal.stopTerminalJob,
    useStartTerminalCommand: terminal.useStartTerminalCommand,
    useTerminalHistory: terminal.useTerminalHistory,
    useTerminalJob: terminal.useTerminalJob,
}));

function makeHistoryEntry(command: string, overrides = {}) {
    return {
        code: 0,
        command,
        cwd: "~",
        endedAt: 2_000,
        id: `history-${terminal.nextId++}`,
        jobId: null,
        startedAt: 1_000,
        status: "done",
        stderr: "",
        stdout: "",
        ...overrides,
    };
}

describe("Terminal page", () => {
    beforeEach(() => {
        terminal.history = [];
        terminal.nextId = 1;
        terminal.addCommand.mockReset();
        terminal.addCommand.mockImplementation((entry) => {
            const id = `history-${terminal.nextId++}`;
            terminal.history.push({ id, ...entry });
            return id;
        });
        terminal.changeDirectory.mockReset();
        terminal.clearHistory.mockReset();
        terminal.clearHistory.mockImplementation(() => {
            terminal.history = [];
        });
        terminal.getCompletions.mockReset();
        terminal.startCommand.mockResolvedValue({ jobId: "job-1" });
        terminal.stopTerminalJob.mockResolvedValue(Promise.resolve());
        terminal.updateCommand.mockReset();
        terminal.updateCommand.mockImplementation((id, patch) => {
            const entry = terminal.history.find((item) => item.id === id);
            if (entry) Object.assign(entry, patch);
        });
        terminal.useStartTerminalCommand.mockReturnValue({
            isPending: false,
            mutateAsync: terminal.startCommand,
        });
        terminal.useTerminalHistory.mockImplementation(() => ({
            addCommand: terminal.addCommand,
            clearHistory: terminal.clearHistory,
            history: terminal.history,
            updateCommand: terminal.updateCommand,
        }));
        terminal.useTerminalJob.mockReturnValue({ data: null });
    });

    it("renders welcome copy and disables run/clear until input or history exists", () => {
        render(<Terminal />);

        expect(
            screen.getByText(/Welcome to Mira Dashboard Terminal/)
        ).toBeInTheDocument();
        expect(screen.getByRole("button", { name: /Run/ })).toBeDisabled();
        expect(screen.getByRole("button", { name: /Clear/ })).toBeDisabled();
    });

    it("handles pwd locally", async () => {
        const user = userEvent.setup();

        render(<Terminal />);

        await user.type(screen.getByPlaceholderText("Enter command..."), "pwd");
        await user.click(screen.getByRole("button", { name: /Run/ }));

        expect(terminal.addCommand).toHaveBeenCalledWith(
            expect.objectContaining({
                command: "pwd",
                code: 0,
                cwd: "~",
                stdout: "/home/ubuntu",
            })
        );
        expect(terminal.startCommand).not.toHaveBeenCalled();
    });

    it("handles successful and failed cd commands locally", async () => {
        const user = userEvent.setup();
        terminal.changeDirectory
            .mockResolvedValueOnce({ newCwd: "/home/ubuntu", success: true })
            .mockResolvedValueOnce({ newCwd: "/home/ubuntu/projects", success: true })
            .mockResolvedValueOnce({ error: "No such directory", success: false });

        render(<Terminal />);

        await user.type(screen.getByPlaceholderText("Enter command..."), "cd");
        await user.click(screen.getByRole("button", { name: /Run/ }));
        expect(terminal.changeDirectory).toHaveBeenCalledWith(
            "/home/ubuntu",
            "/home/ubuntu"
        );

        await user.type(screen.getByPlaceholderText("Enter command..."), "cd projects");
        await user.click(screen.getByRole("button", { name: /Run/ }));
        expect(terminal.changeDirectory).toHaveBeenCalledWith("projects", "/home/ubuntu");
        expect(terminal.addCommand).toHaveBeenCalledWith(
            expect.objectContaining({ command: "cd projects", code: 0 })
        );

        await user.type(screen.getByPlaceholderText("Enter command..."), "cd missing");
        await user.click(screen.getByRole("button", { name: /Run/ }));
        expect(terminal.addCommand).toHaveBeenCalledWith(
            expect.objectContaining({
                command: "cd missing",
                code: 1,
                stderr: "No such directory",
            })
        );
    });

    it("does not submit while a command is pending", async () => {
        const user = userEvent.setup();
        terminal.useStartTerminalCommand.mockReturnValue({
            isPending: true,
            mutateAsync: terminal.startCommand,
        });

        render(<Terminal />);
        const input = screen.getByPlaceholderText("Enter command...");
        const runButton = screen.getByRole("button", { name: /Run/ });

        await user.type(input, "ls -la");
        await user.click(runButton);

        expect(runButton).toBeDisabled();
        expect(terminal.startCommand).not.toHaveBeenCalled();
        expect(terminal.addCommand).not.toHaveBeenCalled();
    });

    it("starts remote commands and records the job id", async () => {
        const user = userEvent.setup();

        render(<Terminal />);

        await user.type(screen.getByPlaceholderText("Enter command..."), "ls -la");
        await user.click(screen.getByRole("button", { name: /Run/ }));

        expect(terminal.startCommand).toHaveBeenCalledWith({
            command: "ls -la",
            cwd: "/home/ubuntu",
        });
        await waitFor(() => {
            expect(terminal.updateCommand).toHaveBeenCalledWith(
                expect.any(String),
                expect.objectContaining({ jobId: "job-1", status: "running" })
            );
        });
    });

    it("uses tab completion and command history navigation", async () => {
        const user = userEvent.setup();
        terminal.history = [makeHistoryEntry("npm test"), makeHistoryEntry("git status")];
        terminal.getCompletions.mockResolvedValue({
            commonPrefix: "git status",
            completions: [{ completion: "git status" }, { completion: "git stash" }],
        });

        render(<Terminal />);
        const input = screen.getByPlaceholderText("Enter command...");

        await user.type(input, "git st");
        await user.keyboard("{Tab}");
        await waitFor(() => expect(input).toHaveValue("git status"));

        await user.keyboard("{ArrowUp}");
        expect(input).toHaveValue("git status");
        await user.keyboard("{ArrowUp}");
        expect(input).toHaveValue("npm test");
        await user.keyboard("{ArrowDown}");
        expect(input).toHaveValue("git status");
    });

    it("handles empty tab, empty history navigation, scrolling, and follow button", async () => {
        const user = userEvent.setup();
        const { container } = render(<Terminal />);
        const input = screen.getByPlaceholderText("Enter command...");
        const output = container.querySelector(".overflow-auto") as HTMLDivElement;

        await user.click(input);
        await user.keyboard("{Tab}{ArrowUp}{ArrowDown}");
        expect(terminal.getCompletions).not.toHaveBeenCalled();
        expect(input).toHaveValue("");

        Object.defineProperties(output, {
            clientHeight: { configurable: true, value: 100 },
            scrollHeight: { configurable: true, value: 500 },
            scrollTop: { configurable: true, value: 0, writable: true },
        });
        act(() => {
            output.dispatchEvent(new Event("scroll", { bubbles: true }));
        });

        const follow = await screen.findByRole("button", { name: "↓ Follow" });
        await user.click(follow);
        expect(output.scrollTop).toBe(500);
    });

    it("keeps the follow control hidden when already at the bottom", async () => {
        const user = userEvent.setup();
        const { container } = render(<Terminal />);
        const output = container.querySelector(".overflow-auto") as HTMLDivElement;

        Object.defineProperties(output, {
            clientHeight: { configurable: true, value: 100 },
            scrollHeight: { configurable: true, value: 120 },
            scrollTop: { configurable: true, value: 0, writable: true },
        });

        await user.click(screen.getByPlaceholderText("Enter command..."));
        act(() => {
            output.dispatchEvent(new Event("scroll", { bubbles: true }));
        });

        expect(
            screen.queryByRole("button", { name: "↓ Follow" })
        ).not.toBeInTheDocument();
    });

    it("shows cwd outside home and completed job updates without duplicate history writes", async () => {
        const user = userEvent.setup();
        terminal.changeDirectory.mockResolvedValueOnce({
            newCwd: "/tmp",
            success: true,
        });
        terminal.useTerminalJob.mockImplementation((jobId: string | null) => ({
            data: jobId
                ? {
                      code: 0,
                      endedAt: 3_000,
                      stderr: "",
                      stdout: "done stdout",
                      status: "done",
                  }
                : null,
        }));

        const { rerender } = render(<Terminal />);

        await user.type(screen.getByPlaceholderText("Enter command..."), "cd /tmp");
        await user.click(screen.getByRole("button", { name: /Run/ }));
        await user.type(screen.getByPlaceholderText("Enter command..."), "echo done");
        await user.click(screen.getByRole("button", { name: /Run/ }));
        expect(terminal.addCommand).toHaveBeenCalledTimes(2);
        rerender(<Terminal />);

        await waitFor(() => {
            expect(terminal.updateCommand).toHaveBeenCalledWith(
                expect.any(String),
                expect.objectContaining({
                    code: 0,
                    endedAt: 3_000,
                    stdout: "done stdout",
                    status: "done",
                })
            );
        });
        expect(screen.getByText("/tmp$")).toBeInTheDocument();
    });

    it("renders terminal output states and current detached job output", () => {
        terminal.history = [
            makeHistoryEntry("running", {
                code: null,
                endedAt: null,
                jobId: "job-running",
                status: "running",
                stdout: "still working",
            }),
            makeHistoryEntry("failed", {
                code: null,
                endedAt: null,
                status: "error",
                stderr: "spawn failed",
            }),
            makeHistoryEntry("unknown exit", {
                code: null,
                endedAt: null,
                status: "done",
            }),
        ];
        terminal.useTerminalJob.mockReturnValue({
            data: {
                code: null,
                endedAt: null,
                stderr: "detached stderr",
                stdout: "detached stdout",
                status: "running",
            },
        });

        render(<Terminal />);

        expect(screen.getByText("still working")).toBeInTheDocument();
        expect(screen.getByText("spawn failed")).toBeInTheDocument();
        expect(screen.getByText("Command failed to start")).toBeInTheDocument();
        expect(screen.getByText("Exit code: unknown")).toBeInTheDocument();
        expect(screen.queryByText("detached stdout")).not.toBeInTheDocument();
    });

    it("clears command history", async () => {
        const user = userEvent.setup();
        terminal.history = [makeHistoryEntry("pwd")];

        render(<Terminal />);

        await user.click(screen.getByRole("button", { name: /Clear/ }));
        expect(terminal.clearHistory).toHaveBeenCalledTimes(1);
    });

    it("records cd and remote start failures", async () => {
        const user = userEvent.setup();
        terminal.changeDirectory.mockRejectedValueOnce(new Error("boom"));
        terminal.startCommand.mockRejectedValueOnce(new Error("spawn failed"));

        render(<Terminal />);

        await user.type(screen.getByPlaceholderText("Enter command..."), "cd broken");
        await user.click(screen.getByRole("button", { name: /Run/ }));
        expect(terminal.addCommand).toHaveBeenCalledWith(
            expect.objectContaining({
                command: "cd broken",
                code: 1,
                status: "error",
                stderr: "Failed to change directory",
            })
        );

        await user.type(screen.getByPlaceholderText("Enter command..."), "npm test");
        await user.click(screen.getByRole("button", { name: /Run/ }));
        expect(terminal.addCommand).toHaveBeenCalledWith(
            expect.objectContaining({
                command: "npm test",
                code: 1,
                status: "error",
                stderr: "Failed to start command",
            })
        );
        expect(terminal.updateCommand).toHaveBeenCalledWith(expect.any(String), {
            status: "error",
        });
    });

    it("updates running job output and stops jobs", async () => {
        const user = userEvent.setup();
        terminal.useTerminalJob.mockImplementation((jobId: string | null) => ({
            data: jobId
                ? {
                      code: null,
                      endedAt: null,
                      stderr: "watch stderr",
                      stdout: "watch stdout",
                      status: "running",
                  }
                : null,
        }));

        render(<Terminal />);

        await user.type(screen.getByPlaceholderText("Enter command..."), "npm run dev");
        await user.click(screen.getByRole("button", { name: /Run/ }));

        await waitFor(() => {
            expect(terminal.updateCommand).toHaveBeenCalledWith(
                expect.any(String),
                expect.objectContaining({
                    stderr: "watch stderr",
                    stdout: "watch stdout",
                    status: "running",
                })
            );
        });

        await user.click(await screen.findByRole("button", { name: /Stop/ }));
        expect(terminal.stopTerminalJob).toHaveBeenCalledWith("job-1");
    });

    it("ignores stop failures for already-finished jobs", async () => {
        const user = userEvent.setup();
        terminal.stopTerminalJob.mockRejectedValueOnce(new Error("already stopped"));
        terminal.useTerminalJob.mockImplementation((jobId: string | null) => ({
            data: jobId
                ? {
                      code: null,
                      endedAt: null,
                      stderr: "",
                      stdout: "still running",
                      status: "running",
                  }
                : null,
        }));

        render(<Terminal />);

        await user.type(
            screen.getByPlaceholderText("Enter command..."),
            "tail -f app.log"
        );
        await user.click(screen.getByRole("button", { name: /Run/ }));
        await user.click(await screen.findByRole("button", { name: /Stop/ }));

        expect(terminal.stopTerminalJob).toHaveBeenCalledWith("job-1");
    });

    it("handles single, empty, and failed tab completions", async () => {
        const user = userEvent.setup();
        terminal.getCompletions
            .mockResolvedValueOnce({
                commonPrefix: "",
                completions: [{ completion: "src/pages/Terminal.tsx" }],
            })
            .mockResolvedValueOnce({ commonPrefix: "", completions: [] })
            .mockRejectedValueOnce(new Error("completion failed"));

        render(<Terminal />);
        const input = screen.getByPlaceholderText("Enter command...");

        await user.type(input, "src/p");
        await user.keyboard("{Tab}");
        await waitFor(() => expect(input).toHaveValue("src/pages/Terminal.tsx"));

        await user.clear(input);
        await user.type(input, "no-match");
        await user.keyboard("{Tab}");
        expect(input).toHaveValue("no-match");

        await user.clear(input);
        await user.type(input, "throws");
        await user.keyboard("{Tab}");
        expect(input).toHaveValue("throws");
    });
});
