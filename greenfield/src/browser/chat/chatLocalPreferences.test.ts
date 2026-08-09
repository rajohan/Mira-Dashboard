import { beforeEach, describe, expect, test } from "bun:test";

import {
    addHiddenMessageId,
    defaultChatDisplaySettings,
    readChatDisplaySettings,
    readHiddenMessageIds,
    writeChatDisplaySettings,
} from "./chatLocalPreferences.ts";

const diagnosticKey = "mira-dashboard-chat-diagnostic-visibility";
const sessionKey = "agent:main:main";
const hiddenKey = `openclaw:deleted:${sessionKey}`;

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

    test("sanitizes hidden identities without retaining raw prompt-like values", () => {
        localStorage.setItem(
            hiddenKey,
            JSON.stringify([
                "message-1",
                "private prompt text",
                "message-1",
                "chat-row-occurrence:v1:1:2:3:abc:def",
            ])
        );

        expect([...readHiddenMessageIds(sessionKey)]).toEqual([
            "message-1",
            "chat-row-occurrence:v1:1:2:3:abc:def",
        ]);
        expect(JSON.parse(localStorage.getItem(hiddenKey) ?? "null")).toEqual([
            "message-1",
            "chat-row-occurrence:v1:1:2:3:abc:def",
        ]);
    });

    test("bounds hidden identities to the newest 512 entries", () => {
        const ids = Array.from({ length: 513 }, (_, index) => `message-${index}`);
        localStorage.setItem(hiddenKey, JSON.stringify(ids));

        const hidden = readHiddenMessageIds(sessionKey);
        expect(hidden.size).toBe(512);
        expect(hidden.has("message-0")).toBe(false);
        expect(hidden.has("message-512")).toBe(true);

        const inMemoryOnly = addHiddenMessageId(
            sessionKey,
            hidden,
            "this is raw message content"
        );
        expect(inMemoryOnly.has("this is raw message content")).toBe(true);
        expect(localStorage.getItem(hiddenKey)).not.toContain(
            "this is raw message content"
        );
    });

    test("removes corrupt and oversized hidden-message payloads", () => {
        localStorage.setItem(hiddenKey, "not-json");
        expect(readHiddenMessageIds(sessionKey).size).toBe(0);
        expect(localStorage.getItem(hiddenKey)).toBeNull();

        localStorage.setItem(hiddenKey, JSON.stringify("x".repeat(64 * 1024)));
        expect(readHiddenMessageIds(sessionKey).size).toBe(0);
        expect(localStorage.getItem(hiddenKey)).toBeNull();
    });
});
