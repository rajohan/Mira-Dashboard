import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { DockerContainer } from "../../../hooks/useDocker";
import { DockerContainersTable } from "./DockerContainersTable";

const containers: DockerContainer[] = [
    {
        command: "node server.js",
        createdAt: "2026-05-10T09:00:00.000Z",
        finishedAt: null,
        health: "healthy",
        id: "container-1",
        image: "ghcr.io/example/comet:latest",
        imageId: "sha256:image",
        ipAddresses: {},
        mounts: [],
        name: "comet",
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
    },
];

describe("DockerContainersTable", () => {
    it("renders empty state", () => {
        render(
            <DockerContainersTable
                containers={[]}
                onConsole={vi.fn()}
                onDetails={vi.fn()}
                onLogs={vi.fn()}
                onRestart={vi.fn()}
                onRestartStack={vi.fn()}
            />
        );

        expect(screen.getByText("No containers found.")).toBeInTheDocument();
    });

    it("renders containers and dispatches actions", async () => {
        const onConsole = vi.fn();
        const onDetails = vi.fn();
        const onLogs = vi.fn();
        const onRestart = vi.fn();
        const onRestartStack = vi.fn();

        render(
            <DockerContainersTable
                containers={containers}
                onConsole={onConsole}
                onDetails={onDetails}
                onLogs={onLogs}
                onRestart={onRestart}
                onRestartStack={onRestartStack}
            />
        );

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

        expect(onRestartStack).toHaveBeenCalledTimes(1);
        expect(onDetails).toHaveBeenCalledWith("container-1");
        expect(onLogs).toHaveBeenCalledWith("container-1");
        expect(onConsole).toHaveBeenCalledWith("container-1");
        expect(onRestart).toHaveBeenCalledWith("container-1");
    });
});
