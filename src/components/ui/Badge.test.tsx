import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Badge, getSessionTypeVariant } from "./Badge";

describe("Badge", () => {
    it("renders children with the selected variant and merged classes", () => {
        render(
            <Badge variant="success" className="px-4">
                Ready
            </Badge>
        );

        expect(screen.getByText("Ready")).toHaveClass("bg-green-500/20", "px-4");
    });

    it("maps session types to badge variants", () => {
        expect(getSessionTypeVariant("MAIN")).toBe("main");
        expect(getSessionTypeVariant("HOOK")).toBe("hook");
        expect(getSessionTypeVariant("CRON")).toBe("cron");
        expect(getSessionTypeVariant("SUBAGENT")).toBe("subagent");
        expect(getSessionTypeVariant("unknown")).toBe("default");
        expect(getSessionTypeVariant(null)).toBe("default");
    });
});
