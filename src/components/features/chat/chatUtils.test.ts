import { afterEach, describe, expect, it, vi } from "vitest";

import type { ChatHistoryMessage } from "./chatTypes";
import {
    base64ToText,
    dataUrlToBase64,
    dedupeMessages,
    displayMimeType,
    mergeWithRecentOptimisticMessages,
    messageDeleteKey,
    messageIdentity,
    readFileAsDataUrl,
} from "./chatUtils";

function message(overrides: Partial<ChatHistoryMessage>): ChatHistoryMessage {
    return {
        role: "assistant",
        content: overrides.text || "",
        text: "",
        ...overrides,
    };
}

describe("chat utils", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("converts data URLs and base64 text", () => {
        expect(dataUrlToBase64("data:text/plain;base64,aGVsbG8=")).toBe("aGVsbG8=");
        expect(dataUrlToBase64("raw-base64")).toBe("raw-base64");
        expect(base64ToText("aGVsbG8=")).toBe("hello");
    });

    it("builds stable message identity and delete keys", () => {
        const item = message({
            role: "Assistant",
            text: "  hello  ",
            timestamp: "2026-05-10T10:00:00.000Z",
            runId: "run-1",
        });

        expect(messageIdentity(item)).toBe("assistant::hello");
        expect(messageDeleteKey(item)).toBe(
            "assistant::2026-05-10T10:00:00.000Z::run-1::hello"
        );
        expect(messageDeleteKey(message({ role: "user", text: "hi" }))).toBe(
            "user::no-time::no-run::hi"
        );
    });

    it("dedupes messages from the newest duplicate while retaining empty text rows", () => {
        const first = message({ role: "assistant", text: "same", timestamp: "1" });
        const newer = message({ role: "assistant", text: "same", timestamp: "2" });
        const empty = message({ role: "assistant", text: "" });

        expect(dedupeMessages([first, empty, newer])).toEqual([empty, newer]);
    });

    it("retains recent optimistic and local messages missing from refreshed history", () => {
        vi.spyOn(Date, "now").mockReturnValue(
            new Date("2026-05-10T10:02:00.000Z").getTime()
        );

        const previous = [
            message({
                role: "user",
                text: "recent local send",
                timestamp: "2026-05-10T10:01:30.000Z",
            }),
            message({
                role: "user",
                text: "old send",
                timestamp: "2026-05-10T09:00:00.000Z",
            }),
            message({ role: "system", text: "local notice", local: true }),
        ];
        const next = [
            message({
                role: "assistant",
                text: "server reply",
                timestamp: "2026-05-10T10:01:45.000Z",
            }),
        ];

        expect(
            mergeWithRecentOptimisticMessages(previous, next).map((item) => item.text)
        ).toEqual(["recent local send", "server reply", "local notice"]);
    });

    it("does not retain optimistic assistant text recovered in refreshed history", () => {
        vi.spyOn(Date, "now").mockReturnValue(
            new Date("2026-05-10T10:02:00.000Z").getTime()
        );

        const previous = [
            message({
                role: "assistant",
                text: "This response is still streaming from the assistant",
                timestamp: "2026-05-10T10:01:30.000Z",
            }),
        ];
        const next = [
            message({ role: "assistant", text: "response is still streaming" }),
        ];

        expect(mergeWithRecentOptimisticMessages(previous, next)).toHaveLength(1);
    });

    it("reads file metadata and file contents for attachments", async () => {
        const file = new File(["hello"], "note.txt", { type: "text/plain" });
        const unknownType = new File(["{}"], "data.bin");

        await expect(readFileAsDataUrl(file)).resolves.toMatch(
            /^data:text\/plain;base64,aGVsbG8=/
        );
        expect(displayMimeType(file)).toBe("text/plain");
        expect(displayMimeType(unknownType)).toBe("application/octet-stream");
    });
});
