import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { SecuritySection } from "./SecuritySection";

describe("SecuritySection", () => {
    it("renders read-only security settings", async () => {
        render(
            <SecuritySection
                authProfiles={2}
                commandRestartEnabled
                elevatedEnabled={false}
                execAsk="on-miss"
                execSecurity="allowlist"
                ownerAllowFrom="raymond"
                redactionMode="strict"
            />
        );

        await userEvent.click(screen.getByRole("button", { name: /Security/u }));

        expect(screen.getByText("Auth profiles")).toBeInTheDocument();
        expect(screen.getByText("2")).toBeInTheDocument();
        expect(screen.getByText("Command restart")).toBeInTheDocument();
        expect(screen.getByText("Enabled")).toBeInTheDocument();
        expect(screen.getByText("Elevated tools")).toBeInTheDocument();
        expect(screen.getByText("Disabled")).toBeInTheDocument();
        expect(screen.getByText("allowlist")).toBeInTheDocument();
        expect(screen.getByText("strict")).toBeInTheDocument();
    });
});
