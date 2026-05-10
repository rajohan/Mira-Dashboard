import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { ModelSection } from "./ModelSection";

describe("ModelSection", () => {
    it("edits and saves model settings", async () => {
        const onSave = vi.fn().mockImplementation(async () => {});
        render(
            <ModelSection
                defaultModel="codex"
                fallbacks={["glm51", "kimi"]}
                imageGenerationModel="openai/gpt-image-2"
                imageModel="codex"
                onSave={onSave}
                saving={false}
            />
        );

        await userEvent.click(
            screen.getByRole("button", { name: /Model Configuration/u })
        );
        await userEvent.clear(screen.getByDisplayValue("codex"));
        await userEvent.type(screen.getByPlaceholderText("codex"), "glm5");
        await userEvent.clear(screen.getByDisplayValue("glm51, kimi"));
        await userEvent.type(screen.getByPlaceholderText("glm51, kimi"), "kimi, glm47");
        await userEvent.click(
            screen.getByRole("button", { name: "Save model settings" })
        );

        expect(screen.getByText("Image model")).toBeInTheDocument();
        expect(screen.getByText("openai/gpt-image-2")).toBeInTheDocument();
        expect(onSave).toHaveBeenCalledWith({
            primary: "glm5",
            fallbacks: ["kimi", "glm47"],
        });
    });

    it("disables save without a primary model", async () => {
        render(
            <ModelSection
                defaultModel="codex"
                fallbacks={[]}
                onSave={vi.fn()}
                saving={false}
            />
        );

        await userEvent.click(
            screen.getByRole("button", { name: /Model Configuration/u })
        );
        await userEvent.clear(screen.getByDisplayValue("codex"));

        expect(
            screen.getByRole("button", { name: "Save model settings" })
        ).toBeDisabled();
    });
});
