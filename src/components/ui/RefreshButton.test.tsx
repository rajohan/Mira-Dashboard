import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, jest } from "bun:test";

import { RefreshButton } from "./RefreshButton";

describe("RefreshButton", () => {
    it("calls onClick when enabled", async () => {
        const onClick = jest.fn();
        render(<RefreshButton onClick={onClick} label="Reload" />);

        await userEvent.click(screen.getByRole("button", { name: "Reload" }));

        expect(onClick).toHaveBeenCalledTimes(1);
    });

    it("disables while loading and hides empty labels", () => {
        const { container } = render(
            <RefreshButton onClick={jest.fn()} isLoading label="" />
        );

        expect(within(container).getByRole("button")).toBeDisabled();
        expect(within(container).queryByText("Refresh")).not.toBeInTheDocument();
    });
});
