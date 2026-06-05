import { describe, expect, it } from "vitest";

import { buildSlashCommandSuggestions, slashCommandCanonicalName } from "./slashCommands";

describe("slash commands", () => {
    it("normalizes aliases to canonical command names", () => {
        expect(slashCommandCanonicalName("/abort")).toBe("/stop");
        expect(slashCommandCanonicalName("/T")).toBe("/think");
        expect(slashCommandCanonicalName("/tell")).toBe("/steer");
        expect(slashCommandCanonicalName("/side")).toBe("/btw");
        expect(slashCommandCanonicalName("/plugin")).toBe("/plugins");
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

        expect(buildSlashCommandSuggestions("/status ", [])).toEqual([]);

        expect(buildSlashCommandSuggestions("/queue c", [])).toEqual([
            {
                value: "/queue collect",
                title: "collect",
                description: "Manage active-run queue behavior",
            },
        ]);
    });

    it("suggests the documented OpenClaw command catalog", () => {
        expect(buildSlashCommandSuggestions("/ste", [])[0]).toMatchObject({
            value: "/steer ",
            title: "/steer <message>",
        });
        expect(buildSlashCommandSuggestions("/tr", [])).toContainEqual(
            expect.objectContaining({
                value: "/trace ",
                title: "/trace [off|on|raw]",
            })
        );
        expect(buildSlashCommandSuggestions("/exe", [])[0]).toMatchObject({
            value: "/exec ",
            title: "/exec [auto|sandbox|gateway|node] [deny|allowlist|full] [off|on-miss|always] [nodeId]",
        });
        expect(buildSlashCommandSuggestions("/bt", [])[0]).toMatchObject({
            value: "/btw ",
            title: "/btw <question>",
        });
        expect(buildSlashCommandSuggestions("/dock_m", [])[0]).toMatchObject({
            value: "/dock_mattermost",
            title: "/dock_mattermost",
        });
        expect(buildSlashCommandSuggestions("/cod", [])[0]).toMatchObject({
            value: "/codex ",
            title: "/codex [status|models|threads|resume|compact|review|diagnostics|account|mcp|skills]",
        });
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
