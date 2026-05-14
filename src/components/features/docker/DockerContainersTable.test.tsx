import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { DockerContainer } from "../../../hooks/useDocker";
import { DockerContainersTable } from "./DockerContainersTable";

function makeContainer({
    id,
    name,
    ...overrides
}: Partial<DockerContainer> & Pick<DockerContainer, "id" | "name">): DockerContainer {
    return {
        command: "node server.js",
        createdAt: "2026-05-10T09:00:00.000Z",
        finishedAt: null,
        health: "healthy",
        id,
        image: "ghcr.io/example/comet:latest",
        imageId: "sha256:image",
        ipAddresses: {},
        mounts: [],
        name,
        ports: ["127.0.0.1:3000->3000/tcp"],
        project: "media",
        restartCount: 2,
        runningFor: "1 hour",
        service: "comet",
        startedAt: "2026-05-10T10:00:00.000Z",
        state: "running",
        stats: {
            blockIO: "0B / 0B",
            cpu: "12.5%",
            memory: "512MiB / 2GiB",
            memoryPercent: "25%",
            netIO: "1MB / 2MB",
            pids: "12",
        },
        status: "Up 1 hour",
        ...overrides,
    };
}

const containers: DockerContainer[] = [
    makeContainer({ id: "container-1", name: "comet" }),
];

function renderTable(
    tableContainers: DockerContainer[],
    handlers: Partial<React.ComponentProps<typeof DockerContainersTable>> = {}
) {
    const props = {
        containers: tableContainers,
        onConsole: vi.fn(),
        onDetails: vi.fn(),
        onLogs: vi.fn(),
        onRestart: vi.fn(),
        onRestartStack: vi.fn(),
        ...handlers,
    } satisfies React.ComponentProps<typeof DockerContainersTable>;

    return {
        ...render(<DockerContainersTable {...props} />),
        props,
    };
}

describe("DockerContainersTable", () => {
    it("renders empty state", () => {
        renderTable([]);

        expect(screen.getByText("No containers found.")).toBeInTheDocument();
    });

    it("renders containers and dispatches actions", async () => {
        const onConsole = vi.fn();
        const onDetails = vi.fn();
        const onLogs = vi.fn();
        const onRestart = vi.fn();
        const onRestartStack = vi.fn();

        renderTable(containers, {
            onConsole,
            onDetails,
            onLogs,
            onRestart,
            onRestartStack,
        });

        expect(screen.getAllByText("comet")[0]).toBeInTheDocument();
        expect(screen.getAllByText("running")[0]).toBeInTheDocument();
        expect(screen.getAllByText("healthy")[0]).toBeInTheDocument();
        expect(screen.getAllByText("537 MB")[0]).toBeInTheDocument();

        await userEvent.click(screen.getByRole("button", { name: "Restart stack" }));
        await userEvent.click(screen.getAllByText("comet")[0]);
        await userEvent.click(
            screen.getByRole("button", { name: "Show logs for comet" })
        );
        await userEvent.click(
            screen.getByRole("button", { name: "Open console for comet" })
        );
        await userEvent.click(screen.getByRole("button", { name: "Restart comet" }));
        await userEvent.click(screen.getByRole("button", { name: "Logs" }));
        await userEvent.click(screen.getByRole("button", { name: "Console" }));
        await userEvent.click(screen.getByRole("button", { name: "Restart" }));

        expect(onRestartStack).toHaveBeenCalledTimes(1);
        expect(onDetails).toHaveBeenCalledWith("container-1");
        expect(onLogs).toHaveBeenCalledTimes(2);
        expect(onLogs).toHaveBeenCalledWith("container-1");
        expect(onConsole).toHaveBeenCalledTimes(2);
        expect(onConsole).toHaveBeenCalledWith("container-1");
        expect(onRestart).toHaveBeenCalledTimes(2);
        expect(onRestart).toHaveBeenCalledWith("container-1");
    });

    it("renders state, health, ports, service metadata, and memory fallbacks", () => {
        renderTable([
            makeContainer({
                health: "unhealthy",
                id: "bad",
                name: "bad-container",
                ports: [],
                project: undefined,
                restartCount: 5,
                service: undefined,
                state: "exited",
                stats: {
                    blockIO: "0B / 0B",
                    cpu: "n/a",
                    memory: "not available",
                    memoryPercent: "0%",
                    netIO: "0B / 0B",
                    pids: "0",
                },
                status: "Exited 1 minute ago",
            }),
            makeContainer({
                health: "starting",
                id: "large",
                name: "large-container",
                state: "restarting",
                stats: {
                    blockIO: "0B / 0B",
                    cpu: "-",
                    memory: "2GiB / 4GiB",
                    memoryPercent: "50%",
                    netIO: "0B / 0B",
                    pids: "8",
                },
                status: "Restarting",
            }),
        ]);

        expect(screen.getAllByText("bad-container")[0]).toBeInTheDocument();
        expect(screen.getAllByText("exited")[0]).toBeInTheDocument();
        expect(screen.getAllByText("unhealthy")[0]).toBeInTheDocument();
        expect(screen.getAllByText("restarts: 5")[0]).toBeInTheDocument();
        expect(screen.getAllByText("—")[0]).toBeInTheDocument();
        expect(screen.getAllByText("-")[0]).toBeInTheDocument();
        expect(screen.getAllByText("2.10 GB")[0]).toBeInTheDocument();
        expect(screen.getAllByText("project: media")[0]).toBeInTheDocument();
        expect(screen.queryByText("service: undefined")).not.toBeInTheDocument();
    });

    it("renders less common health/state variants and memory units", () => {
        renderTable([
            makeContainer({
                health: "unknown",
                id: "created",
                name: "created-container",
                ports: [],
                state: "created",
                stats: {
                    blockIO: "0B / 0B",
                    cpu: "",
                    memory: "1024KB / 2GB",
                    memoryPercent: "0%",
                    netIO: "0B / 0B",
                    pids: "0",
                },
                status: "Created",
            }),
            makeContainer({
                health: "none",
                id: "dead",
                name: "dead-container",
                state: "dead",
                stats: {
                    blockIO: "0B / 0B",
                    cpu: "-7.5%",
                    memory: "1TB / 2TB",
                    memoryPercent: "50%",
                    netIO: "0B / 0B",
                    pids: "0",
                },
                status: "Dead",
            }),
        ]);

        expect(screen.getAllByText("created")[0]).toBeInTheDocument();
        expect(screen.getAllByText("dead")[0]).toBeInTheDocument();
        expect(screen.getAllByText("unknown")[0]).toBeInTheDocument();
        expect(screen.getAllByText("none")[0]).toBeInTheDocument();
        expect(screen.getAllByText("1 MB")[0]).toBeInTheDocument();
        expect(screen.getAllByText("1073.74 GB")[0]).toBeInTheDocument();
        expect(screen.getAllByText("-")[0]).toBeInTheDocument();
        expect(screen.getAllByText("-7.5%")[0]).toBeInTheDocument();
    });

    it("renders null stats and less common rank fallbacks", async () => {
        const user = userEvent.setup();

        renderTable([
            makeContainer({
                health: "starting",
                id: "null-stats",
                name: "null-stats",
                state: "paused",
                stats: null,
                status: "Paused",
            }),
            makeContainer({
                health: "mystery",
                id: "mystery-state",
                name: "mystery-state",
                state: "mystery",
                stats: {
                    blockIO: "0B / 0B",
                    cpu: "100%",
                    memory: "512B / 1KiB",
                    memoryPercent: "50%",
                    netIO: "0B / 0B",
                    pids: "1",
                },
                status: "Unknown",
            }),
            makeContainer({
                health: "none",
                id: "created-state",
                name: "created-state",
                state: "created",
                stats: {
                    blockIO: "0B / 0B",
                    cpu: "5%",
                    memory: "2MB / 4MB",
                    memoryPercent: "50%",
                    netIO: "0B / 0B",
                    pids: "1",
                },
                status: "Created",
            }),
            makeContainer({
                health: "none",
                id: "running-no-health",
                name: "running-no-health",
                state: "running",
                stats: {
                    blockIO: "0B / 0B",
                    cpu: "n/a",
                    memory: "512MiB",
                    memoryPercent: "unavailable",
                    netIO: "0B / 0B",
                    pids: "1",
                },
                status: "Up",
            }),
        ]);

        expect(screen.getAllByText("paused")[0]).toBeInTheDocument();
        expect(screen.getAllByText("mystery")[0]).toBeInTheDocument();
        expect(screen.getAllByText("created")[0]).toBeInTheDocument();
        expect(screen.getAllByText("running")[0]).toBeInTheDocument();
        expect(screen.getAllByText("-").length).toBeGreaterThanOrEqual(2);
        expect(screen.getAllByText("0 MB")[0]).toBeInTheDocument();
        expect(screen.getAllByText("2 MB")[0]).toBeInTheDocument();
        expect(screen.getAllByText("537 MB")[0]).toBeInTheDocument();

        await user.click(screen.getByRole("button", { name: "CPU" }));
        await user.click(screen.getByRole("button", { name: "State" }));
    });

    it("opens details from the desktop row click", () => {
        const onDetails = vi.fn();
        const { container } = renderTable(containers, { onDetails });

        fireEvent.click(container.querySelector("tbody tr")!);

        expect(onDetails).toHaveBeenCalledWith("container-1");
    });

    it("supports keyboard row activation and sortable columns", async () => {
        const user = userEvent.setup();
        const onDetails = vi.fn();

        renderTable(
            [
                makeContainer({
                    health: "unknown",
                    id: "paused",
                    name: "paused-container",
                    state: "paused",
                    status: "Paused",
                }),
                makeContainer({
                    health: "healthy",
                    id: "running",
                    name: "running-container",
                    state: "running",
                    status: "Up",
                }),
            ],
            { onDetails }
        );

        screen.getAllByRole("button", { name: /paused-container/ })[0]?.focus();
        await user.keyboard("{Enter}");
        await user.keyboard(" ");

        expect(onDetails).toHaveBeenNthCalledWith(1, "paused");
        expect(onDetails).toHaveBeenNthCalledWith(2, "paused");

        await user.click(screen.getByRole("button", { name: "State" }));
        await user.click(screen.getByRole("button", { name: "State" }));
        await user.click(screen.getByRole("button", { name: "Health" }));
        await user.click(screen.getByRole("button", { name: "CPU" }));
        await user.click(screen.getByRole("button", { name: "Memory" }));

        expect(screen.getAllByText("running-container")[0]).toBeInTheDocument();
    });

    it("sorts equal-ranked state rows by status text", async () => {
        const user = userEvent.setup();

        renderTable([
            makeContainer({
                id: "later",
                name: "later-running",
                state: "running",
                status: "Up 9 hours",
            }),
            makeContainer({
                id: "earlier",
                name: "earlier-running",
                state: "running",
                status: "Up 1 hour",
            }),
        ]);

        await user.click(screen.getByRole("button", { name: "State" }));

        const desktopRows = [
            ...document.querySelectorAll<HTMLTableRowElement>("tbody tr"),
        ];
        expect(desktopRows[0]).toHaveTextContent("earlier-running");
        expect(desktopRows[1]).toHaveTextContent("later-running");
    });

    it("sorts through every state and health rank", async () => {
        const user = userEvent.setup();

        renderTable([
            makeContainer({
                health: "unhealthy",
                id: "unhealthy",
                name: "unhealthy-exited",
                state: "exited",
                status: "Exited",
            }),
            makeContainer({
                health: "starting",
                id: "starting",
                name: "starting-restarting",
                state: "restarting",
                status: "Restarting",
            }),
            makeContainer({
                health: "none",
                id: "created",
                name: "none-created",
                state: "created",
                status: "Created",
            }),
            makeContainer({
                health: "none",
                id: "dead",
                name: "none-dead",
                state: "dead",
                status: "Dead",
            }),
        ]);

        await user.click(screen.getByRole("button", { name: "State" }));
        await user.click(screen.getByRole("button", { name: "Health" }));

        const rows = [...document.querySelectorAll<HTMLTableRowElement>("tbody tr")];
        expect(rows[0]).toHaveTextContent("starting-restarting");
        expect(rows[1]).toHaveTextContent("unhealthy-exited");
        expect(rows[2]).toHaveTextContent("none-created");
        expect(rows[3]).toHaveTextContent("none-dead");
    });
});
