import type { Meta, StoryObj } from "@storybook/tanstack-react";
import { type ComponentProps, useState } from "react";
import { expect, fireEvent, fn, userEvent, waitFor, within } from "storybook/test";

import type {
    LogMaintenanceStatusOutput,
    LogSnapshotOutput,
    LogSource,
} from "../../../contracts/logs.ts";
import { Button } from "../../ui/Button.tsx";
import { LogsView } from "../LogsView.tsx";

function stableId(index: number): string {
    return index.toString(16).padStart(64, "0");
}

async function stableRelativeTop(
    element: HTMLElement,
    container: HTMLElement
): Promise<number> {
    let previousTop: number | undefined;
    let stableFrames = 0;
    for (let frame = 0; frame < 12; frame += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        if (!element.isConnected) {
            throw new TypeError("The log reading anchor was removed while settling");
        }
        const currentTop =
            element.getBoundingClientRect().top - container.getBoundingClientRect().top;
        stableFrames =
            previousTop !== undefined && Math.abs(currentTop - previousTop) <= 1
                ? stableFrames + 1
                : 0;
        if (stableFrames >= 2) return currentTop;
        previousTop = currentTop;
    }
    throw new Error("The log reading anchor did not settle inside 12 frames");
}

function longSnapshot(count: number): LogSnapshotOutput {
    return {
        hasEarlier: true,
        lines: Array.from({ length: count }, (_, index) => ({
            id: stableId(index + 1),
            line: JSON.stringify({
                component: index % 2 === 0 ? "gateway/ws" : "http",
                level: index % 9 === 0 ? "warn" : "info",
                message: `Chronological log line ${index + 1}`,
                time: new Date(1_800_000_000_000 + index * 1000).toISOString(),
            }),
            severity: index % 9 === 0 ? ("warn" as const) : ("info" as const),
        })),
        observedAtMs: 1_800_000_500_000,
        revision: stableId(count + 10_000),
        scannedBytes: 256_000,
        sourceId: sources[0]!.id,
    };
}

function FollowLogsStory(properties: ComponentProps<typeof LogsView>) {
    const [currentSnapshot, setCurrentSnapshot] = useState(() => longSnapshot(50));
    return (
        <div>
            <Button
                className="mb-3"
                onClick={() =>
                    setCurrentSnapshot((current) =>
                        longSnapshot(current.lines.length + 1)
                    )
                }
                size="sm"
                variant="secondary"
            >
                Append test line
            </Button>
            <LogsView {...properties} snapshot={currentSnapshot} />
        </div>
    );
}

const sources: readonly LogSource[] = [
    {
        availability: "available",
        group: "dashboard",
        id: "dashboard.web.stderr",
        label: "Dashboard web stderr",
        modifiedAtMs: 1_800_000_000_000,
        sizeBytes: 65_536,
    },
    {
        availability: "available",
        group: "openclaw",
        id: "openclaw.gateway",
        label: "OpenClaw gateway",
        modifiedAtMs: 1_800_000_000_000,
        sizeBytes: 131_072,
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
            line: '{"_meta":{"logLevelName":"INFO","date":"2027-01-15T08:00:00.000Z"},"0":"[gateway] HTTP listener ready on the reviewed loopback interface"}',
            severity: "unknown",
        },
        {
            id: "b".repeat(64),
            line: '{"component":"auth","level":"warn","message":"Authentication token=[REDACTED] was rejected","requestId":"request-42","attempt":2,"time":"2027-01-15T08:00:01.000Z"}',
            severity: "warn",
        },
        {
            id: "c".repeat(64),
            line: "worker: raw redacted connection status",
            severity: "info",
            timestampMs: 1_800_000_002_000,
        },
    ],
    observedAtMs: 1_800_000_003_000,
    revision: "d".repeat(64),
    scannedBytes: 32_768,
    sourceId: sources[0]!.id,
};
const maintenance: LogMaintenanceStatusOutput = {
    observedAtMs: 1_800_000_003_000,
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
            state: "queueable",
        },
        {
            id: "host-apport",
            label: "Host Apport log",
            scope: "host",
            state: "queueable",
        },
        {
            id: "host-dpkg",
            label: "Host package log",
            scope: "host",
            state: "queueable",
        },
        {
            id: "host-rsyslog",
            label: "Host system logs",
            scope: "host",
            state: "queueable",
        },
    ],
};

const meta = {
    args: {
        maintenance,
        onClearSearch: fn(),
        onRefresh: fn(),
        onRefreshMaintenance: fn(),
        onRequestMaintenance: fn(() =>
            Promise.resolve({
                dryRun: false,
                jobRunId: "log-maintenance-run",
                policyId: "docker-managed" as const,
                queued: true as const,
            })
        ),
        onSearch: fn(),
        onSelectSource: fn(),
        onRowCountChange: fn(),
        rowCount: 200,
        selectedSourceId: sources[0]!.id,
        snapshot,
        sources,
    },
    component: LogsView,
    parameters: { layout: "padded" },
    title: "Logs/LogsView",
} satisfies Meta<typeof LogsView>;

export default meta;
type Story = StoryObj<typeof meta>;

export const RedactedTail: Story = {
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        await expect(
            canvas.getByRole("log", {
                name: "Log lines with sensitive values removed",
            })
        ).toHaveTextContent("token=[REDACTED]");
        await expect(canvas.getByLabelText("Source gateway")).toBeVisible();
        await expect(canvas.getByLabelText("Level warn")).toBeVisible();
        await expect(canvas.getByText("requestId=")).toBeVisible();
        await userEvent.click(
            canvas.getAllByRole("button", {
                name: "Original line (sensitive values removed)",
            })[0]!
        );
        await expect(canvas.getByText(/"logLevelName":"INFO"/u)).toBeVisible();
        await userEvent.click(
            canvas.getByRole("button", {
                name: "Run Managed application and container logs",
            })
        );
        const body = within(canvasElement.ownerDocument.body);
        await expect(
            body.getByRole("dialog", {
                name: "Run Managed application and container logs?",
            })
        ).toBeVisible();
    },
};

export const RawRedactedFallback: Story = {
    args: {
        snapshot: {
            ...snapshot,
            hasEarlier: false,
            lines: [
                {
                    id: "e".repeat(64),
                    line: '{bad json Credential [REDACTED] <script>alert("unsafe")</script>',
                    severity: "error",
                },
            ],
        },
    },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        await expect(canvas.getByLabelText("Plain text log line")).toBeVisible();
        await expect(canvasElement.querySelector("script")).toBeNull();
    },
};

export const BoundedStructuredFields: Story = {
    args: {
        snapshot: {
            ...snapshot,
            hasEarlier: false,
            lines: [
                {
                    id: "f".repeat(64),
                    line: JSON.stringify({
                        event: "worker.completed",
                        field0: {
                            nested: { deeper: { deepest: "x".repeat(500) } },
                        },
                        field1: 1,
                        field2: 2,
                        field3: 3,
                        field4: 4,
                        field5: 5,
                        field6: 6,
                        field7: 7,
                        field8: 8,
                        field9: 9,
                        field10: 10,
                        field11: 11,
                    }),
                    severity: "info",
                },
            ],
        },
    },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        await expect(canvas.getByText("1 line")).toBeVisible();
        await expect(
            canvas.getByText(
                "4 additional fields available in the original line with sensitive values removed."
            )
        ).toBeVisible();
    },
};

export const EmptySearch: Story = {
    args: {
        searchQuery: "no-matches",
        snapshot: { ...snapshot, hasEarlier: false, lines: [] },
    },
};

export const MaintenanceUnavailable: Story = {
    args: {
        maintenance: {
            ...maintenance,
            policies: maintenance.policies.map((policy) => ({
                ...policy,
                state: "unavailable" as const,
            })),
        },
    },
};

export const SystemAndOpenClawFormatting: Story = {
    args: {
        snapshot: {
            ...snapshot,
            hasEarlier: false,
            lines: [
                {
                    id: stableId(701),
                    line: "<34>Aug 10 01:23:45 host sshd[42]: Accepted reviewed publickey",
                    severity: "unknown",
                },
                {
                    id: stableId(702),
                    line: String.raw`{"0":"{\"subsystem\":\"gateway/ws\"}","1":"↔ response ✓ request-42","_meta":{"date":"2027-01-15T08:00:00.000Z","logLevelName":"INFO"}}`,
                    severity: "unknown",
                },
                {
                    id: stableId(703),
                    line: "2027-01-15T09:00:01.000Z [WARN] [http] request rejected",
                    severity: "warn",
                },
            ],
            observedAtMs: new Date(2027, 0, 15, 12).getTime(),
            revision: stableId(704),
            sourceId: "host.syslog",
        },
    },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        await expect(canvas.getByLabelText("Source sshd")).toBeVisible();
        await expect(canvas.getByLabelText("Facility auth")).toBeVisible();
        const gateway = canvas.getByLabelText("Source gateway/ws");
        await expect(gateway).toBeVisible();
        await expect(gateway.querySelector(".text-cyan-300")).toHaveTextContent(
            "gateway"
        );
        await expect(gateway.querySelector(".text-amber-300")).toHaveTextContent("ws");
        await expect(canvas.getByLabelText("Source http")).toBeVisible();
        await expect(canvas.getByText("↔ response ✓ request-42")).toBeVisible();
        await expect(canvasElement.querySelector("script")).toBeNull();
    },
};

export const FollowLatestLongTail: Story = {
    render: (properties) => <FollowLogsStory {...properties} />,
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        const log = canvas.getByRole("log", {
            name: "Log lines with sensitive values removed",
        });
        await waitFor(
            async () => {
                await expect(log.scrollHeight).toBeGreaterThan(log.clientHeight);
                await expect(
                    log.scrollHeight - log.scrollTop - log.clientHeight
                ).toBeLessThanOrEqual(32);
            },
            { timeout: 5000 }
        );

        await fireEvent.wheel(log, { deltaY: -500 });
        log.scrollTop = Math.max(0, log.scrollHeight - log.clientHeight - 500);
        await fireEvent.scroll(log);
        const jump = await waitFor(() =>
            canvas.getByRole("button", { name: "Jump to latest" })
        );
        const logTop = log.getBoundingClientRect().top;
        const readingAnchor = [
            ...log.querySelectorAll<HTMLElement>("li[data-index]"),
        ].find((row) => row.getBoundingClientRect().bottom > logTop);
        if (readingAnchor === undefined)
            throw new TypeError("Expected a visible log row");
        const readingAnchorIndex = readingAnchor.dataset.index;
        const readingAnchorTop = await stableRelativeTop(readingAnchor, log);

        await userEvent.click(canvas.getByRole("button", { name: "Append test line" }));
        const restoredAnchor = await waitFor(
            async () => {
                const candidate = log.querySelector<HTMLElement>(
                    `li[data-index="${readingAnchorIndex}"]`
                );
                await expect(candidate).not.toBeNull();
                if (candidate === null)
                    throw new TypeError("Expected the reading anchor");
                return candidate;
            },
            { timeout: 5000 }
        );
        await expect(
            Math.abs((await stableRelativeTop(restoredAnchor, log)) - readingAnchorTop)
        ).toBeLessThanOrEqual(1);

        await userEvent.click(jump);
        await waitFor(async () => {
            await expect(
                log.scrollHeight - log.scrollTop - log.clientHeight
            ).toBeLessThanOrEqual(32);
            await expect(
                canvas.queryByRole("button", { name: "Jump to latest" })
            ).not.toBeInTheDocument();
        });

        await userEvent.click(canvas.getByRole("button", { name: "Append test line" }));
        await waitFor(async () => {
            await expect(
                log.scrollHeight - log.scrollTop - log.clientHeight
            ).toBeLessThanOrEqual(32);
        });
    },
};

export const MobileLevelFiltering: Story = {
    args: {
        snapshot: longSnapshot(12),
    },
    globals: { viewport: { isRotated: false, value: "mobile1" } },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        const storyWindow = canvasElement.ownerDocument.defaultView;
        if (storyWindow === null) throw new TypeError("Expected a Storybook window");
        await expect(storyWindow.innerWidth).toBe(320);
        const levels = canvas.getByRole("group", {
            name: "Log levels in current snapshot",
        });
        await expect(levels).toBeVisible();
        await expect(levels.scrollWidth).toBeLessThanOrEqual(levels.clientWidth);
        for (const level of ["trace", "debug", "info", "warn", "error", "fatal"]) {
            await expect(canvas.getByRole("button", { name: level })).toHaveAttribute(
                "aria-pressed",
                "true"
            );
        }
        await userEvent.click(
            canvas.getByRole("button", { name: "Clear all log levels" })
        );
        await expect(
            canvas.getByRole("heading", {
                name: "No log lines at the selected levels",
            })
        ).toBeVisible();
        await userEvent.click(
            canvas.getByRole("button", { name: "Select all log levels" })
        );
        await expect(
            canvas.getByRole("log", {
                name: "Log lines with sensitive values removed",
            })
        ).toBeVisible();
    },
};
