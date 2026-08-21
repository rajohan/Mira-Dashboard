import { beforeEach, describe, expect, test } from "bun:test";

import {
    defaultChatDisplaySettings,
    readChatDisplaySettings,
    writeChatDisplaySettings,
} from "./chatLocalPreferences.ts";

const diagnosticKey = "mira-dashboard-chat-diagnostic-visibility";

beforeEach(() => {
    localStorage.clear();
});

describe("chat local preferences", () => {
    test("defaults diagnostics to private and preserves the legacy storage shape", () => {
        expect(readChatDisplaySettings()).toEqual(defaultChatDisplaySettings);
        expect(defaultChatDisplaySettings).toEqual({
            keepThinkingAfterFinal: false,
            showThinking: false,
            showTools: false,
            toolsExpanded: false,
        });

        writeChatDisplaySettings({
            keepThinkingAfterFinal: true,
            showThinking: true,
            showTools: false,
            toolsExpanded: false,
        });

        expect(JSON.parse(localStorage.getItem(diagnosticKey) ?? "null")).toEqual({
            keepThinkingAfterFinal: true,
            thinking: true,
            toolDetailsExpanded: false,
            tools: false,
        });
        expect(readChatDisplaySettings()).toEqual({
            keepThinkingAfterFinal: true,
            showThinking: true,
            showTools: false,
            toolsExpanded: false,
        });
    });

    test("removes corrupt or oversized diagnostic values", () => {
        localStorage.setItem(diagnosticKey, '{"thinking":"private prompt"}');
        expect(readChatDisplaySettings()).toEqual(defaultChatDisplaySettings);
        expect(localStorage.getItem(diagnosticKey)).toBeNull();

        localStorage.setItem(diagnosticKey, "x".repeat(4097));
        expect(readChatDisplaySettings()).toEqual(defaultChatDisplaySettings);
        expect(localStorage.getItem(diagnosticKey)).toBeNull();
    });
});
