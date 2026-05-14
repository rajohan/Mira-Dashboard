import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Session } from "../../../types/session";
import { SessionDetails } from "./SessionDetails";

const hooks = vi.hoisted(() => ({
    fetchNextPage: vi.fn(),
    refetch: vi.fn(),
    useSessionHistory: vi.fn(),
}));

vi.mock("../../../hooks/useSessions", () => ({
    useSessionHistory: hooks.useSessionHistory,
}));

const session: Session = {
    agentType: "main",
    channel: "webchat",
    createdAt: "2026-05-10T09:00:00.000Z",
    displayLabel: "Main session",
    displayName: "Main session",
    hookName: "",
    id: "main",
    key: "agent:main:main",
    kind: "direct",
    label: "main",
    maxTokens: 100_000,
    model: "codex",
    tokenCount: 25_000,
    type: "main",
    updatedAt: Date.now() - 60_000,
};

beforeEach(() => {
    hooks.fetchNextPage.mockReset();
    hooks.refetch.mockReset();
    hooks.useSessionHistory.mockReturnValue({
        data: {
            pages: [
                {
                    messages: [
                        {
                            content: "Hello Mira",
                            role: "user",
                            timestamp: "2026-05-10T10:00:00.000Z",
                        },
                        {
                            content: "Working on it",
                            role: "assistant",
                            timestamp: "2026-05-10T10:01:00.000Z",
                        },
                    ],
                },
                { messages: null },
            ],
        },
        error: null,
        fetchNextPage: hooks.fetchNextPage,
        hasNextPage: true,
        isFetchingNextPage: false,
        isLoading: false,
        refetch: hooks.refetch,
    });
});

describe("SessionDetails", () => {
    it("renders nothing without a selected session", () => {
        const { container } = render(
            <SessionDetails
                session={null}
                onClose={vi.fn()}
                onDelete={vi.fn()}
                onCompact={vi.fn()}
                onReset={vi.fn()}
            />
        );

        expect(container).toBeEmptyDOMElement();
    });

    it("renders session history and invokes actions", async () => {
        const user = userEvent.setup();
        const onClose = vi.fn();
        const onCompact = vi.fn();
        const onReset = vi.fn();
        const onDelete = vi.fn();

        render(
            <SessionDetails
                session={session}
                onClose={onClose}
                onDelete={onDelete}
                onCompact={onCompact}
                onReset={onReset}
            />
        );

        expect(screen.getByRole("dialog")).toBeInTheDocument();
        expect(screen.getByText("Main session")).toBeInTheDocument();
        expect(screen.getByText("codex")).toBeInTheDocument();
        expect(screen.getByText("Hello Mira")).toBeInTheDocument();
        expect(screen.getByText("Working on it")).toBeInTheDocument();

        fireEvent.click(screen.getAllByRole("button")[2]);
        expect(hooks.refetch).toHaveBeenCalledTimes(1);

        fireEvent.click(screen.getByRole("button", { name: "Load more" }));
        expect(hooks.fetchNextPage).toHaveBeenCalledTimes(1);

        fireEvent.click(screen.getAllByRole("button")[0]);
        await user.click(await screen.findByRole("menuitem", { name: "Compact" }));
        fireEvent.click(screen.getAllByRole("button")[0]);
        await user.click(await screen.findByRole("menuitem", { name: "Reset" }));
        fireEvent.click(screen.getAllByRole("button")[0]);
        await user.click(await screen.findByRole("menuitem", { name: "Delete" }));

        expect(onCompact).toHaveBeenCalledTimes(1);
        expect(onReset).toHaveBeenCalledTimes(1);
        expect(onDelete).toHaveBeenCalledTimes(1);

        fireEvent.click(screen.getAllByRole("button")[1]);
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("renders loading, error, empty, and fetching-more states", async () => {
        const { rerender } = render(
            <SessionDetails
                session={session}
                onClose={vi.fn()}
                onDelete={vi.fn()}
                onCompact={vi.fn()}
                onReset={vi.fn()}
            />
        );

        hooks.useSessionHistory.mockReturnValue({
            data: null,
            error: null,
            fetchNextPage: hooks.fetchNextPage,
            hasNextPage: false,
            isFetchingNextPage: false,
            isLoading: true,
            refetch: hooks.refetch,
        });
        rerender(
            <SessionDetails
                session={session}
                onClose={vi.fn()}
                onDelete={vi.fn()}
                onCompact={vi.fn()}
                onReset={vi.fn()}
            />
        );
        expect(await screen.findByText("Loading history...")).toBeInTheDocument();

        hooks.useSessionHistory.mockReturnValue({
            data: null,
            error: new Error("history unavailable"),
            fetchNextPage: hooks.fetchNextPage,
            hasNextPage: false,
            isFetchingNextPage: false,
            isLoading: false,
            refetch: hooks.refetch,
        });
        rerender(
            <SessionDetails
                session={session}
                onClose={vi.fn()}
                onDelete={vi.fn()}
                onCompact={vi.fn()}
                onReset={vi.fn()}
            />
        );
        expect(await screen.findByText("history unavailable")).toBeInTheDocument();

        hooks.useSessionHistory.mockReturnValue({
            data: { pages: [{ messages: [] }] },
            error: null,
            fetchNextPage: hooks.fetchNextPage,
            hasNextPage: false,
            isFetchingNextPage: false,
            isLoading: false,
            refetch: hooks.refetch,
        });
        rerender(
            <SessionDetails
                session={session}
                onClose={vi.fn()}
                onDelete={vi.fn()}
                onCompact={vi.fn()}
                onReset={vi.fn()}
            />
        );
        expect(
            await screen.findByText("No message history available")
        ).toBeInTheDocument();

        hooks.useSessionHistory.mockReturnValue({
            data: { pages: [{ messages: [{ content: "older", role: "user" }] }] },
            error: null,
            fetchNextPage: hooks.fetchNextPage,
            hasNextPage: true,
            isFetchingNextPage: true,
            isLoading: false,
            refetch: hooks.refetch,
        });
        rerender(
            <SessionDetails
                session={session}
                onClose={vi.fn()}
                onDelete={vi.fn()}
                onCompact={vi.fn()}
                onReset={vi.fn()}
            />
        );
        expect(await screen.findByText("older")).toBeInTheDocument();
    });
});
