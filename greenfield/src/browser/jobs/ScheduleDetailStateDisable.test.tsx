import { describe, expect, jest, test } from "bun:test";

import { useState } from "react";

import { ScheduleDetail } from "./ScheduleDetail.tsx";
import { enabledSchedule } from "./testSupport/ScheduleDetail.tsx";

const { render, screen, waitFor, within } = await import("@testing-library/react");
const userEventModule = await import("@testing-library/user-event");
const userEvent = userEventModule.default;

describe("schedule detail interaction state", () => {
    test("keeps a rejected disable draft and its classified failure inside the dialog", async () => {
        const classifiedFailure =
            "The job state changed. Refresh the page and try again.";
        const onDisable = jest.fn();

        function RejectedDisableIntent() {
            const [error, setError] = useState<string>();
            return (
                <ScheduleDetail
                    disableError={error}
                    history={<p>Run history</p>}
                    onDisable={(draft) => {
                        onDisable(draft);
                        setError(classifiedFailure);
                        return Promise.reject(new TypeError("conflict"));
                    }}
                    onEnable={async () => {}}
                    onOpenDisable={() => setError(undefined)}
                    onRun={async () => {}}
                    onSaveConfiguration={async () => {}}
                    runBusy={false}
                    schedule={enabledSchedule()}
                    updateBusy={false}
                />
            );
        }

        render(<RejectedDisableIntent />);
        const user = userEvent.setup();
        await user.click(screen.getByRole("button", { name: "Disable" }));
        await user.click(screen.getByRole("radio", { name: /Indefinitely/u }));
        const reason = screen.getByLabelText("Comment");
        await user.type(reason, "Keep this draft");
        await user.click(screen.getByRole("button", { name: "Disable schedule" }));

        const dialog = screen.getByRole("dialog");
        const alert = await within(dialog).findByRole("alert");
        expect(alert).toHaveTextContent(classifiedFailure);
        expect(screen.getAllByRole("alert")).toHaveLength(1);
        expect(reason).toHaveValue("Keep this draft");
        expect(onDisable).toHaveBeenCalledWith({ reason: "Keep this draft" });
        await waitFor(() => expect(alert).toHaveFocus());
    });
});
