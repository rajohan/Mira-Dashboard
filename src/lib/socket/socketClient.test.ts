import { describe, expect, it } from "vitest";

import { createSocketClient } from "./socketClient";

describe("socketClient", () => {
    it("creates a client with connect/disconnect/request/isOpen", () => {
        const client = createSocketClient({ url: "ws://localhost" });
        expect(typeof client.connect).toBe("function");
        expect(typeof client.disconnect).toBe("function");
        expect(typeof client.request).toBe("function");
        expect(typeof client.isOpen).toBe("function");
    });

    it("rejects request when not connected", async () => {
        const client = createSocketClient({ url: "ws://localhost" });
        await expect(client.request("test")).rejects.toThrow("WebSocket not connected");
    });

    it("isOpen returns false when not connected", () => {
        const client = createSocketClient({ url: "ws://localhost" });
        expect(client.isOpen()).toBe(false);
    });
});
