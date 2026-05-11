import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { ToolSection, type ToolSettings } from "./ToolSection";

const defaultProps = {
    agentToAgentEnabled: false,
    elevatedEnabled: false,
    execAsk: "on-miss",
    execSecurity: "allowlist",
    onSave: vi.fn(),
    profile: "full",
    saving: false,
    sessionsVisibility: "all",
    webFetchEnabled: true,
    webSearchEnabled: true,
    webSearchProvider: "brave",
} satisfies React.ComponentProps<typeof ToolSection>;

function renderToolSection(
    props: Partial<React.ComponentProps<typeof ToolSection>> = {}
) {
    const mergedProps = {
        ...defaultProps,
        onSave: vi.fn().mockImplementation(async () => {}),
        ...props,
    } satisfies React.ComponentProps<typeof ToolSection>;

    return {
        ...render(<ToolSection {...mergedProps} />),
        props: mergedProps,
    };
}

describe("ToolSection", () => {
    it("edits toggles and saves tool settings", async () => {
        const onSave = vi.fn().mockImplementation(async () => {});
        renderToolSection({ onSave });

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
        renderToolSection({
            execAsk: "off",
            execSecurity: "deny",
            saving: true,
            webFetchEnabled: false,
            webSearchEnabled: false,
        });

        await userEvent.click(screen.getByRole("button", { name: /Tools/u }));

        expect(screen.getByRole("button", { name: "Saving..." })).toBeDisabled();
    });

    it("edits exec selectors, elevated switch, and optional visibility", async () => {
        const user = userEvent.setup();
        const onSave = vi.fn().mockImplementation(async () => {});
        renderToolSection({ onSave, sessionsVisibility: undefined });

        await user.click(screen.getByRole("button", { name: /Tools/u }));
        await user.click(screen.getByRole("button", { name: "Allowlist" }));
        await user.click(screen.getByRole("menuitem", { name: "Full" }));
        await user.click(screen.getByRole("button", { name: "On miss" }));
        await user.click(screen.getByRole("menuitem", { name: "Always" }));
        await user.click(screen.getByRole("switch", { name: "Web fetch" }));
        await user.click(screen.getByRole("switch", { name: "Elevated tools" }));
        await user.type(screen.getByPlaceholderText("all"), "visible");
        await user.click(screen.getByRole("button", { name: "Save tool settings" }));

        expect(onSave).toHaveBeenCalledWith({
            agentToAgentEnabled: false,
            elevatedEnabled: true,
            execAsk: "always",
            execSecurity: "full",
            profile: "full",
            sessionsVisibility: "visible",
            webFetchEnabled: false,
            webSearchEnabled: true,
            webSearchProvider: "brave",
        });
    });

    it("resets draft values when saved settings change", async () => {
        const user = userEvent.setup();
        const onSave = vi.fn().mockImplementation(async (values: ToolSettings) => values);
        const { rerender } = renderToolSection({ onSave });

        await user.click(screen.getByRole("button", { name: /Tools/u }));
        await user.clear(screen.getByDisplayValue("full"));
        await user.type(screen.getByPlaceholderText("full"), "temporary");

        rerender(
            <ToolSection
                {...defaultProps}
                execAsk="off"
                execSecurity="deny"
                onSave={onSave}
                profile="restricted"
                sessionsVisibility="visible"
                webFetchEnabled={false}
                webSearchEnabled={false}
                webSearchProvider="search-provider"
            />
        );

        await user.click(screen.getByRole("button", { name: "Save tool settings" }));

        expect(onSave).toHaveBeenCalledWith({
            agentToAgentEnabled: false,
            elevatedEnabled: false,
            execAsk: "off",
            execSecurity: "deny",
            profile: "restricted",
            sessionsVisibility: "visible",
            webFetchEnabled: false,
            webSearchEnabled: false,
            webSearchProvider: "search-provider",
        });
    });
});
