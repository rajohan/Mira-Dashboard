import { afterAll, beforeAll, describe, expect, jest, test } from "bun:test";

import type { JobRunSummary } from "../../contracts/jobModel.ts";
import type {
    LogMaintenancePolicyId,
    LogMaintenanceStatusOutput,
    LogSnapshotOutput,
    LogSource,
} from "../../contracts/logs.ts";
import { filterableLogLevels } from "./logLevelFiltering.ts";
import { LogsView } from "./LogsView.tsx";

const { act, fireEvent, render, screen, waitFor, within } =
    await import("@testing-library/react");
const userEventModule = await import("@testing-library/user-event");
const userEvent = userEventModule.default;

function deferred<T>() {
    let resolveDeferred!: (value: T) => void;
    let rejectDeferred!: (reason?: unknown) => void;
    const promise = new Promise<T>((resolve, reject) => {
        resolveDeferred = resolve;
        rejectDeferred = reject;
    });
    return { promise, reject: rejectDeferred, resolve: resolveDeferred };
}

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
                dryRun: false,
                jobRunId: "log-maintenance-run",
                policyId: "docker-managed" as const,
                queued: true as const,
            })
        ),
        onSearch: jest.fn(),
        onSelectSource: jest.fn(),
        onRowCountChange: jest.fn(),
        rowCount: 200,
        selectedSourceId: sources[0]!.id,
        snapshot,
        sources,
    };
}

function maintenanceRun(
    state: "queued" | "succeeded",
    id: string,
    timestampMs: number
): JobRunSummary {
    const started = state === "succeeded";
    return {
        actionKey: "maintenance.rotate-logs",
        attemptCount: started ? 1 : 0,
        attemptLimit: 1,
        availableAtMs: timestampMs,
        cancellationPolicy: "cooperative",
        displayName: "Managed log maintenance",
        eventCount: started ? 3 : 1,
        ...(started ? { finishedAtMs: timestampMs + 2000 } : {}),
        ...(started ? { firstStartedAtMs: timestampMs + 1000 } : {}),
        id,
        ...(started ? { lastAttemptStartedAtMs: timestampMs + 1000 } : {}),
        priority: 0,
        queuedAtMs: timestampMs,
        resourceClass: "host-heavy",
        resourceKeys: ["host.logs"],
        retrySafe: false,
        state,
        stateVersion: started ? 3 : 1,
        timeoutMs: 300_000,
        triggerType: "system",
        updatedAtMs: timestampMs + (started ? 2000 : 0),
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
        expect(screen.getByLabelText("Log snapshot summary")).toHaveAttribute(
            "tabindex",
            "0"
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
        await waitFor(() => expect(props.onSearch).toHaveBeenCalledWith("request-42"));
        expect(screen.queryByRole("button", { name: "Search" })).toBeNull();
    });

    test("exports only the bounded server-redacted lines as inert text", async () => {
        const exportedBlobs: Blob[] = [];
        const createObjectUrl = jest.fn((blob: Blob) => {
            exportedBlobs.push(blob);
            return "blob:redacted-log-export";
        });
        const revokeObjectUrl = jest.fn();
        const createDescriptor = Object.getOwnPropertyDescriptor(URL, "createObjectURL");
        const revokeDescriptor = Object.getOwnPropertyDescriptor(URL, "revokeObjectURL");
        let activatedDownload: HTMLAnchorElement | undefined;
        const click = jest
            .spyOn(HTMLAnchorElement.prototype, "click")
            .mockImplementation(() => {
                activatedDownload =
                    document.body.querySelector<HTMLAnchorElement>("a[download]") ??
                    undefined;
            });
        Object.defineProperties(URL, {
            createObjectURL: { configurable: true, value: createObjectUrl },
            revokeObjectURL: { configurable: true, value: revokeObjectUrl },
        });

        try {
            render(<LogsView {...properties()} />);
            await userEvent.setup().click(screen.getByRole("button", { name: "Export" }));

            expect(exportedBlobs).toHaveLength(1);
            expect(exportedBlobs[0]?.type).toBe("text/plain;charset=utf-8");
            expect(await exportedBlobs[0]?.text()).toBe(
                snapshot.lines.map(({ line }) => line).join("\n")
            );
            expect(activatedDownload?.download).toBe(
                `mira-dashboard-${snapshot.sourceId}-${snapshot.revision.slice(0, 12)}.log`
            );
            expect(activatedDownload?.href).toBe("blob:redacted-log-export");
            expect(document.body.contains(activatedDownload ?? null)).toBeFalse();
            expect(revokeObjectUrl).toHaveBeenCalledWith("blob:redacted-log-export");
        } finally {
            click.mockRestore();
            if (createDescriptor === undefined) {
                Reflect.deleteProperty(URL, "createObjectURL");
            } else {
                Object.defineProperty(URL, "createObjectURL", createDescriptor);
            }
            if (revokeDescriptor === undefined) {
                Reflect.deleteProperty(URL, "revokeObjectURL");
            } else {
                Object.defineProperty(URL, "revokeObjectURL", revokeDescriptor);
            }
        }
    });

    test("keeps an explicit refresh action while search polling is disabled", async () => {
        const props = properties();
        render(<LogsView {...props} searchQuery="request-42" />);

        const user = userEvent.setup();
        await user.click(screen.getByRole("button", { name: "Refresh log search" }));

        expect(props.onRefresh).toHaveBeenCalledTimes(1);
    });

    test("clears the bounded current buffer without hiding new rows or crossing scopes", async () => {
        const rendered = render(<LogsView {...properties()} />);
        const user = userEvent.setup();

        await user.click(screen.getByRole("button", { name: "Clear buffer" }));
        expect(
            screen.getByRole("heading", { name: "Current log buffer cleared" })
        ).toBeVisible();
        expect(screen.queryByText(/Credential \[REDACTED\]/u)).toBeNull();

        const appendedLine = {
            id: "d".repeat(64),
            line: "worker: newly appended redacted row",
            severity: "info" as const,
        };
        const refreshedSnapshot: LogSnapshotOutput = {
            ...snapshot,
            lines: [...snapshot.lines, appendedLine],
            revision: "e".repeat(64),
        };
        rendered.rerender(<LogsView {...properties()} snapshot={refreshedSnapshot} />);

        expect(await screen.findByText("newly appended redacted row")).toBeVisible();
        expect(screen.queryByText(/Credential \[REDACTED\]/u)).toBeNull();
        expect(screen.queryByText(/raw \[REDACTED\]/u)).toBeNull();

        rendered.rerender(
            <LogsView {...properties()} rowCount={500} snapshot={refreshedSnapshot} />
        );
        expect(await screen.findByText(/Credential \[REDACTED\]/u)).toBeVisible();
        expect(screen.getByText(/raw \[REDACTED\]/u)).toBeVisible();
    });

    test("clears the complete buffer when level filters hide every row", async () => {
        const rendered = render(<LogsView {...properties()} />);
        const user = userEvent.setup();

        for (const level of filterableLogLevels) {
            await user.click(screen.getByRole("button", { name: level }));
        }
        expect(
            screen.getByRole("heading", {
                name: "No log lines at the selected levels",
            })
        ).toBeVisible();
        const clearBuffer = screen.getByRole("button", { name: "Clear buffer" });
        expect(clearBuffer).toBeEnabled();

        await user.click(clearBuffer);
        expect(
            screen.getByRole("heading", { name: "Current log buffer cleared" })
        ).toBeVisible();
        for (const level of filterableLogLevels) {
            await user.click(screen.getByRole("button", { name: level }));
        }
        expect(screen.queryByText(/Credential \[REDACTED\]/u)).toBeNull();
        expect(screen.queryByText(/raw \[REDACTED\]/u)).toBeNull();

        const appendedLine = {
            id: "d".repeat(64),
            line: "worker: genuinely new row after hidden-level clear",
            severity: "info" as const,
        };
        rendered.rerender(
            <LogsView
                {...properties()}
                snapshot={{
                    ...snapshot,
                    lines: [...snapshot.lines, appendedLine],
                    revision: "e".repeat(64),
                }}
            />
        );

        expect(
            await screen.findByText("genuinely new row after hidden-level clear")
        ).toBeVisible();
        expect(screen.queryByText(/Credential \[REDACTED\]/u)).toBeNull();
        expect(screen.queryByText(/raw \[REDACTED\]/u)).toBeNull();
    });

    test("keeps source controls and log output in one compact card", () => {
        const { container } = render(<LogsView {...properties()} />);
        const sourceSelect = container.querySelector<HTMLElement>(
            '[aria-haspopup="listbox"]'
        );
        const logViewer = screen.getByRole("region", { name: "Log viewer" });

        expect(
            container.querySelector("[data-log-source-description-spacer]")
        ).toBeNull();
        expect(sourceSelect).not.toBeNull();
        expect(sourceSelect).not.toHaveAccessibleDescription(
            "Searches recent lines from this source."
        );
        expect(
            screen.getByRole("searchbox", { name: "Search logs" })
        ).not.toHaveAccessibleDescription();
        expect(sourceSelect?.closest("section")).toBe(logViewer);
        expect(
            screen.queryByRole("heading", { name: "Dashboard web stderr" })
        ).toBeNull();
        expect(screen.queryByText("Latest lines")).toBeNull();
        expect(screen.queryByRole("button", { name: "Refresh" })).toBeNull();
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

        for (const level of filterableLogLevels.slice(1)) {
            await user.click(screen.getByRole("button", { name: level }));
        }
        expect(
            screen.getByRole("heading", {
                name: "No log lines at the selected levels",
            })
        ).toBeVisible();
        expect(screen.getByText("Select one or more log levels.")).toBeVisible();

        for (const level of filterableLogLevels) {
            await user.click(screen.getByRole("button", { name: level }));
        }
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
        const resetLog = screen.getByRole("log", {
            name: "Log lines with sensitive values removed",
        });
        Object.defineProperties(resetLog, {
            clientHeight: { configurable: true, value: 200 },
            scrollHeight: {
                configurable: true,
                get: () => scrollHeight,
            },
        });
        await flushAnimationFrames();
        expect(resetLog.scrollTop).toBe(900);
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
            expect(props.onRequestMaintenance).toHaveBeenCalledWith(
                "docker-managed",
                false
            )
        );
        expect(
            await screen.findByText(/was added to the queue as job log-maintenance-run/u)
        ).toBeTruthy();
    });

    test("closes confirmation before an unavailable policy can be submitted", async () => {
        const props = properties();
        const user = userEvent.setup();
        const rendered = render(<LogsView {...props} />);

        await user.click(
            screen.getByRole("button", {
                name: "Run Managed application and container logs",
            })
        );
        expect(screen.getByRole("dialog")).toBeVisible();

        rendered.rerender(
            <LogsView
                {...props}
                maintenance={{
                    ...maintenance,
                    observedAtMs: maintenance.observedAtMs + 1,
                    policies: maintenance.policies.map((policy) =>
                        policy.id === "docker-managed"
                            ? { ...policy, state: "unavailable" as const }
                            : policy
                    ),
                }}
            />
        );

        expect(screen.queryByRole("dialog")).toBeNull();
        expect(
            screen.getByRole("button", {
                name: "Run Managed application and container logs",
            })
        ).toBeDisabled();
        expect(props.onRequestMaintenance).not.toHaveBeenCalled();
    });

    test("confirms the docker-only dry-run separately and announces its queued job", async () => {
        const props = {
            ...properties(),
            onRequestMaintenance: jest.fn(
                (policyId: LogMaintenancePolicyId, dryRun: boolean) =>
                    Promise.resolve({
                        dryRun,
                        jobRunId: "dry-run-job",
                        policyId,
                        queued: true as const,
                    })
            ),
        };
        const user = userEvent.setup();
        render(<LogsView {...props} />);

        expect(screen.queryByRole("button", { name: /Dry run Host/u })).toBeNull();
        await user.click(
            screen.getByRole("button", {
                name: "Dry run Managed application and container logs",
            })
        );
        const dialog = screen.getByRole("dialog", {
            name: "Dry run Managed application and container logs?",
        });
        expect(dialog).toHaveTextContent("read-only preview");
        await user.click(within(dialog).getByRole("button", { name: "Queue dry run" }));

        await waitFor(() =>
            expect(props.onRequestMaintenance).toHaveBeenCalledWith(
                "docker-managed",
                true
            )
        );
        expect(
            await screen.findByText(/Dry run was added to the queue as job dry-run-job/u)
        ).toBeVisible();
    });

    test("presents active lifecycle and the last terminal bounded summary", () => {
        const activeRun = maintenanceRun(
            "queued",
            "019fdf70-0000-7000-8000-000000000010",
            1_800_000_002_000
        );
        const lastRun = maintenanceRun(
            "succeeded",
            "019fdf70-0000-7000-8000-000000000011",
            1_800_000_000_000
        );
        const lifecycle: LogMaintenanceStatusOutput = {
            ...maintenance,
            policies: maintenance.policies.map((policy) => {
                if (policy.id === "docker-managed") {
                    return {
                        ...policy,
                        activeRun,
                        lastRun: {
                            run: lastRun,
                            summary: {
                                actionCounts: {
                                    compressed: 2,
                                    deleted: 1,
                                    error: 0,
                                    missing: 0,
                                    rotated: 3,
                                    skipped: 1,
                                },
                                checkedTargets: 7,
                                dryRun: false,
                                finishedAtMs: 1_800_000_002_000,
                                ok: true,
                                startedAtMs: 1_800_000_001_000,
                            },
                        },
                    };
                }
                return policy.id === "host-alternatives"
                    ? { ...policy, state: "queueable" as const }
                    : policy;
            }),
        };
        render(<LogsView {...properties()} maintenance={lifecycle} />);

        expect(
            screen.getByRole("status", {
                name: "Active maintenance run for Managed application and container logs",
            })
        ).toHaveTextContent("queued");
        expect(
            screen.getByLabelText(
                "Last maintenance run for Managed application and container logs"
            )
        ).toHaveTextContent("succeeded");
        const summary = screen.getByLabelText(
            "Managed application and container logs last-run summary"
        );
        expect(summary).toHaveTextContent("Checked7");
        expect(summary).toHaveTextContent("Rotated3");
        expect(
            screen.getByRole("button", {
                name: "Run Managed application and container logs",
            })
        ).toBeDisabled();
        expect(
            screen.getByRole("button", {
                name: "Dry run Managed application and container logs",
            })
        ).toBeDisabled();
        expect(
            screen.getByRole("button", { name: "Run Host alternatives log" })
        ).toBeDisabled();
    });

    test("warns only when a succeeded managed run has no verified result summary", () => {
        const managedRun = maintenanceRun(
            "succeeded",
            "019fdf70-0000-7000-8000-000000000014",
            1_800_000_002_000
        );
        const hostRun = maintenanceRun(
            "succeeded",
            "019fdf70-0000-7000-8000-000000000015",
            1_800_000_003_000
        );
        const lifecycle: LogMaintenanceStatusOutput = {
            ...maintenance,
            policies: maintenance.policies.map((policy) => {
                if (policy.id === "docker-managed") {
                    return { ...policy, lastRun: { run: managedRun } };
                }
                return policy.id === "host-alternatives"
                    ? { ...policy, lastRun: { run: hostRun } }
                    : policy;
            }),
        };

        render(<LogsView {...properties()} maintenance={lifecycle} />);

        expect(
            screen.getAllByText(
                "The durable maintenance result could not be verified. Lifecycle status remains visible, but result details are hidden."
            )
        ).toHaveLength(1);
        expect(
            screen.getByLabelText("Last maintenance run for Host alternatives log")
        ).toHaveTextContent("succeeded");
    });

    test("keeps maintenance available without log sources", async () => {
        const props = properties();
        render(
            <LogsView
                {...props}
                selectedSourceId={undefined}
                snapshot={undefined}
                sources={[]}
            />
        );

        expect(screen.getByRole("heading", { name: "No log sources" })).toBeVisible();
        expect(screen.getByRole("heading", { name: "Log maintenance" })).toBeVisible();
        expect(
            screen.getByRole("button", {
                name: "Run Managed application and container logs",
            })
        ).toBeEnabled();
        const user = userEvent.setup();
        await user.click(screen.getByRole("button", { name: "Refresh sources" }));
        expect(props.onRefresh).toHaveBeenCalledTimes(1);
        expect(screen.queryByRole("button", { name: "Refresh maintenance" })).toBeNull();
    });

    test("disables cached maintenance actions after a status refetch error", () => {
        render(
            <LogsView
                {...properties()}
                maintenanceError="Maintenance status is temporarily unavailable."
            />
        );

        expect(
            screen.getByRole("button", {
                name: "Run Managed application and container logs",
            })
        ).toBeDisabled();
        expect(
            screen.getByText("Maintenance status is temporarily unavailable.")
        ).toBeVisible();
    });

    test("closes an open confirmation when authoritative status reports a global run", () => {
        const rendered = render(<LogsView {...properties()} />);
        act(() => {
            fireEvent.click(
                screen.getByRole("button", {
                    name: "Run Managed application and container logs",
                })
            );
        });
        expect(
            screen.getByRole("dialog", {
                name: "Run Managed application and container logs?",
            })
        ).toBeVisible();

        rendered.rerender(
            <LogsView
                {...properties()}
                maintenance={{
                    ...maintenance,
                    observedAtMs: maintenance.observedAtMs + 1,
                }}
            />
        );
        expect(
            screen.getByRole("dialog", {
                name: "Run Managed application and container logs?",
            })
        ).toBeVisible();

        const activeRun = maintenanceRun(
            "queued",
            "019fdf70-0000-7000-8000-000000000099",
            1_800_000_004_000
        );
        const activeMaintenance: LogMaintenanceStatusOutput = {
            ...maintenance,
            observedAtMs: maintenance.observedAtMs + 2,
            policies: maintenance.policies.map((policy) =>
                policy.id === "docker-managed" ? { ...policy, activeRun } : policy
            ),
        };
        rendered.rerender(<LogsView {...properties()} maintenance={activeMaintenance} />);
        expect(screen.queryByRole("dialog")).toBeNull();
        expect(
            screen.getByRole("button", { name: "Run Host alternatives log" })
        ).toBeDisabled();

        rendered.rerender(
            <LogsView
                {...properties()}
                maintenance={{
                    ...maintenance,
                    observedAtMs: maintenance.observedAtMs + 3,
                }}
            />
        );
        expect(screen.queryByRole("dialog")).toBeNull();
        expect(
            screen.getByRole("button", {
                name: "Run Managed application and container logs",
            })
        ).toBeEnabled();
        act(() => rendered.unmount());
    });

    test("keeps every action busy across a transient authority lock until the request settles", async () => {
        const requestResult = {
            dryRun: false,
            jobRunId: "019fdf70-0000-7000-8000-000000000018",
            policyId: "docker-managed" as const,
            queued: true as const,
        };
        const pendingRequest = deferred<typeof requestResult>();
        const queueableMaintenance: LogMaintenanceStatusOutput = {
            ...maintenance,
            policies: maintenance.policies.map((policy) => ({
                ...policy,
                state: "queueable" as const,
            })),
        };
        const props = {
            ...properties(),
            maintenance: queueableMaintenance,
            onRequestMaintenance: jest.fn(() => pendingRequest.promise),
        };
        const rendered = render(<LogsView {...props} />);
        const user = userEvent.setup();
        const dockerRun = () =>
            screen.getByRole("button", {
                name: "Run Managed application and container logs",
            });
        const dockerDryRun = () =>
            screen.getByRole("button", {
                name: "Dry run Managed application and container logs",
            });
        const hostRun = () =>
            screen.getByRole("button", { name: "Run Host alternatives log" });

        await user.click(dockerRun());
        await user.click(screen.getByRole("button", { name: "Add to queue" }));
        await waitFor(() => expect(props.onRequestMaintenance).toHaveBeenCalledTimes(1));
        expect(dockerRun()).toBeDisabled();
        expect(dockerDryRun()).toBeDisabled();
        expect(hostRun()).toBeDisabled();

        rendered.rerender(
            <LogsView
                {...props}
                maintenanceError="Maintenance status is temporarily unavailable."
            />
        );
        expect(dockerRun()).toBeDisabled();
        expect(dockerDryRun()).toBeDisabled();
        expect(hostRun()).toBeDisabled();

        rendered.rerender(<LogsView {...props} />);
        expect(screen.queryByRole("dialog")).toBeNull();
        expect(dockerRun()).toBeDisabled();
        expect(dockerDryRun()).toBeDisabled();
        expect(hostRun()).toBeDisabled();
        expect(props.onRequestMaintenance).toHaveBeenCalledTimes(1);

        await act(async () => {
            pendingRequest.resolve(requestResult);
            await pendingRequest.promise;
        });
        expect(
            await screen.findByText(
                new RegExp(`was added to the queue as job ${requestResult.jobRunId}`, "u")
            )
        ).toBeVisible();
        expect(dockerRun()).toBeEnabled();
        expect(dockerDryRun()).toBeEnabled();
        expect(hostRun()).toBeEnabled();
    });

    test("keeps a failed maintenance request visible after authority lock closes its modal", async () => {
        const pendingRequest = deferred<never>();
        const props = {
            ...properties(),
            onRequestMaintenance: jest.fn(() => pendingRequest.promise),
        };
        const rendered = render(<LogsView {...props} />);
        const user = userEvent.setup();

        await user.click(
            screen.getByRole("button", {
                name: "Run Managed application and container logs",
            })
        );
        await user.click(screen.getByRole("button", { name: "Add to queue" }));
        await waitFor(() => expect(props.onRequestMaintenance).toHaveBeenCalledTimes(1));

        rendered.rerender(
            <LogsView
                {...props}
                maintenanceError="Maintenance status is temporarily unavailable."
            />
        );
        expect(screen.queryByRole("dialog")).toBeNull();

        await act(async () => {
            pendingRequest.reject(new Error("private queue adapter failure"));
            await pendingRequest.promise.catch(() => {});
        });

        expect(
            await screen.findByText("The request could not be completed. Try again.")
        ).toBeVisible();
        expect(screen.queryByText("private queue adapter failure")).toBeNull();
    });

    test("fails closed on requested-run detail errors until status confirms inactivity", () => {
        const runId = "019fdf70-0000-7000-8000-000000000012";
        const requestedRunRequest = {
            dryRun: true,
            jobRunId: runId,
            policyId: "docker-managed" as const,
            queued: true as const,
        };
        const queueableMaintenance: LogMaintenanceStatusOutput = {
            ...maintenance,
            policies: maintenance.policies.map((policy) => ({
                ...policy,
                state: "queueable" as const,
            })),
        };
        const pendingProperties = {
            ...properties(),
            maintenance: queueableMaintenance,
            requestedRunLoading: true,
            requestedRunRequest,
        };
        const rendered = render(<LogsView {...pendingProperties} />);
        const dockerRun = () =>
            screen.getByRole("button", {
                name: "Run Managed application and container logs",
            });
        const hostRun = () =>
            screen.getByRole("button", {
                name: "Run Host alternatives log",
            });

        expect(dockerRun()).toBeDisabled();
        expect(hostRun()).toBeDisabled();

        rendered.rerender(
            <LogsView
                {...pendingProperties}
                requestedRunError="Durable job status is temporarily unavailable."
                requestedRunLoading={false}
            />
        );
        expect(dockerRun()).toBeDisabled();
        expect(hostRun()).toBeDisabled();

        rendered.rerender(
            <LogsView
                {...pendingProperties}
                requestedRunError="Durable job status is temporarily unavailable."
                requestedRunInactiveConfirmed
                requestedRunLoading={false}
                requestedRun={{
                    events: [],
                    run: maintenanceRun("queued", runId, 1_800_000_003_000),
                }}
            />
        );
        expect(dockerRun()).toBeEnabled();
        expect(hostRun()).toBeEnabled();

        rendered.rerender(
            <LogsView
                {...pendingProperties}
                requestedRun={{
                    events: [],
                    run: maintenanceRun("queued", runId, 1_800_000_003_000),
                }}
                requestedRunLoading={false}
            />
        );
        expect(dockerRun()).toBeDisabled();
        expect(hostRun()).toBeDisabled();

        rendered.rerender(
            <LogsView
                {...pendingProperties}
                requestedRun={{
                    events: [],
                    run: maintenanceRun("succeeded", runId, 1_800_000_003_000),
                }}
                requestedRunLoading={false}
            />
        );
        expect(dockerRun()).toBeEnabled();
        expect(hostRun()).toBeEnabled();
    });

    test("hides corrupt durable maintenance result details behind a fixed warning", () => {
        const runId = "019fdf70-0000-7000-8000-000000000013";
        render(
            <LogsView
                {...properties()}
                requestedRun={{
                    events: [],
                    result: { secret: "private-provider-value" },
                    run: maintenanceRun("succeeded", runId, 1_800_000_003_000),
                }}
                requestedRunRequest={{
                    dryRun: true,
                    jobRunId: runId,
                    policyId: "docker-managed",
                    queued: true,
                }}
            />
        );

        expect(
            screen.getByText(
                "The durable maintenance result could not be verified. Lifecycle status remains visible, but result details are hidden."
            )
        ).toBeVisible();
        expect(screen.getByLabelText("Dry-run lifecycle")).toHaveTextContent("succeeded");
        expect(screen.queryByText(/private-provider-value/u)).toBeNull();
    });

    test("warns for a succeeded managed request with missing result details but not a host run", () => {
        const managedRunId = "019fdf70-0000-7000-8000-000000000016";
        const rendered = render(
            <LogsView
                {...properties()}
                requestedRun={{
                    events: [],
                    run: maintenanceRun("succeeded", managedRunId, 1_800_000_003_000),
                }}
                requestedRunRequest={{
                    dryRun: false,
                    jobRunId: managedRunId,
                    policyId: "docker-managed",
                    queued: true,
                }}
            />
        );
        const warning =
            "The durable maintenance result could not be verified. Lifecycle status remains visible, but result details are hidden.";

        expect(screen.getByText(warning)).toBeVisible();

        const hostRunId = "019fdf70-0000-7000-8000-000000000017";
        rendered.rerender(
            <LogsView
                {...properties()}
                requestedRun={{
                    events: [],
                    run: maintenanceRun("succeeded", hostRunId, 1_800_000_004_000),
                }}
                requestedRunRequest={{
                    dryRun: false,
                    jobRunId: hostRunId,
                    policyId: "host-alternatives",
                    queued: true,
                }}
            />
        );

        expect(screen.queryByText(warning)).toBeNull();
        expect(screen.getByLabelText("Maintenance run lifecycle")).toHaveTextContent(
            "succeeded"
        );
    });

    test("keeps unavailable sources and policies visible but disabled", () => {
        render(<LogsView {...properties()} />);
        expect(
            screen.getByRole("button", { name: "Run Host alternatives log" })
        ).toBeDisabled();
    });
});
