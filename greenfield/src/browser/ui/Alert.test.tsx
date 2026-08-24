import { describe, expect, mock, test } from "bun:test";

import { Alert } from "./Alert.tsx";
import { Button } from "./Button.tsx";

const { render, screen, within } = await import("@testing-library/react");
const userEventModule = await import("@testing-library/user-event");
const userEvent = userEventModule.default;

describe("Alert", () => {
    test("renders an action inside the feedback region", () => {
        render(
            <Alert
                action={<Button>Try again</Button>}
                message="Retained data is shown."
                variant="warning"
            />
        );

        const status = screen.getByRole("status");
        expect(within(status).getByRole("button", { name: "Try again" })).toBeVisible();
    });
    test("keeps dismissal optional", () => {
        render(<Alert message="The schedule could not be saved." />);

        expect(screen.getByRole("alert")).toHaveTextContent(
            "The schedule could not be saved."
        );
        expect(screen.queryByRole("button")).toBeNull();
    });

    test("exposes a labelled dismiss action when requested", async () => {
        const onDismiss = mock(() => null);
        const user = userEvent.setup();
        render(
            <Alert
                dismissLabel="Dismiss save error"
                message="The schedule could not be saved."
                onDismiss={onDismiss}
            />
        );

        await user.click(screen.getByRole("button", { name: "Dismiss save error" }));

        expect(onDismiss).toHaveBeenCalledTimes(1);
    });

    test("renders operator attention as a non-focusing warning status", () => {
        render(<Alert message="Maintenance review is required." variant="warning" />);

        expect(screen.getByRole("status")).toHaveTextContent(
            "Maintenance review is required."
        );
        expect(screen.queryByRole("alert")).toBeNull();
    });
});
