import type { Meta, StoryObj } from "@storybook/tanstack-react";
import { expect, fn, within } from "storybook/test";

import { Card } from "../Card.tsx";
import { VirtualizedList } from "../VirtualizedList.tsx";

const items = Array.from({ length: 150 }, (_, index) => ({
    id: `row-${index + 1}`,
    label: `Virtual row ${index + 1}`,
}));

function VirtualizedListStory() {
    return (
        <VirtualizedList
            className="max-h-96"
            estimateSize={() => 68}
            getKey={(item) => item.id}
            itemClassName="pb-2"
            items={items}
            label="Virtualized infinite rows"
            pagination={{
                hasMore: true,
                loading: true,
                loadingLabel: "Loading older virtual rows…",
                onLoadMore: fn(),
            }}
            renderItem={(item) => <Card className="p-3">{item.label}</Card>}
        />
    );
}

const metadata = {
    component: VirtualizedListStory,
    parameters: { layout: "padded" },
} satisfies Meta<typeof VirtualizedListStory>;

export default metadata;

type Story = StoryObj<typeof metadata>;

export const InfiniteHistory: Story = {
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        const list = canvas.getByRole("list", { name: "Virtualized infinite rows" });
        await expect(list.querySelectorAll("li").length).toBeLessThan(items.length);
    },
};
