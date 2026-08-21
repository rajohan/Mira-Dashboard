import { describe, expect, jest, test } from "bun:test";

import { maxTime } from "date-fns/constants";

import {
    disabledSchedule,
    renderScheduleDetail,
    timestampMs,
} from "./testSupport/ScheduleDetail.tsx";

const { fireEvent, screen, waitFor } = await import("@testing-library/react");
const userEventModule = await import("@testing-library/user-event");
const userEvent = userEventModule.default;

describe("schedule detail disable form", () => {
    test("round-trips a contract-maximum disable expiry without overflowing Date", async () => {
        const onDisable = jest.fn(async () => {});
        renderScheduleDetail({ onDisable, schedule: disabledSchedule(maxTime) });
        const user = userEvent.setup();

        await user.click(screen.getByRole("button", { name: "Edit disabled state" }));

        expect(
            screen.getByRole("button", {
                name: /Choose Disabled until date, selected \d{2}\.\d{2}\.\d{4,6}/u,
            })
        ).toBeVisible();
        fireEvent.change(screen.getByLabelText("Comment"), {
            target: { value: "Updated maintenance" },
        });
        await user.click(screen.getByRole("button", { name: "Save disabled state" }));
        expect(onDisable).toHaveBeenCalledWith(
            {
                expiresAtMs: maxTime,
                reason: "Updated maintenance",
            },
            2
        );
    });

    test("preserves sub-minute precision in an existing disable expiry", async () => {
        const expiry = timestampMs + 60_123;
        const onDisable = jest.fn(async () => {});
        renderScheduleDetail({ onDisable, schedule: disabledSchedule(expiry) });
        const user = userEvent.setup();

        await user.click(screen.getByRole("button", { name: "Edit disabled state" }));
        expect(screen.getByRole("group", { name: "Disabled until" })).toBeVisible();
        fireEvent.change(screen.getByLabelText("Comment"), {
            target: { value: "Updated maintenance" },
        });
        await user.click(screen.getByRole("button", { name: "Save disabled state" }));
        expect(onDisable).toHaveBeenCalledWith(
            {
                expiresAtMs: expiry,
                reason: "Updated maintenance",
            },
            2
        );
    });

    test("associates an invalid expiry with only the expiry control", async () => {
        const onDisable = jest.fn(async () => {});
        const pastExpiry = Date.now() - 60_000;
        const schedule = disabledSchedule(pastExpiry);
        schedule.activeDisableIntent = {
            ...schedule.activeDisableIntent!,
            createdAtMs: pastExpiry - 60_000,
        };
        renderScheduleDetail({ onDisable, schedule });
        const user = userEvent.setup();

        await user.click(screen.getByRole("button", { name: "Edit disabled state" }));
        fireEvent.change(screen.getByLabelText("Comment"), {
            target: { value: "Updated maintenance" },
        });
        const expiry = screen.getByRole("group", { name: "Disabled until" });
        const expiryTrigger = screen.getByRole("button", {
            name: /Choose Disabled until date/u,
        });
        await user.click(screen.getByRole("button", { name: "Save disabled state" }));

        const expiryError = screen.getByText("Choose a future date and time.");
        const describedBy = expiry.getAttribute("aria-describedby")?.split(" ");
        expect(describedBy).toContain(expiryError.id);
        expect(expiry).toHaveAttribute("data-invalid");
        expect(screen.getByLabelText("Comment")).not.toHaveAttribute("data-invalid");
        expect(onDisable).not.toHaveBeenCalled();
        await waitFor(() => expect(expiryTrigger).toHaveFocus());
        expect(screen.getByRole("form", { name: "Edit disabled state" })).toHaveAttribute(
            "novalidate"
        );
    });

    test("validates disable reasons with the shared control-safe code-point schema", async () => {
        const onDisable = jest.fn(async () => {});
        renderScheduleDetail({ onDisable });
        const user = userEvent.setup();

        await user.click(screen.getByRole("button", { name: "Disable" }));
        await user.click(screen.getByRole("radio", { name: /Indefinitely/u }));
        expect(screen.queryByRole("group", { name: "Disabled until" })).toBeNull();
        const reason = screen.getByLabelText("Comment");
        expect(reason).toHaveAttribute(
            "placeholder",
            "Waiting for the maintenance window to finish"
        );
        fireEvent.change(reason, { target: { value: "Unsafe\nreason" } });
        await user.click(screen.getByRole("button", { name: "Disable schedule" }));

        const error = screen.getByText("Enter between 1 and 1,000 characters.");
        expect(reason.getAttribute("aria-describedby")?.split(" ")).toContain(error.id);
        expect(reason).toHaveAttribute("data-invalid");
        expect(onDisable).not.toHaveBeenCalled();
        await waitFor(() => expect(reason).toHaveFocus());

        const maximumAstralReason = "😀".repeat(1000);
        fireEvent.change(reason, { target: { value: maximumAstralReason } });
        await user.click(screen.getByRole("button", { name: "Disable schedule" }));
        expect(onDisable).toHaveBeenCalledWith({ reason: maximumAstralReason }, 1);
    });

    test("does not resubmit an unchanged disable intent", async () => {
        const onDisable = jest.fn(async () => {});
        renderScheduleDetail({ onDisable, schedule: disabledSchedule(maxTime) });
        const user = userEvent.setup();

        await user.click(screen.getByRole("button", { name: "Edit disabled state" }));
        const save = screen.getByRole("button", { name: "Save disabled state" });
        expect(save).toBeDisabled();
        fireEvent.submit(screen.getByRole("form", { name: "Edit disabled state" }));
        expect(onDisable).not.toHaveBeenCalled();
    });
});
