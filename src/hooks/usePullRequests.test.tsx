import { renderHook, waitFor } from "@testing-library/react";
import { act } from "react";
import { describe, expect, it, vi } from "vitest";

import { createQueryWrapper, createTestQueryClient } from "../test/queryClient";
import {
    pullRequestKeys,
    useApprovePullRequest,
    useDeployDashboard,
    useProductionCheckout,
    usePullRequestDeployments,
    usePullRequests,
    useRejectPullRequest,
} from "./usePullRequests";

describe("pull request hooks", () => {
    it("fetches PR, deployment and checkout queries", async () => {
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({ pullRequests: [{ number: 10, title: "Tests" }] }),
            })
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({ deployments: [{ id: "deploy-1" }] }),
            })
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({ checkout: { branch: "main" } }),
            });
        vi.stubGlobal("fetch", fetchMock);
        const wrapper = createQueryWrapper();

        const { result: prs } = renderHook(() => usePullRequests(), { wrapper });
        await waitFor(() => expect(prs.current.data?.[0]?.number).toBe(10));

        const { result: deployments } = renderHook(() => usePullRequestDeployments(), {
            wrapper,
        });
        await waitFor(() => expect(deployments.current.data?.[0]?.id).toBe("deploy-1"));

        const { result: checkout } = renderHook(() => useProductionCheckout(), {
            wrapper,
        });
        await waitFor(() => expect(checkout.current.data?.branch).toBe("main"));

        expect(fetchMock).toHaveBeenNthCalledWith(
            1,
            "/api/pull-requests",
            expect.any(Object)
        );
        expect(fetchMock).toHaveBeenNthCalledWith(
            2,
            "/api/pull-requests/deployments",
            expect.any(Object)
        );
        expect(fetchMock).toHaveBeenNthCalledWith(
            3,
            "/api/pull-requests/production-checkout",
            expect.any(Object)
        );
    });

    it("posts PR actions and invalidates related queries", async () => {
        const fetchMock = vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({ ok: true }),
        });
        vi.stubGlobal("fetch", fetchMock);
        const queryClient = createTestQueryClient();
        const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
        const wrapper = createQueryWrapper(queryClient);

        const { result: approve } = renderHook(() => useApprovePullRequest(), {
            wrapper,
        });
        const { result: reject } = renderHook(() => useRejectPullRequest(), { wrapper });
        const { result: deploy } = renderHook(() => useDeployDashboard(), { wrapper });

        await act(async () => {
            await approve.current.mutateAsync({ number: 10, deploy: true });
            await reject.current.mutateAsync({ number: 10, comment: "Needs work" });
            await deploy.current.mutateAsync();
        });

        expect(fetchMock).toHaveBeenNthCalledWith(
            1,
            "/api/pull-requests/10/approve",
            expect.objectContaining({
                method: "POST",
                body: JSON.stringify({ deploy: true }),
            })
        );
        expect(fetchMock).toHaveBeenNthCalledWith(
            2,
            "/api/pull-requests/10/reject",
            expect.objectContaining({ body: JSON.stringify({ comment: "Needs work" }) })
        );
        expect(fetchMock).toHaveBeenNthCalledWith(
            3,
            "/api/pull-requests/deploy",
            expect.objectContaining({ method: "POST" })
        );
        expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: pullRequestKeys.list() });
        expect(invalidateSpy).toHaveBeenCalledWith({
            queryKey: pullRequestKeys.deployments(),
        });
        expect(invalidateSpy).toHaveBeenCalledWith({
            queryKey: pullRequestKeys.productionCheckout(),
        });
    });
});
