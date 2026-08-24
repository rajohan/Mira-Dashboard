import type { Meta, StoryObj } from "@storybook/tanstack-react";
import type { ComponentProps } from "react";
import { useState } from "react";
import { useArgs } from "storybook/preview-api";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";

import { RadioGroup, type RadioGroupOption } from "../RadioGroup.tsx";

type ReleaseChannel = "beta" | "canary" | "stable";
type ReleaseChannelProperties = ComponentProps<typeof RadioGroup<ReleaseChannel>>;

const releaseChannels = Object.freeze([
    {
        description: "Reviewed releases intended for routine operation.",
        label: "Stable",
        value: "stable",
    },
    {
        description: "Release candidates for early verification.",
        label: "Beta",
        value: "beta",
    },
    {
        description: "Unavailable while the worker is production-owned.",
        disabled: true,
        label: "Canary",
        value: "canary",
    },
] satisfies readonly RadioGroupOption<ReleaseChannel>[]);

interface ReleaseChannelStoryProperties {
    readonly className: string;
    readonly properties: ReleaseChannelProperties;
    readonly updateProperties: (properties: Partial<ReleaseChannelProperties>) => void;
}

function ReleaseChannelStory({
    className,
    properties,
    updateProperties,
}: ReleaseChannelStoryProperties) {
    const [value, setValue] = useState(properties.value);

    return (
        <div className={className}>
            <RadioGroup
                {...properties}
                onChange={(nextValue) => {
                    setValue(nextValue);
                    updateProperties({ value: nextValue });
                    properties.onChange(nextValue);
                }}
                value={value}
            />
        </div>
    );
}

function RenderControlledReleaseChannel(properties: ReleaseChannelProperties) {
    const [, updateProperties] = useArgs<ReleaseChannelProperties>();

    return (
        <ReleaseChannelStory
            className="w-full max-w-3xl"
            key={properties.value}
            properties={properties}
            updateProperties={updateProperties}
        />
    );
}

function RenderNarrowReleaseChannel(properties: ReleaseChannelProperties) {
    const [, updateProperties] = useArgs<ReleaseChannelProperties>();

    return (
        <ReleaseChannelStory
            className="w-56 max-w-full"
            key={properties.value}
            properties={properties}
            updateProperties={updateProperties}
        />
    );
}

const meta = {
    args: {
        description: "Choose which reviewed release stream this worker follows.",
        label: "Release channel",
        onChange: fn(),
        options: releaseChannels,
        orientation: "horizontal",
        value: "stable",
    },
    component: RadioGroup,
    parameters: {
        layout: "padded",
    },
    render: RenderControlledReleaseChannel,
    title: "UI/RadioGroup",
} satisfies Meta<typeof RadioGroup<ReleaseChannel>>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
    play: async ({ canvasElement }) => {
        const radioCards = within(canvasElement).getAllByRole("radio");

        await waitFor(async () => {
            const expectedHeight = radioCards[0]?.getBoundingClientRect().height;
            await expect(expectedHeight).toBeGreaterThan(0);

            for (const radioCard of radioCards.slice(1)) {
                await expect(radioCard.getBoundingClientRect().height).toBeCloseTo(
                    expectedHeight ?? 0,
                    2
                );
            }
        });
    },
};

export const VerticalDefault: Story = {
    args: {
        orientation: undefined,
    },
    name: "Vertical (component default)",
    play: async ({ canvasElement }) => {
        await expect(
            within(canvasElement).getByRole("radiogroup", {
                name: "Release channel",
            })
        ).toHaveAttribute("aria-orientation", "vertical");
    },
};

export const Invalid: Story = {
    args: {
        error: "Choose an available release channel.",
        invalid: true,
    },
};

export const Disabled: Story = {
    args: {
        disabled: true,
    },
};

export const NarrowKeyboardSelection: Story = {
    play: async ({ args, canvasElement }) => {
        const canvas = within(canvasElement);
        const stable = canvas.getByRole("radio", { name: "Stable" });

        await userEvent.tab();
        await expect(stable).toHaveFocus();
        await userEvent.keyboard("{ArrowRight}");
        await waitFor(async () => {
            await expect(canvas.getByRole("radio", { name: "Beta" })).toBeChecked();
        });
        await expect(args.onChange).toHaveBeenLastCalledWith("beta");
    },
    render: RenderNarrowReleaseChannel,
};
