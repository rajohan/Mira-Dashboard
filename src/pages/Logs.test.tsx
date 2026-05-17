import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { compareLogFileNamesDescending, isNamedLogFile, Logs } from "./Logs";

const mocks = vi.hoisted(() => ({
    createObjectUrl: vi.fn(() => "blob:logs"),
    liveLogs: [] as Array<{
        id: string;
        level?: unknown;
        msg?: unknown;
        raw?: unknown;
    }>,
    logsReady: true,
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
    useLiveQuery: (select: (query: { from: () => typeof mocks.liveLogs }) => unknown) => {
        const data = select({ from: () => mocks.liveLogs });
        return { data };
    },
}));

vi.mock("@tanstack/react-virtual", () => ({
    useVirtualizer: ({
        count,
        estimateSize,
        getItemKey,
        getScrollElement,
        measureElement,
    }: {
        count: number;
        estimateSize: () => number;
        getItemKey: (index: number) => string | number;
        getScrollElement: () => Element | null;
        measureElement: (element: Element) => number;
    }) => {
        getScrollElement();
        estimateSize();
        if (count > 0) getItemKey(0);
        if (count > 1) getItemKey(1);
        measureElement({ getBoundingClientRect: () => ({ height: 22.2 }) } as Element);
        return {
            getTotalSize: () => count * 22,
            getVirtualItems: () =>
                Array.from({ length: count + (count > 0 ? 1 : 0) }, (_, index) => ({
                    index,
                    key: `row-${index}`,
                    start: index * 22,
                })),
            measureElement: mocks.measureElement,
            scrollToIndex: mocks.scrollToIndex,
        };
    },
}));

vi.mock("../collections/logs", () => ({
    logsCollection: {
        *[Symbol.iterator]() {
            yield ["existing-1", {}];
            yield ["existing-2", {}];
        },
        isReady: () => mocks.logsReady,
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
    mocks.logsReady = true;
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
        data: [{ name: "openclaw-2099-01-02.log" }, { name: "openclaw-2099-01-01.log" }],
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

describe("Logs helpers", () => {
    it("recognizes named log files and sorts names descending", () => {
        expect(isNamedLogFile({ name: "openclaw.log" })).toBe(true);
        expect(isNamedLogFile({ name: "   " })).toBe(false);
        expect(isNamedLogFile(null)).toBe(false);
        expect(isNamedLogFile({ name: 123 })).toBe(false);
        expect(
            [{ name: "a.log" }, { name: "c.log" }, { name: undefined }].sort(
                compareLogFileNamesDescending
            )
        ).toEqual([{ name: "c.log" }, { name: "a.log" }, { name: undefined }]);
    });
});

describe("Logs page", () => {
    beforeEach(() => {
        mocks.measureElement.mockReset();
        mocks.refetchContent.mockResolvedValue({ data: "INFO loaded\nERROR failed" });
        mocks.request.mockReset();
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
            "openclaw-2099-01-02.log"
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

    it("changes selected file and requested line count", async () => {
        const user = userEvent.setup();

        render(<Logs />);

        await waitFor(() => {
            expect(mocks.useLogContent).toHaveBeenCalledWith(
                "openclaw-2099-01-02.log",
                100,
                false
            );
        });

        const selects = screen.getAllByLabelText("select");
        await user.selectOptions(selects[0]!, "openclaw-2099-01-01.log");
        await waitFor(() => {
            expect(mocks.useLogContent).toHaveBeenLastCalledWith(
                "openclaw-2099-01-01.log",
                100,
                false
            );
        });

        await user.selectOptions(selects[1]!, "500");
        await waitFor(() => {
            expect(mocks.useLogContent).toHaveBeenLastCalledWith(
                "openclaw-2099-01-01.log",
                500,
                false
            );
        });
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

    it("shows follow control when scrolled away from the bottom", async () => {
        const user = userEvent.setup();

        render(<Logs />);

        const container = screen
            .getByText("INFO first info")
            .closest(".overflow-y-auto") as HTMLDivElement;
        Object.defineProperties(container, {
            clientHeight: { configurable: true, value: 200 },
            scrollHeight: { configurable: true, value: 1000 },
        });
        container.scrollTop = 100;

        fireEvent.scroll(container);
        const followButton = await screen.findByRole("button", { name: "↓ Follow" });
        await user.click(followButton);

        expect(container.scrollTop).toBe(1000);
        expect(
            screen.queryByRole("button", { name: "↓ Follow" })
        ).not.toBeInTheDocument();
    });

    it("retains previous log files and handles non-array data", () => {
        const { rerender } = render(<Logs />);
        expect(screen.getAllByLabelText("select")[0]).toHaveValue(
            "openclaw-2099-01-02.log"
        );

        mockLogs({ logFiles: { data: [] } });
        rerender(<Logs />);
        expect(screen.getAllByLabelText("select")[0]).toHaveValue(
            "openclaw-2099-01-02.log"
        );

        mockLogs({ liveLogs: null, logFiles: { data: null } });
        rerender(<Logs />);
        expect(screen.getByText("Waiting for logs...")).toBeInTheDocument();
    });

    it("keeps selected files stable across identical file snapshot refreshes", async () => {
        const user = userEvent.setup();
        const files = [
            { name: "openclaw-2099-01-02.log" },
            { name: "openclaw-2099-01-01.log" },
        ];
        mockLogs({ logFiles: { data: files } });

        const { rerender } = render(<Logs />);

        expect(await screen.findByText("2 of 2 entries")).toBeInTheDocument();
        expect(screen.getAllByLabelText("select")[0]).toHaveValue(
            "openclaw-2099-01-02.log"
        );
        await user.selectOptions(
            screen.getAllByLabelText("select")[0]!,
            "openclaw-2099-01-01.log"
        );

        mockLogs({ logFiles: { data: [...files] } });
        rerender(<Logs />);

        expect(screen.getAllByLabelText("select")[0]).toHaveValue(
            "openclaw-2099-01-01.log"
        );
    });

    it("ignores stale log reload responses", async () => {
        const user = userEvent.setup();
        let resolveFirstReload: (value: { data: string }) => void = () => {};

        render(<Logs />);

        await waitFor(() => expect(mocks.refetchContent).toHaveBeenCalled());
        mocks.refetchContent.mockReset();
        mocks.writeInsert.mockClear();
        mocks.refetchContent
            .mockReturnValueOnce(
                new Promise((resolve) => {
                    resolveFirstReload = resolve;
                })
            )
            .mockResolvedValueOnce({ data: "ERROR fresh reload" });

        await user.click(screen.getByRole("button", { name: "Reload" }));
        await user.click(screen.getByRole("button", { name: "Reload" }));
        await waitFor(() =>
            expect(mocks.writeInsert).toHaveBeenCalledWith(
                expect.objectContaining({ raw: "ERROR fresh reload" })
            )
        );

        mocks.writeInsert.mockClear();
        await act(async () => {
            resolveFirstReload({ data: "INFO stale reload" });
            await Promise.resolve();
        });

        expect(mocks.writeInsert).not.toHaveBeenCalledWith(
            expect.objectContaining({ raw: "INFO stale reload" })
        );
    });

    it("handles socket and load-content edge cases", async () => {
        const user = userEvent.setup();
        const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

        try {
            mockLogs({
                socket: { connectionId: 1, isConnected: false, request: mocks.request },
            });
            const { rerender } = render(<Logs />);
            expect(mocks.request).not.toHaveBeenCalled();

            mocks.request.mockRejectedValueOnce(new Error("subscribe failed"));
            mockLogs();
            rerender(<Logs />);
            await waitFor(() => expect(consoleError).toHaveBeenCalled());

            mocks.logsReady = false;
            mocks.refetchContent.mockResolvedValueOnce({ data: "INFO skipped" });
            await user.click(screen.getByRole("button", { name: "Reload" }));
            await waitFor(() => expect(mocks.refetchContent).toHaveBeenCalled());
            expect(mocks.writeInsert).not.toHaveBeenCalledWith(
                expect.objectContaining({ raw: "INFO skipped" })
            );
        } finally {
            consoleError.mockRestore();
        }
    });

    it("renders loading and fallback log values", async () => {
        const user = userEvent.setup();
        mockLogs({
            liveLogs: [{ id: "3", level: null, msg: "fallback msg" }],
            logContent: { isFetching: true, refetch: mocks.refetchContent },
        });

        render(<Logs />);

        expect(screen.getByText("Loading...")).toBeInTheDocument();
        expect(screen.getByText("fallback msg")).toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "Export" }));
        expect(mocks.createObjectUrl).toHaveBeenCalledTimes(1);
    });

    it("renders waiting state and disabled actions with no logs", () => {
        mockLogs({ liveLogs: [] });

        render(<Logs />);

        expect(screen.getByText("Waiting for logs...")).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Export" })).toBeDisabled();
        expect(screen.getByRole("button", { name: "Clear" })).toBeDisabled();
    });
});
