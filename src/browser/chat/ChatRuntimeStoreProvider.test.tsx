import { describe, expect, test } from "bun:test";

import { useStore } from "@tanstack/react-store";
import { useState } from "react";

import { useChatRuntimeStore } from "./chatRuntimeContextValue.ts";
import type { ChatRuntimeStore } from "./chatRuntimeStore.ts";
import { ChatRuntimeStoreProvider } from "./ChatRuntimeStoreProvider.tsx";

const { render, screen } = await import("@testing-library/react");
const userEventModule = await import("@testing-library/user-event");
const userEvent = userEventModule.default;
const sessionKey = "agent:main:main";

function RuntimeProbe({
    onStore,
}: {
    readonly onStore: (store: ChatRuntimeStore) => void;
}) {
    const store = useChatRuntimeStore();
    onStore(store);
    const count = useStore(
        store,
        (state) => Object.keys(state.sessions[sessionKey]?.optimisticSends ?? {}).length
    );
    return (
        <>
            <output aria-label="Optimistic sends">{count}</output>
            <button
                onClick={() =>
                    store.enqueue({
                        attachments: [],
                        clientRunId: "019fe63f-199b-7e5e-8bc9-8ff8112e7994",
                        createdAtMs: 1_800_000_000_000,
                        delivery: "sending",
                        idempotencyKey: "chat-runtime-provider-test",
                        sessionKey,
                        text: "Persist across route changes",
                    })
                }
                type="button"
            >
                Enqueue
            </button>
        </>
    );
}

describe("chat runtime store provider", () => {
    test("fails clearly when the provider is missing", () => {
        expect(() => render(<RuntimeProbe onStore={() => {}} />)).toThrow(
            "Chat runtime store provider is missing"
        );
    });

    test("survives route away and back within one authenticated application", async () => {
        const stores: ChatRuntimeStore[] = [];
        function RouteHarness() {
            const [chatRoute, setChatRoute] = useState(true);
            return (
                <ChatRuntimeStoreProvider>
                    <button onClick={() => setChatRoute((current) => !current)}>
                        Toggle route
                    </button>
                    {chatRoute ? (
                        <RuntimeProbe onStore={(store) => stores.push(store)} />
                    ) : (
                        <output>Other route</output>
                    )}
                </ChatRuntimeStoreProvider>
            );
        }
        const view = render(<RouteHarness />);
        const user = userEvent.setup();
        try {
            await user.click(screen.getByRole("button", { name: "Enqueue" }));
            expect(screen.getByLabelText("Optimistic sends")).toHaveTextContent("1");
            const firstStore = stores.at(-1);
            await user.click(screen.getByRole("button", { name: "Toggle route" }));
            expect(screen.getByText("Other route")).toBeVisible();
            await user.click(screen.getByRole("button", { name: "Toggle route" }));
            expect(screen.getByLabelText("Optimistic sends")).toHaveTextContent("1");
            expect(stores.at(-1)).toBe(firstStore);
        } finally {
            view.unmount();
        }
    });

    test("creates a clean store after the authenticated owner boundary unmounts", async () => {
        const stores: ChatRuntimeStore[] = [];
        function AuthOwnerHarness() {
            const [owner, setOwner] = useState("owner-a");
            return (
                <>
                    <button onClick={() => setOwner("owner-b")}>Change owner</button>
                    <div key={owner}>
                        <ChatRuntimeStoreProvider>
                            <RuntimeProbe onStore={(store) => stores.push(store)} />
                        </ChatRuntimeStoreProvider>
                    </div>
                </>
            );
        }
        const view = render(<AuthOwnerHarness />);
        const user = userEvent.setup();
        try {
            await user.click(screen.getByRole("button", { name: "Enqueue" }));
            const firstStore = stores.at(-1);
            expect(screen.getByLabelText("Optimistic sends")).toHaveTextContent("1");
            await user.click(screen.getByRole("button", { name: "Change owner" }));
            expect(screen.getByLabelText("Optimistic sends")).toHaveTextContent("0");
            expect(stores.at(-1)).not.toBe(firstStore);
        } finally {
            view.unmount();
        }
    });
});
