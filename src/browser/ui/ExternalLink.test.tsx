import { describe, expect, test } from "bun:test";

import { ExternalLink } from "./ExternalLink.tsx";

const { render, screen } = await import("@testing-library/react");

describe("ExternalLink", () => {
    test("opens outside the Dashboard without exposing its opener", () => {
        render(
            <ExternalLink href="https://github.com/rajohan/Mira-Dashboard">
                Mira Dashboard on GitHub
            </ExternalLink>
        );

        const link = screen.getByRole("link", {
            name: "Mira Dashboard on GitHub (opens in a new tab)",
        });
        expect(link.getAttribute("href")).toBe(
            "https://github.com/rajohan/Mira-Dashboard"
        );
        expect(link.getAttribute("rel")).toBe("noopener noreferrer");
        expect(link.getAttribute("target")).toBe("_blank");
        expect(link.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    });

    test("can omit the decorative icon without weakening link semantics", () => {
        render(
            <ExternalLink href="https://example.com" showIcon={false}>
                Example
            </ExternalLink>
        );

        const link = screen.getByRole("link", {
            name: "Example (opens in a new tab)",
        });
        expect(link.querySelector("svg")).toBeNull();
        expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    });
});
