import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { ToolSection } from "./ToolSection";

describe("ToolSection", () => {
    it("edits toggles and saves tool settings", async () => {
        const onSave = vi.fn().mockImplementation(async () => {});
        render(
            <ToolSection
                agentToAgentEnabled={false}
                elevatedEnabled={false}
                execAsk="on-miss"
                execSecurity="allowlist"
                onSave={onSave}
                profile="full"
                saving={false}
                sessionsVisibility="all"
                webFetchEnabled
                webSearchEnabled
                webSearchProvider="brave"
            />
        );

        await userEvent.click(screen.getByRole("button", { name: /Tools/u }));
        await userEvent.clear(screen.getByDisplayValue("full"));
        await userEvent.type(screen.getByPlaceholderText("full"), "safe");
        await userEvent.click(screen.getByRole("switch", { name: "Web search" }));
        await userEvent.click(screen.getByRole("switch", { name: "Agent-to-agent" }));
        await userEvent.clear(screen.getByDisplayValue("brave"));
        await userEvent.type(screen.getByPlaceholderText("brave"), "perplexity");
        await userEvent.click(screen.getByRole("button", { name: "Save tool settings" }));

        expect(onSave).toHaveBeenCalledWith({
            agentToAgentEnabled: true,
            elevatedEnabled: false,
            execAsk: "on-miss",
            execSecurity: "allowlist",
            profile: "safe",
            sessionsVisibility: "all",
            webFetchEnabled: true,
            webSearchEnabled: false,
            webSearchProvider: "perplexity",
        });
    });

    it("shows saving state", async () => {
        render(
            <ToolSection
                agentToAgentEnabled={false}
                elevatedEnabled={false}
                execAsk="off"
                execSecurity="deny"
                onSave={vi.fn()}
                saving
                webFetchEnabled={false}
                webSearchEnabled={false}
                webSearchProvider="brave"
            />
        );

        await userEvent.click(screen.getByRole("button", { name: /Tools/u }));

        expect(screen.getByRole("button", { name: "Saving..." })).toBeDisabled();
    });
});
