import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, jest } from "bun:test";

import type { DockerVolume } from "../../../hooks/useDocker";
import { DockerVolumesTable } from "./DockerVolumesTable";

function makeVolume(overrides: Partial<DockerVolume> = {}): DockerVolume {
    return {
        driver: "local",
        labels: {},
        mountpoint: "/var/lib/docker/volumes/default/_data",
        name: "default-volume",
        scope: "local",
        size: "1 MB",
        usedBy: [],
        ...overrides,
    };
}

const volumes: DockerVolume[] = [
    makeVolume({
        mountpoint: "/var/lib/docker/volumes/used/_data",
        name: "used-volume",
        size: "1 GB",
        usedBy: ["comet"],
    }),
    makeVolume({
        mountpoint: "/var/lib/docker/volumes/unused/_data",
        name: "unused-volume",
    }),
];

describe("DockerVolumesTable", () => {
    it("renders empty state", () => {
        render(
            <DockerVolumesTable
                volumes={[]}
                onDelete={jest.fn()}
                onPruneUnused={jest.fn()}
            />
        );

        expect(screen.getByText("No volumes found.")).toBeInTheDocument();
    });

    it("renders volumes and deletes only unused volumes", async () => {
        const onDelete = jest.fn();
        const onPruneUnused = jest.fn();
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
        const enabledDeleteButton = within(screen.getByRole("table"))
            .getAllByRole("button", { name: "Delete unused-volume" })
            .find((button) => !button.hasAttribute("disabled"));
        await userEvent.click(enabledDeleteButton!);

        expect(onPruneUnused).toHaveBeenCalledTimes(1);
        expect(onDelete).toHaveBeenCalledWith("unused-volume");
        expect(onDelete).toHaveBeenCalledTimes(1);

        const mobileDeleteButton = screen
            .getAllByRole("button", { name: "Delete unused-volume" })
            .find(
                (button) =>
                    !button.hasAttribute("disabled") &&
                    button.className.includes("w-full")
            );
        await userEvent.click(mobileDeleteButton!);
        expect(onDelete).toHaveBeenLastCalledWith("unused-volume");
        expect(onDelete).toHaveBeenCalledTimes(2);
    });

    it("shows pruning state", () => {
        render(
            <DockerVolumesTable
                volumes={volumes}
                isPruning
                onDelete={jest.fn()}
                onPruneUnused={jest.fn()}
            />
        );

        expect(screen.getByRole("button", { name: "Removing unused..." })).toBeDisabled();
    });

    it("renders long names, missing scope, and used-by metadata in mobile cards", () => {
        const longName = "very-long-volume-name-that-should-be-truncated-in-the-table";
        const longMountpoint =
            "/var/lib/docker/volumes/very-long-volume-name-that-should-be-truncated-in-the-table/_data";

        render(
            <DockerVolumesTable
                volumes={[
                    makeVolume({
                        mountpoint: longMountpoint,
                        name: longName,
                        scope: "",
                        usedBy: ["comet", "jackett"],
                    }),
                ]}
                onDelete={jest.fn()}
                onPruneUnused={jest.fn()}
            />
        );

        expect(screen.getAllByTitle(longName)[0]).toHaveTextContent(
            "very-long-volume-name-th...be-truncated-in-the-table"
        );
        expect(screen.getAllByTitle(longMountpoint)[0]).toHaveTextContent(
            "local · /var/lib/docker/volumes/very-long-...uld-be-truncated-in-the-table/_data"
        );
        expect(screen.getByText("—")).toBeInTheDocument();
        expect(screen.getByText("Used by: comet, jackett")).toBeInTheDocument();
    });

    it("sorts volumes by status and name", async () => {
        render(
            <DockerVolumesTable
                volumes={volumes}
                onDelete={jest.fn()}
                onPruneUnused={jest.fn()}
            />
        );

        const table = screen.getByRole("table");
        const bodyRows = () => within(table).getAllByRole("row").slice(1);

        await userEvent.click(within(table).getByText("Status"));
        expect(within(bodyRows()[0]!).getByText("Used")).toBeInTheDocument();

        await userEvent.click(within(table).getByText("Status"));
        expect(within(bodyRows()[0]!).getByText("Unused")).toBeInTheDocument();

        await userEvent.click(within(table).getByText("Volume"));
        expect(within(bodyRows()[0]!).getByText("unused-volume")).toBeInTheDocument();
    });
});
