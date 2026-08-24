import * as v from "valibot";

import {
    deliveryGitHubExpectedHeadSchema,
    deliveryGitHubReviewerLogin,
    type DeliveryGitHubExpectedHead,
    type DeliveryGitHubPullRequestReadPort,
    type DeliveryGitHubReviewApprovalPort,
} from "../../contracts/deliveryGithub.ts";
import {
    DeliveryGitHubError,
    type DeliveryGitHubHttpTransport,
} from "./githubHttpTransport.ts";
import {
    canReviewerApprove,
    hasReviewerApproval,
    resolvePullRequestScope,
} from "./pullRequestScope.ts";

const reviewResultSchema = v.object({
    commit_id: v.string(),
    state: v.string(),
    user: v.object({ login: v.string() }),
});

export interface DeliveryGitHubReviewerPortOptions {
    readonly readPort: DeliveryGitHubPullRequestReadPort;
    readonly reviewerTransport: DeliveryGitHubHttpTransport;
}

function fail(
    reason: "authentication" | "conflict" | "invalid-input" | "unknown-outcome"
): never {
    throw new DeliveryGitHubError(reason);
}

/**
 * Creates the Raymond-only review mutation port; it cannot perform other writes.
 * @returns Review-only mutation port.
 */
export function createDeliveryGitHubReviewerPort(
    options: DeliveryGitHubReviewerPortOptions
): DeliveryGitHubReviewApprovalPort {
    if (options.reviewerTransport.actor !== deliveryGitHubReviewerLogin) {
        fail("authentication");
    }
    return Object.freeze({
        approveReview: async (
            input: DeliveryGitHubExpectedHead,
            signal?: AbortSignal
        ) => {
            let expected: DeliveryGitHubExpectedHead;
            try {
                expected = v.parse(deliveryGitHubExpectedHeadSchema, input);
            } catch {
                fail("invalid-input");
            }
            const pullRequest = await options.readPort.getPullRequest(
                expected.number,
                signal
            );
            const pullRequests = await options.readPort.listOpenPullRequests(signal);
            const scope = resolvePullRequestScope(expected.number, [
                ...pullRequests.filter(({ number }) => number !== expected.number),
                pullRequest,
            ]);
            if (
                pullRequest.number !== expected.number ||
                pullRequest.headSha !== expected.headSha ||
                pullRequest.state !== "OPEN" ||
                scope === undefined ||
                !canReviewerApprove(pullRequest)
            ) {
                fail("conflict");
            }
            let review: v.InferOutput<typeof reviewResultSchema>;
            try {
                review = v.parse(
                    reviewResultSchema,
                    await options.reviewerTransport.requestJson(
                        {
                            expectedHeadSha: expected.headSha,
                            kind: "pull-request-review-approve",
                            pullRequestNumber: expected.number,
                        },
                        signal
                    )
                );
            } catch (error) {
                if (error instanceof DeliveryGitHubError) throw error;
                fail("unknown-outcome");
            }
            if (
                review.commit_id !== expected.headSha ||
                review.user.login !== deliveryGitHubReviewerLogin ||
                review.state.toUpperCase() !== "APPROVED"
            ) {
                fail("unknown-outcome");
            }
            const current = await options.readPort
                .getPullRequest(expected.number, signal)
                .catch(() => fail("unknown-outcome"));
            if (current.headSha !== expected.headSha || !hasReviewerApproval(current)) {
                fail("unknown-outcome");
            }
            return Object.freeze({ outcome: "completed" });
        },
    });
}
