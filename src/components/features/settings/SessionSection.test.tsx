import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { SessionSection } from "./SessionSection";

describe("SessionSection", () => {
    it("submits updated idle timeout", async () => {
        const onSave = vi.fn().mockImplementation(async () => {});
        render(<SessionSection idleMinutes={60} onSave={onSave} saving={false} />);

        await userEvent.click(screen.getByRole("button", { name: /Session/u }));
        const idleInput = screen.getByDisplayValue("60");
        await userEvent.clear(idleInput);
        await userEvent.type(idleInput, "120");
        await userEvent.click(screen.getByRole("button", { name: "Save" }));

        await waitFor(() => expect(onSave).toHaveBeenCalledWith(120));
    });

    it("shows saving state", async () => {
        render(<SessionSection idleMinutes={60} onSave={vi.fn()} saving />);

        await userEvent.click(screen.getByRole("button", { name: /Session/u }));

        expect(screen.getByRole("button", { name: "Saving..." })).toBeDisabled();
    });
});
