import { expect, test } from "bun:test";

import { render, screen } from "@testing-library/react";

import { TerminalBrowserDependenciesProvider } from "./terminalBrowserDependencies.tsx";
import {
    type TerminalBrowserDependencies,
    useTerminalBrowserDependencies,
} from "./terminalBrowserDependenciesContext.ts";

function TerminalDependenciesProbe({
    onDependencies,
}: {
    readonly onDependencies: (dependencies: TerminalBrowserDependencies) => void;
}) {
    onDependencies(useTerminalBrowserDependencies());
    return <output>Terminal child rendered</output>;
}

test("terminal dependency provider renders children with the exact injected adapters", () => {
    const dependencies = {
        createEmulator: () => {
            throw new Error("Unused terminal emulator fixture");
        },
        createSocketConnection: () => {
            throw new Error("Unused terminal socket fixture");
        },
    } satisfies TerminalBrowserDependencies;
    let observedDependencies: TerminalBrowserDependencies | undefined;

    render(
        <TerminalBrowserDependenciesProvider value={dependencies}>
            <TerminalDependenciesProbe
                onDependencies={(observed) => {
                    observedDependencies = observed;
                }}
            />
        </TerminalBrowserDependenciesProvider>
    );

    expect(screen.getByText("Terminal child rendered")).toBeVisible();
    expect(observedDependencies).toBe(dependencies);
});
