import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { PullRequests } from "./PullRequests";

const hooks = vi.hoisted(() => ({
    approve: vi.fn(),
    deploy: vi.fn(),
    productionCheckout: {
        branch: "master",
        expectedBranch: "master",
        expectedRoot: "/home/ubuntu/projects/mira-dashboard",
        head: "abc123",
        isClean: true,
        isProductionRoot: true,
        isSafeForDeploy: true,
        root: "/home/ubuntu/projects/mira-dashboard",
        upstream: "origin/master",
        worktreeRoot: "/home/ubuntu/projects/mira-dashboard-worktrees",
    },
    pullRequests: [
        {
            additions: 10,
            baseRefName: "master",
            body: "Adds tests",
            changedFiles: 2,
            deletions: 1,
            headRefName: "add-tests",
            mergeStateStatus: "CLEAN",
            mergeable: "MERGEABLE",
            number: 10,
            statusCheckRollup: [{ conclusion: "SUCCESS", name: "ci" }],
            title: "Add dashboard tests",
            updatedAt: "2026-05-11T00:00:00.000Z",
            url: "https://github.com/rajohan/Mira-Dashboard/pull/10",
        },
    ],
    refetch: vi.fn(),
    reject: vi.fn(),
    useApprovePullRequest: vi.fn(),
    useDeployDashboard: vi.fn(),
    useProductionCheckout: vi.fn(),
    usePullRequestDeployments: vi.fn(),
    usePullRequests: vi.fn(),
    useRejectPullRequest: vi.fn(),
}));

vi.mock("../hooks", () => ({
    useApprovePullRequest: hooks.useApprovePullRequest,
    useDeployDashboard: hooks.useDeployDashboard,
    useProductionCheckout: hooks.useProductionCheckout,
    usePullRequestDeployments: hooks.usePullRequestDeployments,
    usePullRequests: hooks.usePullRequests,
    useRejectPullRequest: hooks.useRejectPullRequest,
}));

vi.mock("../components/ui/ConfirmModal", () => ({
    ConfirmModal: ({
        confirmLabel,
        isOpen,
        message,
        onCancel,
        onConfirm,
        title,
    }: {
        confirmLabel: string;
        isOpen: boolean;
        message: string;
        onCancel: () => void;
        onConfirm: () => void;
        title: string;
    }) =>
        isOpen ? (
            <section data-testid="confirm-modal">
                <h2>{title}</h2>
                <p>{message}</p>
                <button type="button" onClick={onCancel}>
                    Cancel action
                </button>
                <button type="button" onClick={onConfirm}>
                    {confirmLabel}
                </button>
            </section>
        ) : null,
}));

function mockPullRequests(overrides = {}) {
    hooks.usePullRequests.mockReturnValue({
        data: hooks.pullRequests,
        error: null,
        isLoading: false,
        refetch: hooks.refetch,
    });
    hooks.usePullRequestDeployments.mockReturnValue({
        data: [
            {
                commit: "abc123",
                id: "deploy-1",
                note: "Service restart scheduled",
                status: "restart-scheduled",
                updatedAt: "2026-05-11T00:01:00.000Z",
            },
        ],
    });
    hooks.useProductionCheckout.mockReturnValue({
        data: hooks.productionCheckout,
        error: null,
    });
    hooks.useApprovePullRequest.mockReturnValue({
        isPending: false,
        mutateAsync: hooks.approve,
    });
    hooks.useRejectPullRequest.mockReturnValue({
        isPending: false,
        mutateAsync: hooks.reject,
    });
    hooks.useDeployDashboard.mockReturnValue({
        isPending: false,
        mutateAsync: hooks.deploy,
    });

    for (const [key, value] of Object.entries(overrides)) {
        if (key === "pullRequests") hooks.usePullRequests.mockReturnValue(value);
        if (key === "deployments") hooks.usePullRequestDeployments.mockReturnValue(value);
        if (key === "checkout") hooks.useProductionCheckout.mockReturnValue(value);
        if (key === "approve") hooks.useApprovePullRequest.mockReturnValue(value);
        if (key === "reject") hooks.useRejectPullRequest.mockReturnValue(value);
        if (key === "deploy") hooks.useDeployDashboard.mockReturnValue(value);
    }
}

describe("PullRequests page", () => {
    beforeEach(() => {
        hooks.approve.mockResolvedValue({
            cleanup: { message: "Worktree cleaned" },
            deployment: { note: "Deploy scheduled" },
            message: "PR merged",
        });
        hooks.deploy.mockResolvedValue({
            deployment: { note: "Master deploy scheduled" },
        });
        hooks.refetch.mockResolvedValue(Promise.resolve());
        hooks.reject.mockResolvedValue({
            cleanup: { message: "Review worktree left intact" },
            message: "PR rejected",
        });
        hooks.useApprovePullRequest.mockReset();
        hooks.useDeployDashboard.mockReset();
        hooks.useProductionCheckout.mockReset();
        hooks.usePullRequestDeployments.mockReset();
        hooks.usePullRequests.mockReset();
        hooks.useRejectPullRequest.mockReset();
        mockPullRequests();
    });

    it("renders pull request, checkout, and deployment summaries", () => {
        render(<PullRequests />);

        expect(screen.getByText("PR approvals")).toBeInTheDocument();
        expect(screen.getByText("Add dashboard tests")).toBeInTheDocument();
        expect(screen.getByText("Checks passed")).toBeInTheDocument();
        expect(screen.getByText("Ready to deploy")).toBeInTheDocument();
        expect(screen.getByText("restart-scheduled")).toBeInTheDocument();
    });

    it("shows loading, error retry, and empty states", async () => {
        const user = userEvent.setup();
        const { rerender } = render(<PullRequests />);

        mockPullRequests({
            pullRequests: {
                data: [],
                error: null,
                isLoading: true,
                refetch: hooks.refetch,
            },
        });
        rerender(<PullRequests />);
        expect(document.querySelector(".animate-spin")).toBeInTheDocument();

        mockPullRequests({
            pullRequests: {
                data: [],
                error: new Error("GitHub unavailable"),
                isLoading: false,
                refetch: hooks.refetch,
            },
        });
        rerender(<PullRequests />);
        expect(screen.getByText("GitHub unavailable")).toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "Retry" }));
        expect(hooks.refetch).toHaveBeenCalledTimes(1);

        mockPullRequests({
            pullRequests: {
                data: [],
                error: null,
                isLoading: false,
                refetch: hooks.refetch,
            },
        });
        rerender(<PullRequests />);
        expect(screen.getByText("No Mira-authored PRs waiting")).toBeInTheDocument();
    });

    it("confirms merge, merge deploy, reject, and master deploy actions", async () => {
        const user = userEvent.setup();

        render(<PullRequests />);

        await user.click(screen.getByRole("button", { name: "Merge only" }));
        expect(screen.getByTestId("confirm-modal")).toHaveTextContent("Merge PR #10");
        await user.click(
            screen.getByTestId("confirm-modal").querySelector("button:last-child")!
        );
        await waitFor(() => {
            expect(hooks.approve).toHaveBeenCalledWith({ number: 10, deploy: false });
        });
        expect(screen.getByText(/PR merged/)).toBeInTheDocument();
        expect(screen.getByText(/Worktree cleaned/)).toBeInTheDocument();

        await user.click(screen.getByRole("button", { name: "Merge + deploy" }));
        await user.click(
            screen.getByTestId("confirm-modal").querySelector("button:last-child")!
        );
        expect(hooks.approve).toHaveBeenCalledWith({ number: 10, deploy: true });
        expect(screen.getByText(/Deploy scheduled/)).toBeInTheDocument();

        await user.click(screen.getByRole("button", { name: "Reject" }));
        expect(screen.getByTestId("confirm-modal")).toHaveTextContent("Reject PR #10");
        await user.click(
            screen.getByTestId("confirm-modal").querySelector("button:last-child")!
        );
        expect(hooks.reject).toHaveBeenCalledWith({ number: 10 });
        expect(screen.getByText(/PR rejected/)).toBeInTheDocument();

        await user.click(screen.getByRole("button", { name: "Deploy latest master" }));
        expect(screen.getByTestId("confirm-modal")).toHaveTextContent(
            "Deploy latest master"
        );
        await user.click(
            screen.getByTestId("confirm-modal").querySelector("button:last-child")!
        );
        expect(hooks.deploy).toHaveBeenCalledTimes(1);
        expect(screen.getByText(/Master deploy scheduled/)).toBeInTheDocument();
    });

    it("blocks production actions when checkout is dirty", () => {
        mockPullRequests({
            checkout: {
                data: {
                    ...hooks.productionCheckout,
                    isClean: false,
                    isSafeForDeploy: false,
                },
                error: null,
            },
        });

        render(<PullRequests />);

        expect(screen.getByText("Dirty checkout")).toBeInTheDocument();
        expect(
            screen.getByRole("button", { name: "Deploy latest master" })
        ).toBeDisabled();
        expect(screen.getByRole("button", { name: "Merge only" })).toBeDisabled();
        expect(screen.getByRole("button", { name: "Merge + deploy" })).toBeDisabled();
        expect(screen.getByRole("button", { name: "Reject" })).not.toBeDisabled();
    });

    it("shows action errors from failed mutations", async () => {
        const user = userEvent.setup();
        hooks.approve.mockRejectedValueOnce(new Error("Merge failed"));

        render(<PullRequests />);

        await user.click(screen.getByRole("button", { name: "Merge only" }));
        await user.click(
            screen.getByTestId("confirm-modal").querySelector("button:last-child")!
        );
        expect(await screen.findByText("Merge failed")).toBeInTheDocument();
    });
});
