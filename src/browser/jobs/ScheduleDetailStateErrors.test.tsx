import { describe, expect, jest, test } from "bun:test";

import { renderScheduleDetail } from "./testSupport/ScheduleDetail.tsx";

const { screen, within } = await import("@testing-library/react");
const userEventModule = await import("@testing-library/user-event");
const userEvent = userEventModule.default;

describe("schedule detail interaction state", () => {
    test("keeps unrelated errors outside a freshly opened disable dialog", async () => {
        const onOpenDisable = jest.fn();
        renderScheduleDetail({
            error: "A background refresh failed.",
            onOpenDisable,
        });
        const user = userEvent.setup();

        await user.click(screen.getByRole("button", { name: "Disable" }));

        expect(onOpenDisable).toHaveBeenCalledTimes(1);
        expect(within(screen.getByRole("dialog")).queryByRole("alert")).toBeNull();
        expect(screen.queryByText("A background refresh failed.")).toBeNull();
    });
});
