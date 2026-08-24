import { describe, expect, mock, test } from "bun:test";

import { Alert } from "./Alert.tsx";

const { render, screen } = await import("@testing-library/react");
const userEventModule = await import("@testing-library/user-event");
const userEvent = userEventModule.default;

describe("Alert", () => {
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
});
