import { afterAll, beforeAll, describe, expect, jest, test } from "bun:test";

import type {
    LogMaintenanceStatusOutput,
    LogSnapshotOutput,
    LogSource,
} from "../../contracts/logs.ts";
import { LogsView } from "./LogsView.tsx";

const { act, fireEvent, render, screen, waitFor, within } =
    await import("@testing-library/react");
const userEventModule = await import("@testing-library/user-event");
const userEvent = userEventModule.default;

const hadOwnResizeObserver = Object.hasOwn(globalThis, "ResizeObserver");
const originalResizeObserver = Reflect.get(globalThis, "ResizeObserver");
const originalOffsetHeight = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "offsetHeight"
);
const originalOffsetWidth = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "offsetWidth"
);

function logViewportOffsetHeight(this: HTMLElement): number {
    return this.getAttribute("role") === "log" ? 560 : 0;
}

function logViewportOffsetWidth(this: HTMLElement): number {
    return this.getAttribute("role") === "log" ? 960 : 0;
}

beforeAll(() => {
    Reflect.set(globalThis, "ResizeObserver", undefined);
    Object.defineProperties(HTMLElement.prototype, {
        offsetHeight: {
            configurable: true,
            get: logViewportOffsetHeight,
        },
        offsetWidth: {
            configurable: true,
            get: logViewportOffsetWidth,
        },
    });
});

afterAll(() => {
    if (hadOwnResizeObserver) {
        Reflect.set(globalThis, "ResizeObserver", originalResizeObserver);
    } else {
        Reflect.deleteProperty(globalThis, "ResizeObserver");
    }
    if (originalOffsetHeight === undefined) {
        Reflect.deleteProperty(HTMLElement.prototype, "offsetHeight");
    } else {
        Object.defineProperty(
            HTMLElement.prototype,
            "offsetHeight",
            originalOffsetHeight
        );
    }
    if (originalOffsetWidth === undefined) {
        Reflect.deleteProperty(HTMLElement.prototype, "offsetWidth");
    } else {
        Object.defineProperty(HTMLElement.prototype, "offsetWidth", originalOffsetWidth);
    }
});

const sources: readonly LogSource[] = [
    {
        availability: "available",
        group: "dashboard",
        id: "dashboard.web.stderr",
        label: "Dashboard web stderr",
        modifiedAtMs: 1_800_000_000_000,
        sizeBytes: 2048,
    },
    {
        availability: "missing",
        group: "host",
        id: "host.auth",
        label: "Host authentication",
    },
];
const snapshot: LogSnapshotOutput = {
    hasEarlier: true,
    lines: [
        {
            id: "a".repeat(64),
            line: `{"_meta":{"logLevelName":"WARN","date":"2027-01-15T08:00:00.000Z"},"0":"[agent/main] Credential [REDACTED] <script>alert('unsafe')</script>","requestId":"request-42"}`,
            severity: "unknown",
        },
        {
            id: "c".repeat(64),
            line: "worker: raw [REDACTED] <script>alert('raw')</script>",
            severity: "error",
            timestampMs: 1_800_000_000_000,
        },
    ],
    observedAtMs: 1_800_000_001_000,
    revision: "b".repeat(64),
    scannedBytes: 4096,
    sourceId: sources[0]!.id,
};
const maintenance: LogMaintenanceStatusOutput = {
    observedAtMs: 1_800_000_001_000,
    policies: [
        {
            id: "docker-managed",
            label: "Managed application and container logs",
            scope: "docker",
            state: "queueable",
        },
        {
            id: "host-alternatives",
            label: "Host alternatives log",
            scope: "host",
            state: "unavailable",
        },
        {
            id: "host-apport",
            label: "Host Apport log",
            scope: "host",
            state: "unavailable",
        },
        {
            id: "host-dpkg",
            label: "Host package log",
            scope: "host",
            state: "unavailable",
        },
        {
            id: "host-rsyslog",
            label: "Host system logs",
            scope: "host",
            state: "unavailable",
        },
    ],
};

function properties() {
    return {
        maintenance,
        onClearSearch: jest.fn(),
        onRefresh: jest.fn(),
        onRequestMaintenance: jest.fn(() =>
            Promise.resolve({
                jobRunId: "log-maintenance-run",
                policyId: "docker-managed" as const,
                queued: true as const,
            })
        ),
        onSearch: jest.fn(),
        onSelectSource: jest.fn(),
        selectedSourceId: sources[0]!.id,
        snapshot,
        sources,
    };
}

function stableId(index: number): string {
    return index.toString(16).padStart(64, "0");
}

function scrollingSnapshot(
    count: number,
    revisionCharacter: string,
    sourceId = sources[0]!.id
): LogSnapshotOutput {
    return {
        hasEarlier: true,
        lines: Array.from({ length: count }, (_, index) => ({
            id: stableId(index + 1),
            line: `worker: chronological line ${index + 1}`,
            severity: "info" as const,
            timestampMs: 1_800_000_000_000 + index,
        })),
        observedAtMs: 1_800_000_100_000,
        revision: revisionCharacter.repeat(64),
        scannedBytes: 32_768,
        sourceId,
    };
}

async function flushAnimationFrames(frameCount = 6): Promise<void> {
    await act(async () => {
        for (let index = 0; index < frameCount; index += 1) {
            await new Promise<void>((resolve) => {
                requestAnimationFrame(() => resolve());
            });
        }
    });
}

describe("LogsView", () => {
    test("renders structured and raw redacted rows inertly with log metadata", async () => {
        const props = properties();
        const { container } = render(<LogsView {...props} />);
        const log = screen.getByRole("log", {
            name: "Log lines with sensitive values removed",
        });
        await waitFor(() =>
            expect(log).toHaveTextContent(
                "Credential [REDACTED] <script>alert('unsafe')</script>"
            )
        );
        expect(log).toHaveTextContent("raw [REDACTED] <script>alert('raw')</script>");
        expect(screen.getByLabelText("Level warn")).toHaveTextContent("warn");
        expect(screen.getByLabelText("Source main")).toHaveTextContent("main");
        expect(screen.getByLabelText("Source worker")).toHaveTextContent("worker");
        expect(screen.getByText("requestId=")).toBeTruthy();
        expect(screen.getByText("request-42")).toBeTruthy();
        expect(container.querySelector("time")?.getAttribute("datetime")).toBe(
            "2027-01-15T08:00:00.000Z"
        );
        expect(screen.getByLabelText("Plain text log line")).toBeTruthy();
        expect(container.querySelector("script")).toBeNull();

        const user = userEvent.setup();
        await user.click(
            screen.getAllByRole("button", {
                name: "Original line (sensitive values removed)",
            })[0]!
        );
        expect(log).toHaveTextContent('"requestId":"request-42"');
        const search = screen.getByRole("searchbox", { name: "Search logs" });
        expect(search).toHaveAttribute(
            "placeholder",
            'Try "request-42" or "connection failed"'
        );
        await user.type(search, "request-42");
        await user.click(screen.getByRole("button", { name: "Search" }));
        expect(props.onSearch).toHaveBeenCalledWith("request-42");
    });

    test("balances source and search fields with an aria-hidden description row", () => {
        const { container } = render(<LogsView {...properties()} />);
        const spacer = container.querySelector<HTMLElement>(
            "[data-log-source-description-spacer]"
        );
        const sourceSelect = container.querySelector<HTMLElement>(
            '[aria-haspopup="listbox"]'
        );

        expect(spacer).toHaveClass("invisible", "select-none");
        expect(spacer).toHaveAttribute("aria-hidden", "true");
        expect(spacer).toHaveTextContent("Searches recent lines from this source.");
        expect(sourceSelect).not.toBeNull();
        expect(sourceSelect).not.toHaveAccessibleDescription(
            "Searches recent lines from this source."
        );
        expect(
            screen.getByRole("searchbox", { name: "Search logs" })
        ).toHaveAccessibleDescription("Searches recent lines from this source.");
    });

    test("renders kernel/syslog metadata and the richer color-coded OpenClaw summary", async () => {
        const richSnapshot: LogSnapshotOutput = {
            hasEarlier: false,
            lines: [
                {
                    id: stableId(20),
                    line: "Aug 10 01:23:45 host kernel: [123.456] device ready",
                    severity: "unknown",
                },
                {
                    id: stableId(21),
                    line: String.raw`{"0":"{\"subsystem\":\"gateway/ws\"}","1":"↔ response ✓ request-42","_meta":{"date":"2026-08-10T01:24:45.000Z","logLevelName":"INFO"}}`,
                    severity: "unknown",
                },
            ],
            observedAtMs: new Date(2026, 7, 10, 12).getTime(),
            revision: "e".repeat(64),
            scannedBytes: 2048,
            sourceId: "host.kern",
        };
        const rendered = render(<LogsView {...properties()} snapshot={richSnapshot} />);

        await waitFor(() =>
            expect(screen.getByLabelText("Source gateway/ws")).toBeVisible()
        );
        expect(screen.getByLabelText("Source kernel")).toBeVisible();
        expect(screen.getByText("↔ response ✓ request-42")).toBeVisible();
        expect(screen.queryByText(/subsystem.*gateway\/ws/u)).toBeNull();
        expect(rendered.container.querySelectorAll("time")).toHaveLength(2);
        const sourceToken = screen.getByLabelText("Source gateway/ws");
        expect(sourceToken).toHaveAttribute("data-log-source-token");
        expect(sourceToken.querySelector(".text-cyan-300")).toHaveTextContent("gateway");
        expect(sourceToken.querySelector(".text-amber-300")).toHaveTextContent("ws");
        expect(rendered.container.querySelector("script")).toBeNull();
    });

    test("keeps unknown rows only in the all-levels state and shows a clear empty state", async () => {
        const levelSnapshot: LogSnapshotOutput = {
            ...scrollingSnapshot(0, "f"),
            hasEarlier: false,
            lines: [
                ...(["trace", "debug", "info", "warn", "error", "fatal"] as const).map(
                    (level, index) => ({
                        id: stableId(30 + index),
                        line: JSON.stringify({ level, message: `${level} row` }),
                        severity: level,
                    })
                ),
                {
                    id: stableId(40),
                    line: "unclassified current-window row",
                    severity: "unknown",
                },
            ],
        };
        const user = userEvent.setup();
        render(<LogsView {...properties()} snapshot={levelSnapshot} />);

        await waitFor(() =>
            expect(screen.getByText("unclassified current-window row")).toBeVisible()
        );
        await user.click(screen.getByRole("button", { name: "trace" }));
        expect(screen.queryByText("unclassified current-window row")).toBeNull();
        expect(screen.queryByText("trace row")).toBeNull();
        expect(screen.getByText("debug row")).toBeVisible();

        await user.click(screen.getByRole("button", { name: "Clear all log levels" }));
        expect(
            screen.getByRole("heading", {
                name: "No log lines at the selected levels",
            })
        ).toBeVisible();
        expect(
            screen.getByText("Select one or more levels, or choose All.")
        ).toBeVisible();

        await user.click(screen.getByRole("button", { name: "Select all log levels" }));
        await waitFor(() =>
            expect(screen.getByText("unclassified current-window row")).toBeVisible()
        );
    });

    test("starts at latest, preserves reading position through refresh, follows at the end, and resets scope", async () => {
        let scrollHeight = 2000;
        const initial = scrollingSnapshot(40, "1");
        const rendered = render(<LogsView {...properties()} snapshot={initial} />);
        const log = screen.getByRole("log", {
            name: "Log lines with sensitive values removed",
        });
        Object.defineProperties(log, {
            clientHeight: { configurable: true, value: 200 },
            scrollHeight: {
                configurable: true,
                get: () => scrollHeight,
            },
        });
        await flushAnimationFrames();
        expect(log.scrollTop).toBe(2000);
        expect(screen.queryByRole("button", { name: "Jump to latest" })).toBeNull();

        act(() => {
            fireEvent.wheel(log, { deltaY: -400 });
            log.scrollTop = 500;
            fireEvent.scroll(log);
        });
        expect(screen.getByRole("button", { name: "Jump to latest" })).toBeVisible();

        scrollHeight = 2200;
        rendered.rerender(
            <LogsView {...properties()} snapshot={scrollingSnapshot(41, "2")} />
        );
        await flushAnimationFrames();
        expect(log.scrollTop).toBe(500);

        act(() => {
            fireEvent.click(screen.getByRole("button", { name: "Jump to latest" }));
        });
        await flushAnimationFrames();
        expect(log.scrollTop).toBe(2200);

        scrollHeight = 2300;
        rendered.rerender(
            <LogsView {...properties()} snapshot={scrollingSnapshot(42, "3")} />
        );
        await flushAnimationFrames();
        expect(log.scrollTop).toBe(2300);

        scrollHeight = 900;
        rendered.rerender(
            <LogsView
                {...properties()}
                selectedSourceId={sources[1]!.id}
                snapshot={scrollingSnapshot(12, "4", sources[1]!.id)}
            />
        );
        await flushAnimationFrames();
        expect(log.scrollTop).toBe(900);
        act(() => rendered.unmount());
    });

    test("confirms a queueable fixed policy before queueing it", async () => {
        const props = properties();
        const user = userEvent.setup();
        render(<LogsView {...props} />);

        await user.click(
            screen.getByRole("button", {
                name: "Run Managed application and container logs",
            })
        );
        const dialog = screen.getByRole("dialog", {
            name: "Run Managed application and container logs?",
        });
        await user.click(within(dialog).getByRole("button", { name: "Add to queue" }));

        await waitFor(() =>
            expect(props.onRequestMaintenance).toHaveBeenCalledWith("docker-managed")
        );
        expect(
            await screen.findByText(/was added to the queue as job log-maintenance-run/u)
        ).toBeTruthy();
    });

    test("keeps unavailable sources and policies visible but disabled", () => {
        render(<LogsView {...properties()} />);
        expect(
            screen.getByRole("button", { name: "Run Host alternatives log" })
        ).toBeDisabled();
    });
});
