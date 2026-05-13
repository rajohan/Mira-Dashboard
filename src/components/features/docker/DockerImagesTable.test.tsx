import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { DockerImage } from "../../../hooks/useDocker";
import { DockerImagesTable } from "./DockerImagesTable";

const images: DockerImage[] = [
    {
        containerName: "comet",
        createdAt: "2026-05-10T09:00:00.000Z",
        id: "image-used",
        inUseBy: ["comet"],
        lastTagTime: "2026-05-10T09:00:00.000Z",
        platform: "linux/arm64",
        repository: "ghcr.io/example/comet",
        size: 50 * 1024 * 1024,
        tag: "latest",
    },
    {
        containerName: "",
        createdAt: "2026-05-10T09:00:00.000Z",
        id: "image-unused",
        inUseBy: [],
        lastTagTime: "2026-05-10T09:00:00.000Z",
        platform: "linux/arm64",
        repository: "orphan",
        size: 0,
        tag: "",
    },
];

describe("DockerImagesTable", () => {
    it("renders empty state", () => {
        render(
            <DockerImagesTable images={[]} onDelete={vi.fn()} onPruneUnused={vi.fn()} />
        );

        expect(screen.getByText("No images found.")).toBeInTheDocument();
    });

    it("renders images and deletes only unused images", async () => {
        const onDelete = vi.fn();
        const onPruneUnused = vi.fn();
        render(
            <DockerImagesTable
                images={images}
                onDelete={onDelete}
                onPruneUnused={onPruneUnused}
            />
        );

        expect(screen.getAllByText("ghcr.io/example/comet")[0]).toBeInTheDocument();
        expect(screen.getAllByText("orphan")[0]).toBeInTheDocument();
        expect(screen.getAllByText("50 MB")[0]).toBeInTheDocument();
        expect(screen.getAllByText("Unused")[0]).toBeInTheDocument();

        const table = screen.getByRole("table");
        await userEvent.click(within(table).getByText("Used by"));
        await userEvent.click(screen.getByRole("button", { name: "Remove unused (1)" }));
        const enabledDeleteButton = within(table)
            .getAllByRole("button", { name: "Delete" })
            .find((button) => !button.hasAttribute("disabled"));
        await userEvent.click(enabledDeleteButton!);

        expect(onPruneUnused).toHaveBeenCalledTimes(1);
        expect(onDelete).toHaveBeenCalledWith("image-unused", "orphan:<none>");
    });

    it("shows pruning state", () => {
        render(
            <DockerImagesTable
                images={images}
                isPruning
                onDelete={vi.fn()}
                onPruneUnused={vi.fn()}
            />
        );

        expect(screen.getByRole("button", { name: "Removing unused..." })).toBeDisabled();
    });
});
