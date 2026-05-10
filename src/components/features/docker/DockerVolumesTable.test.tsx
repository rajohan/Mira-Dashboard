import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { DockerVolume } from "../../../hooks/useDocker";
import { DockerVolumesTable } from "./DockerVolumesTable";

const volumes: DockerVolume[] = [
    {
        driver: "local",
        labels: {},
        mountpoint: "/var/lib/docker/volumes/used/_data",
        name: "used-volume",
        scope: "local",
        size: "1 GB",
        usedBy: ["comet"],
    },
    {
        driver: "local",
        labels: {},
        mountpoint: "/var/lib/docker/volumes/unused/_data",
        name: "unused-volume",
        scope: "local",
        size: "1 MB",
        usedBy: [],
    },
];

describe("DockerVolumesTable", () => {
    it("renders empty state", () => {
        render(
            <DockerVolumesTable volumes={[]} onDelete={vi.fn()} onPruneUnused={vi.fn()} />
        );

        expect(screen.getByText("No volumes found.")).toBeInTheDocument();
    });

    it("renders volumes and deletes only unused volumes", async () => {
        const onDelete = vi.fn();
        const onPruneUnused = vi.fn();
        render(
            <DockerVolumesTable
                volumes={volumes}
                onDelete={onDelete}
                onPruneUnused={onPruneUnused}
            />
        );

        expect(screen.getAllByText("used-volume")[0]).toBeInTheDocument();
        expect(screen.getAllByText("unused-volume")[0]).toBeInTheDocument();
        expect(screen.getAllByText("Used")[0]).toBeInTheDocument();
        expect(screen.getAllByText("Unused")[0]).toBeInTheDocument();

        await userEvent.click(screen.getByRole("button", { name: "Remove unused (1)" }));
        const enabledDeleteButton = screen
            .getAllByRole("button", { name: "Delete" })
            .find((button) => !button.hasAttribute("disabled"));
        await userEvent.click(enabledDeleteButton!);

        expect(onPruneUnused).toHaveBeenCalledTimes(1);
        expect(onDelete).toHaveBeenCalledWith("unused-volume");
    });

    it("shows pruning state", () => {
        render(
            <DockerVolumesTable
                volumes={volumes}
                isPruning
                onDelete={vi.fn()}
                onPruneUnused={vi.fn()}
            />
        );

        expect(screen.getByRole("button", { name: "Removing unused..." })).toBeDisabled();
    });
});
