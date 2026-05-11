import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { HeartbeatSection } from "./HeartbeatSection";

describe("HeartbeatSection", () => {
    it("submits updated heartbeat settings", async () => {
        const onSave = vi.fn().mockImplementation(async () => {});
        render(
            <HeartbeatSection
                every={1800}
                onSave={onSave}
                saving={false}
                target="discord"
            />
        );

        await userEvent.click(screen.getByRole("button", { name: /Heartbeat/u }));
        const intervalInput = screen.getByDisplayValue("1800");
        await userEvent.clear(intervalInput);
        await userEvent.type(intervalInput, "900");
        const targetInput = screen.getByDisplayValue("discord");
        await userEvent.clear(targetInput);
        await userEvent.type(targetInput, "ops");
        await userEvent.click(screen.getByRole("button", { name: "Save" }));

        await waitFor(() => expect(onSave).toHaveBeenCalledWith(900, "ops"));
    });

    it("shows saving state", async () => {
        render(
            <HeartbeatSection every={1800} onSave={vi.fn()} saving target="discord" />
        );

        await userEvent.click(screen.getByRole("button", { name: /Heartbeat/u }));

        expect(screen.getByRole("button", { name: "Saving..." })).toBeDisabled();
    });
});
