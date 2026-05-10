import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { Logs } from "./Logs";

const mocks = vi.hoisted(() => ({
    createObjectUrl: vi.fn(() => "blob:logs"),
    liveLogs: [] as Array<{ id: string; level: string; msg: string; raw: string }>,
    measureElement: vi.fn(),
    refetchContent: vi.fn(),
    request: vi.fn(),
    revokeObjectUrl: vi.fn(),
    scrollToIndex: vi.fn(),
    useLogContent: vi.fn(),
    useLogFiles: vi.fn(),
    useOpenClawSocket: vi.fn(),
    writeDelete: vi.fn(),
    writeInsert: vi.fn(),
}));

vi.mock("@tanstack/react-db", () => ({
    useLiveQuery: () => ({ data: mocks.liveLogs }),
}));

vi.mock("@tanstack/react-virtual", () => ({
    useVirtualizer: ({ count }: { count: number }) => ({
        getTotalSize: () => count * 22,
        getVirtualItems: () =>
            Array.from({ length: count }, (_, index) => ({
                index,
                key: `row-${index}`,
                start: index * 22,
            })),
        measureElement: mocks.measureElement,
        scrollToIndex: mocks.scrollToIndex,
    }),
}));

vi.mock("../collections/logs", () => ({
    logsCollection: {
        *[Symbol.iterator]() {
            yield ["existing-1", {}];
            yield ["existing-2", {}];
        },
        isReady: () => true,
        utils: {
            writeDelete: mocks.writeDelete,
            writeInsert: mocks.writeInsert,
        },
    },
}));

vi.mock("../hooks", () => ({
    useLogContent: mocks.useLogContent,
    useLogFiles: mocks.useLogFiles,
    useOpenClawSocket: mocks.useOpenClawSocket,
}));

vi.mock("../components/features/logs", () => ({
    LevelFilter: ({
        activeLevels,
        levels,
        onToggle,
    }: {
        activeLevels: Set<string>;
        levels: string[];
        onToggle: (level: string) => void;
    }) => (
        <div data-testid="level-filter">
            {levels.map((level) => (
                <button key={level} type="button" onClick={() => onToggle(level)}>
                    {activeLevels.has(level) ? `Hide ${level}` : `Show ${level}`}
                </button>
            ))}
        </div>
    ),
    LogLine: ({ log }: { log: { raw?: string; msg?: string } }) => (
        <div data-testid="log-line">{log.raw || log.msg}</div>
    ),
}));

vi.mock("../components/ui/Select", () => ({
    Select: ({
        onChange,
        options,
        value,
    }: {
        onChange: (value: string) => void;
        options: Array<{ label: string; value: string }>;
        value: string;
    }) => (
        <select
            aria-label="select"
            value={value}
            onChange={(event) => onChange(event.target.value)}
        >
            <option value="">Select file...</option>
            {options.map((option) => (
                <option key={option.value} value={option.value}>
                    {option.label}
                </option>
            ))}
        </select>
    ),
}));

function mockLogs(overrides = {}) {
    mocks.liveLogs = [
        {
            id: "1",
            level: "info",
            msg: "first info",
            raw: "INFO first info",
        },
        {
            id: "2",
            level: "error",
            msg: "boom",
            raw: "ERROR boom",
        },
    ];
    mocks.useLogFiles.mockReturnValue({
        data: [{ name: "openclaw-2026-05-11.log" }, { name: "openclaw-2026-05-10.log" }],
    });
    mocks.useLogContent.mockReturnValue({
        isFetching: false,
        refetch: mocks.refetchContent,
    });
    mocks.useOpenClawSocket.mockReturnValue({
        connectionId: 1,
        isConnected: true,
        request: mocks.request,
    });

    for (const [key, value] of Object.entries(overrides)) {
        if (key === "liveLogs") mocks.liveLogs = value as typeof mocks.liveLogs;
        if (key === "logFiles") mocks.useLogFiles.mockReturnValue(value);
        if (key === "logContent") mocks.useLogContent.mockReturnValue(value);
        if (key === "socket") mocks.useOpenClawSocket.mockReturnValue(value);
    }
}

describe("Logs page", () => {
    beforeEach(() => {
        mocks.measureElement.mockReset();
        mocks.refetchContent.mockResolvedValue({ data: "INFO loaded\nERROR failed" });
        mocks.request.mockResolvedValue(Promise.resolve());
        mocks.scrollToIndex.mockReset();
        mocks.useLogContent.mockReset();
        mocks.useLogFiles.mockReset();
        mocks.useOpenClawSocket.mockReset();
        mocks.writeDelete.mockReset();
        mocks.writeInsert.mockReset();
        mocks.createObjectUrl.mockClear();
        mocks.revokeObjectUrl.mockClear();
        vi.stubGlobal("URL", {
            createObjectURL: mocks.createObjectUrl,
            revokeObjectURL: mocks.revokeObjectUrl,
        });
        HTMLAnchorElement.prototype.click = vi.fn();
        mockLogs();
    });

    it("subscribes to logs, selects the latest file, and renders log entries", async () => {
        render(<Logs />);

        await waitFor(() => {
            expect(mocks.request).toHaveBeenCalledWith("subscribe", {
                channel: "logs",
            });
        });
        expect(await screen.findByText("2 of 2 entries")).toBeInTheDocument();
        expect(screen.getByText("INFO first info")).toBeInTheDocument();
        expect(screen.getByText("ERROR boom")).toBeInTheDocument();
        expect(screen.getAllByLabelText("select")[0]).toHaveValue(
            "openclaw-2026-05-11.log"
        );
    });

    it("filters logs by search and level", async () => {
        const user = userEvent.setup();

        render(<Logs />);

        await user.type(screen.getByPlaceholderText("Search logs..."), "boom");
        expect(screen.getByText("1 of 2 entries")).toBeInTheDocument();
        expect(screen.queryByText("INFO first info")).not.toBeInTheDocument();
        expect(screen.getByText("ERROR boom")).toBeInTheDocument();

        await user.click(screen.getByRole("button", { name: "Hide error" }));
        expect(screen.getByText("No logs match your filter.")).toBeInTheDocument();
    });

    it("reloads log content into the collection and clears logs", async () => {
        const user = userEvent.setup();

        render(<Logs />);

        await waitFor(() => expect(mocks.refetchContent).toHaveBeenCalled());
        mocks.refetchContent.mockClear();
        mocks.writeDelete.mockClear();
        mocks.writeInsert.mockClear();

        await user.click(screen.getByRole("button", { name: "Reload" }));
        await waitFor(() => expect(mocks.refetchContent).toHaveBeenCalled());
        expect(mocks.writeDelete).toHaveBeenCalledWith("existing-1");
        expect(mocks.writeInsert).toHaveBeenCalledTimes(2);

        await user.click(screen.getByRole("button", { name: "Clear" }));
        expect(mocks.writeDelete).toHaveBeenCalledWith("existing-2");
    });

    it("exports filtered logs", async () => {
        const user = userEvent.setup();

        render(<Logs />);

        await user.click(screen.getByRole("button", { name: "Export" }));
        expect(mocks.createObjectUrl).toHaveBeenCalledTimes(1);
        expect(mocks.revokeObjectUrl).toHaveBeenCalledWith("blob:logs");
    });

    it("renders waiting state and disabled actions with no logs", () => {
        mockLogs({ liveLogs: [] });

        render(<Logs />);

        expect(screen.getByText("Waiting for logs...")).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Export" })).toBeDisabled();
        expect(screen.getByRole("button", { name: "Clear" })).toBeDisabled();
    });
});
