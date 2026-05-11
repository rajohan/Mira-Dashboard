import { describe, expect, it } from "vitest";

import { buildSlashCommandSuggestions, slashCommandCanonicalName } from "./slashCommands";

describe("slash commands", () => {
    it("normalizes aliases to canonical command names", () => {
        expect(slashCommandCanonicalName("/abort")).toBe("/stop");
        expect(slashCommandCanonicalName("/T")).toBe("/think");
        expect(slashCommandCanonicalName("/unknown")).toBe("/unknown");
    });

    it("returns no suggestions for normal text", () => {
        expect(buildSlashCommandSuggestions("hello", [])).toEqual([]);
    });

    it("suggests matching commands and aliases", () => {
        expect(buildSlashCommandSuggestions("/st", [])[0]).toMatchObject({
            value: "/status",
            title: "/status",
        });
        expect(buildSlashCommandSuggestions("/ab", [])).toEqual([
            {
                value: "/abort",
                title: "/abort",
                description: "Stop the current run",
            },
        ]);
    });

    it("suggests configured choices for matched commands", () => {
        expect(buildSlashCommandSuggestions("/think h", [])).toEqual([
            {
                value: "/think high",
                title: "high",
                description: "Show or set thinking level",
            },
            {
                value: "/think xhigh",
                title: "xhigh",
                description: "Show or set thinking level",
            },
        ]);

        expect(buildSlashCommandSuggestions("/v f", [])).toEqual([
            {
                value: "/v off",
                title: "off",
                description: "Show or set verbose mode",
            },
            {
                value: "/v full",
                title: "full",
                description: "Show or set verbose mode",
            },
        ]);
    });

    it("uses available model options for /model suggestions", () => {
        const suggestions = buildSlashCommandSuggestions("/model g", [
            { id: "gpt-5.5", label: "GPT" },
            { label: "glm51" },
            { name: "kimi" },
            {},
        ]);

        expect(suggestions).toEqual([
            {
                value: "/model gpt-5.5",
                title: "gpt-5.5",
                description: "Show or set the model",
            },
            {
                value: "/model glm51",
                title: "glm51",
                description: "Show or set the model",
            },
        ]);
    });
});
