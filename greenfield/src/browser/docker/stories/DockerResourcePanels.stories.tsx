import type { Meta, StoryObj } from "@storybook/tanstack-react";
import { expect, fn, userEvent, within } from "storybook/test";

import { DockerResourcePanels } from "../DockerResourcePanels.tsx";

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

const meta = {
    args: {
        busy: false,
        containers: [
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
        ],
        controlsDisabled: false,
        images: [unusedImage, usedImage],
        onDeleteImage: fn(),
        onDeleteVolume: fn(),
        onPreviewPrune: fn(),
        volumes: [unusedVolume, usedVolume],
    },
    component: DockerResourcePanels,
    title: "Docker/DockerResourcePanels",
} satisfies Meta<typeof DockerResourcePanels>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Inventory: Story = {
    play: async ({ args, canvasElement }) => {
        const canvas = within(canvasElement);
        await userEvent.click(
            canvas.getByRole("button", { name: "Prune unused images" })
        );
        await userEvent.click(
            canvas.getByRole("button", { name: "Prune unused volumes" })
        );
        await userEvent.click(
            canvas.getAllByRole("button", {
                name: "Delete exact image sha256:unused",
            })[0]!
        );
        await userEvent.click(
            canvas.getAllByRole("button", {
                name: "Delete exact volume unused-volume",
            })[0]!
        );
        await expect(args.onPreviewPrune).toHaveBeenCalledTimes(2);
        await expect(args.onDeleteImage).toHaveBeenCalledWith(unusedImage);
        await expect(args.onDeleteVolume).toHaveBeenCalledWith(unusedVolume);
    },
};

export const EmptyAndDisabled: Story = {
    args: {
        busy: true,
        containers: [],
        controlsDisabled: true,
        images: [],
        volumes: [],
    },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        await expect(canvas.getByText("No images were discovered.")).toBeVisible();
        await expect(canvas.getByText("No volumes were discovered.")).toBeVisible();
        for (const button of canvas.getAllByRole("button")) {
            await expect(button).toBeDisabled();
        }
    },
};
