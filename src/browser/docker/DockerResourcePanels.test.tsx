import { describe, expect, jest, test } from "bun:test";

import { DockerResourcePanels } from "./DockerResourcePanels.tsx";

const { render, screen } = await import("@testing-library/react");
const userEventModule = await import("@testing-library/user-event");
const userEvent = userEventModule.default;

describe("Docker resource panels", () => {
    test("renders empty inventories and exposes both prune previews", async () => {
        const user = userEvent.setup();
        const onPreviewPrune = jest.fn();
        render(
            <DockerResourcePanels
                busy={false}
                containers={[]}
                controlsDisabled={false}
                images={[]}
                onDeleteImage={jest.fn()}
                onDeleteVolume={jest.fn()}
                onPreviewPrune={onPreviewPrune}
                volumes={[]}
            />
        );

        expect(screen.getByText("No images were discovered.")).toBeVisible();
        expect(screen.getByText("No volumes were discovered.")).toBeVisible();
        await user.click(screen.getByRole("button", { name: "Prune unused images" }));
        await user.click(screen.getByRole("button", { name: "Prune unused volumes" }));
        expect(onPreviewPrune.mock.calls).toEqual([["images"], ["volumes"]]);
    });

    test("renders every usage variant and deletes only unused exact resources", async () => {
        const user = userEvent.setup();
        const onDeleteImage = jest.fn();
        const onDeleteVolume = jest.fn();
        const unusedImage = {
            createdAtMs: 1,
            id: "sha256:unused",
            references: [],
            sizeBytes: 1024,
            usedByContainerIds: [],
        };
        const usedImage = {
            createdAtMs: 1,
            id: "sha256:used",
            references: ["example/image:latest"],
            sizeBytes: 2048,
            usedByContainerIds: ["known-container", "unknown-container-identity"],
        };
        const unusedVolume = {
            createdAtMs: 1,
            driver: "local",
            labels: {},
            mountpoint: "/var/lib/docker/volumes/unused",
            name: "unused-volume",
            scope: "local" as const,
            usedByContainerIds: [],
        };
        const usedVolume = {
            ...unusedVolume,
            name: "used-volume",
            sizeBytes: 4096,
            usedByContainerIds: ["known-container"],
        };
        render(
            <DockerResourcePanels
                busy={false}
                containers={[
                    {
                        createdAtMs: 1,
                        health: "none",
                        id: "known-container",
                        image: "example/image:latest",
                        imageId: "sha256:used",
                        mounts: [],
                        name: "named-container",
                        networks: [],
                        ports: [],
                        restartCount: 0,
                        state: "running",
                    },
                ]}
                controlsDisabled={false}
                images={[unusedImage, usedImage]}
                onDeleteImage={onDeleteImage}
                onDeleteVolume={onDeleteVolume}
                onPreviewPrune={jest.fn()}
                volumes={[unusedVolume, usedVolume]}
            />
        );

        expect(screen.getAllByText("Untagged")).not.toHaveLength(0);
        expect(screen.getAllByText("Unknown")).not.toHaveLength(0);
        expect(screen.getAllByText(/named-container/u)).not.toHaveLength(0);
        await user.click(
            screen.getAllByRole("button", {
                name: "Delete exact image sha256:unused",
            })[0]!
        );
        await user.click(
            screen.getAllByRole("button", {
                name: "Delete exact volume unused-volume",
            })[0]!
        );
        expect(onDeleteImage).toHaveBeenCalledWith(unusedImage);
        expect(onDeleteVolume).toHaveBeenCalledWith(unusedVolume);
        expect(
            screen.getAllByRole("button", { name: "Delete exact image sha256:used" })[0]!
        ).toBeDisabled();
        expect(
            screen.getAllByRole("button", {
                name: "Delete exact volume used-volume",
            })[0]!
        ).toBeDisabled();
    });

    test("disables every resource action while controls are unavailable", () => {
        render(
            <DockerResourcePanels
                busy
                containers={[]}
                controlsDisabled
                images={[
                    {
                        createdAtMs: 1,
                        id: "sha256:unused",
                        references: ["example/image:latest"],
                        sizeBytes: 1024,
                        usedByContainerIds: [],
                    },
                ]}
                onDeleteImage={jest.fn()}
                onDeleteVolume={jest.fn()}
                onPreviewPrune={jest.fn()}
                volumes={[]}
            />
        );

        for (const button of screen
            .getAllByRole("button")
            .filter(
                (candidate) =>
                    !candidate.getAttribute("aria-label")?.startsWith("Sort by ")
            )) {
            expect(button).toBeDisabled();
        }
    });
});
