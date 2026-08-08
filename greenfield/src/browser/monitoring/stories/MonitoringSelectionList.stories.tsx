import type { Meta, StoryObj } from "@storybook/tanstack-react";
import { expect, fn, userEvent, within } from "storybook/test";

import { expectVirtualizedList } from "../../storySupport/virtualizationAssertions.ts";
import { Button } from "../../ui/Button.tsx";
import { MonitoringSelectionList } from "../MonitoringSelectionList.tsx";

interface CatalogItem {
    readonly id: string;
    readonly label: string;
}

interface MonitoringSelectionListStoryProps {
    readonly items: readonly CatalogItem[];
    readonly onSelect: (id: string) => void;
}

function MonitoringSelectionListStory({
    items,
    onSelect,
}: MonitoringSelectionListStoryProps) {
    return (
        <MonitoringSelectionList
            getKey={(item) => item.id}
            items={items}
            label="Monitoring catalog"
            renderItem={(item) => (
                <Button
                    className="w-full justify-start"
                    onClick={() => onSelect(item.id)}
                    variant="secondary"
                >
                    {item.label}
                </Button>
            )}
        />
    );
}

const items = Object.freeze(
    Array.from({ length: 50 }, (_, index) => ({
        id: `monitoring-item-${index.toString().padStart(2, "0")}`,
        label: `Monitoring item ${index.toString().padStart(2, "0")}`,
    }))
);

const meta = {
    args: {
        items,
        onSelect: fn(),
    },
    component: MonitoringSelectionListStory,
    parameters: {
        layout: "padded",
    },
    title: "Monitoring/MonitoringSelectionList",
} satisfies Meta<typeof MonitoringSelectionListStory>;

export default meta;

type Story = StoryObj<typeof meta>;

export const VirtualizedInventory: Story = {
    play: async ({ args, canvasElement }) => {
        await expectVirtualizedList({
            canvasElement,
            itemCount: items.length,
            label: "Monitoring catalog",
        });
        await userEvent.click(
            within(canvasElement).getByRole("button", {
                name: "Monitoring item 49",
            })
        );
        await expect(args.onSelect).toHaveBeenCalledWith("monitoring-item-49");
    },
};
