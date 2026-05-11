import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { ConfigSection } from "./ConfigSection";

describe("ConfigSection", () => {
    it("expands config groups and selects files", async () => {
        const user = userEvent.setup();
        const onSelect = vi.fn();

        render(<ConfigSection selectedPath="config:openclaw.json" onSelect={onSelect} />);

        expect(screen.getByText("openclaw.json")).toBeInTheDocument();
        expect(screen.queryByText("jobs.json")).not.toBeInTheDocument();
        expect(screen.queryByText("agentmail.ts")).not.toBeInTheDocument();

        await user.click(screen.getByText("cron"));
        await user.click(screen.getByText("jobs.json"));
        await user.click(screen.getByText("hooks"));
        await user.click(screen.getByText("agentmail.ts"));
        await user.click(screen.getByText("openclaw.json"));

        expect(screen.getByText("transforms")).toBeInTheDocument();
        expect(onSelect).toHaveBeenNthCalledWith(1, "config:cron/jobs.json");
        expect(onSelect).toHaveBeenNthCalledWith(
            2,
            "config:hooks/transforms/agentmail.ts"
        );
        expect(onSelect).toHaveBeenNthCalledWith(3, "config:openclaw.json");
    });
});
