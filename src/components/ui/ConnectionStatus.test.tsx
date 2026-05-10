import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ConnectionStatus } from "./ConnectionStatus";

describe("ConnectionStatus", () => {
    it("renders connected and disconnected states", () => {
        const { rerender } = render(
            <ConnectionStatus isConnected connectedText="Online" />
        );
        expect(screen.getByText("Online")).toHaveClass("text-green-400");

        rerender(<ConnectionStatus isConnected={false} disconnectedText="Offline" />);
        expect(screen.getByText("Offline")).toHaveClass("text-red-400");
    });
});
