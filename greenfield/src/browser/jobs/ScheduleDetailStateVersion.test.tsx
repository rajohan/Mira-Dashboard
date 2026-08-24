import { describe, expect, jest, test } from "bun:test";

import { ScheduleDetail } from "./ScheduleDetail.tsx";
import {
    enabledSchedule,
    renderScheduleDetail,
    timestampMs,
} from "./testSupport/ScheduleDetail.tsx";

const { fireEvent, screen, waitFor } = await import("@testing-library/react");
const userEventModule = await import("@testing-library/user-event");
const userEvent = userEventModule.default;

describe("schedule detail interaction state", () => {
    test("preserves the modal version and exact reason across a background refresh", async () => {
        const onDisable = jest.fn(async () => {});
        const schedule = enabledSchedule();
        const view = renderScheduleDetail({ onDisable, schedule });
        const user = userEvent.setup();

        await user.click(screen.getByRole("button", { name: "Disable" }));
        await user.click(screen.getByRole("radio", { name: /Indefinitely/u }));
        fireEvent.change(screen.getByLabelText("Comment"), {
            target: { value: "  Planned maintenance  " },
        });
        view.rerender(
            <ScheduleDetail
                history={<p>Run history</p>}
                onDisable={onDisable}
                onEnable={async () => {}}
                onOpenDisable={() => {}}
                onRun={async () => {}}
                onSaveConfiguration={async () => {}}
                runBusy={false}
                schedule={{ ...schedule, updatedAtMs: timestampMs + 1000, version: 2 }}
                updateBusy={false}
            />
        );
        await user.click(screen.getByRole("button", { name: "Disable schedule" }));

        expect(onDisable).toHaveBeenCalledWith({ reason: "  Planned maintenance  " }, 1);
        await waitFor(() =>
            expect(
                screen.getByRole("heading", { level: 2, name: "Worker smoke" })
            ).toHaveFocus()
        );
    });
});
