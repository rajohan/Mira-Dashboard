import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
            .mockResolvedValueOnce({ newCwd: "/home/ubuntu/projects", success: true })
            .mockResolvedValueOnce({ error: "No such directory", success: false });

        render(<Terminal />);

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

    it("clears command history", async () => {
        const user = userEvent.setup();
        terminal.history = [makeHistoryEntry("pwd")];

        render(<Terminal />);

        await user.click(screen.getByRole("button", { name: /Clear/ }));
        expect(terminal.clearHistory).toHaveBeenCalledTimes(1);
    });
});
