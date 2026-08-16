import { expect, test } from "bun:test";

import { mergeChatStreamText } from "./chatStreamText.ts";

test("converges cumulative and incremental chat stream text", () => {
    expect(mergeChatStreamText("previous", "")).toBe("previous");
    expect(mergeChatStreamText("", "next")).toBe("next");
    expect(mergeChatStreamText("Fixture ", "Fixture complete.")).toBe(
        "Fixture complete."
    );
    expect(mergeChatStreamText("abc", "bc")).toBe("abc");
    expect(mergeChatStreamText("abc", "def")).toBe("abcdef");
    expect(mergeChatStreamText("Fikset og", "ikset og aktivt")).toBe("Fikset og aktivt");
    expect(mergeChatStreamText("OpenClaw-snapshots", "snapshots flettes")).toBe(
        "OpenClaw-snapshots flettes"
    );
});
