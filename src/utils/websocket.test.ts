import { describe, expect, it } from "vitest";

import { getWebSocketUrl } from "./websocket";

function setWindowLocation(location: {
    protocol: string;
    hostname: string;
    port: string;
}) {
    Object.defineProperty(globalThis, "window", {
        configurable: true,
        value: { location },
    });
}

describe("websocket utils", () => {
    it("uses the configured dev backend port for Vite", () => {
        setWindowLocation({
            protocol: "http:",
            hostname: "127.0.0.1",
            port: "5173",
        });

        expect(getWebSocketUrl()).toBe("ws://127.0.0.1:3100/ws");
    });

    it("uses the current production port and secure protocol", () => {
        setWindowLocation({
            protocol: "https:",
            hostname: "dashboard.example.com",
            port: "",
        });

        expect(getWebSocketUrl()).toBe("wss://dashboard.example.com:3100/ws");
    });
});
