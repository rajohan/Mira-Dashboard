import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { ChannelSection, type ChannelSummary } from "./ChannelSection";

const channels: ChannelSummary[] = [
    { details: "guild channel", enabled: true, id: "discord", policy: "primary" },
    { enabled: false, id: "telegram" },
];

describe("ChannelSection", () => {
    it("renders empty channel state", async () => {
        render(<ChannelSection channels={[]} onSave={vi.fn()} saving={false} />);

        await userEvent.click(screen.getByRole("button", { name: /Channels/u }));

        expect(
            screen.getByText("No channels configured in OpenClaw config.")
        ).toBeInTheDocument();
    });

    it("toggles channel state before saving", async () => {
        const onSave = vi.fn().mockImplementation(async () => {});
        render(<ChannelSection channels={channels} onSave={onSave} saving={false} />);

        await userEvent.click(screen.getByRole("button", { name: /Channels/u }));
        expect(screen.getByText("1/2 configured channels enabled")).toBeInTheDocument();
        expect(screen.getByText("primary · guild channel")).toBeInTheDocument();

        await userEvent.click(screen.getByRole("switch", { name: "telegram" }));
        await userEvent.click(screen.getByRole("button", { name: "Save channels" }));

        expect(onSave).toHaveBeenCalledWith([
            channels[0],
            { enabled: true, id: "telegram" },
        ]);
    });

    it("shows saving state", async () => {
        render(<ChannelSection channels={channels} onSave={vi.fn()} saving />);

        await userEvent.click(screen.getByRole("button", { name: /Channels/u }));

        expect(screen.getByRole("button", { name: "Saving..." })).toBeDisabled();
    });
});
