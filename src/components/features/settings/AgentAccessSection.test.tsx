import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { AgentConfig } from "../../../hooks/useConfig";
import { AgentAccessSection } from "./AgentAccessSection";

const agents: AgentConfig[] = [
    { id: "main", name: "Mira", tools: { deny: ["exec"] } },
    { id: "researcher", name: "Researcher", tools: { allow: ["web_search"] } },
];

describe("AgentAccessSection", () => {
    it("renders agent tool counts and saves deny-list edits", async () => {
        const user = userEvent.setup();
        const onSave = vi.fn(async () => {});

        render(<AgentAccessSection agents={agents} onSave={onSave} saving={false} />);

        await user.click(screen.getByRole("button", { name: /Agent access control/u }));

        expect(screen.getByRole("button", { name: /Mira/u })).toHaveTextContent(
            "21/22 tools"
        );
        expect(screen.getByRole("button", { name: /Researcher/u })).toHaveTextContent(
            "1/22 tools"
        );
        expect(screen.getByText("Shell Commands")).toBeInTheDocument();

        const execSwitch = within(
            screen.getByText("Shell Commands").parentElement!.parentElement!
        ).getByRole("switch");
        expect(execSwitch).toHaveAttribute("aria-checked", "false");

        await user.click(execSwitch);
        await user.click(screen.getByRole("button", { name: "Save access control" }));

        expect(onSave).toHaveBeenCalledWith([
            { id: "main", name: "Mira", tools: { deny: [] } },
            agents[1],
        ]);
    });

    it("filters tools, updates allow-list agents, and resets active agent on prop changes", async () => {
        const user = userEvent.setup();
        const onSave = vi.fn(async () => {});
        const { rerender } = render(
            <AgentAccessSection agents={agents} onSave={onSave} saving={false} />
        );

        await user.click(screen.getByRole("button", { name: /Agent access control/u }));
        await user.click(screen.getByRole("button", { name: /Researcher/u }));
        await user.type(screen.getByPlaceholderText("Filter tools..."), "web");

        expect(await screen.findByText("Web Search")).toBeInTheDocument();
        expect(screen.getByText("Web Fetch")).toBeInTheDocument();
        expect(screen.queryByText("Shell Commands")).not.toBeInTheDocument();

        await user.click(screen.getAllByRole("switch")[1]);
        await user.click(screen.getByRole("button", { name: "Save access control" }));

        expect(onSave).toHaveBeenLastCalledWith([
            agents[0],
            {
                id: "researcher",
                name: "Researcher",
                tools: { allow: ["web_fetch", "web_search"], deny: [] },
            },
        ]);

        rerender(
            <AgentAccessSection
                agents={[{ id: "coder", name: "Coder", tools: { deny: [] } }]}
                onSave={onSave}
                saving
            />
        );

        expect(await screen.findByRole("button", { name: /Coder/u })).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Saving..." })).toBeDisabled();
    });
});
