import type {
    DeliveryCheckout,
    DeliveryDeployment,
    DeliveryPullRequest,
    DeliveryPullRequestActionCapability,
    DeliveryPullRequestGroup,
} from "../../contracts/delivery.ts";
import {
    classifyDashboardBrowserFailure,
    isDashboardOperationOutcomeUnknown,
} from "../api/trpcError.ts";

type DeliveryActionCapabilityReason = NonNullable<
    DeliveryPullRequestActionCapability["reason"]
>;
type DeliveryChecksState = DeliveryPullRequest["checksState"];
type DeliveryReviewState = DeliveryPullRequest["reviewState"];
type DeliveryCheckoutCondition = DeliveryCheckout["condition"];
type DeliveryPullRequestGroupKind = DeliveryPullRequestGroup["kind"];
type DeliveryDeploymentOperation = DeliveryDeployment["operation"];

const actionReasonLabels: Readonly<Record<DeliveryActionCapabilityReason, string>> = {
    "action-active": "Another Delivery action is active.",
    "already-approved": "Raymond has already approved this exact pull request head.",
    "ambiguous-chain": "The pull request chain is ambiguous or incomplete.",
    "checkout-unsafe": "The production checkout is not ready and clean on main.",
    "checks-blocked": "All latest CI checks must pass before this action.",
    "credential-missing": "The dedicated Raymond approval credential is unavailable.",
    draft: "Draft pull requests cannot use this action.",
    "head-guard-unavailable":
        "GitHub cannot atomically bind this action to the reviewed pull request head or stack heads.",
    "merge-conflict": "GitHub reports a merge conflict or blocked merge state.",
    "native-stacks-unavailable": "GitHub native stacks are currently unavailable.",
    "not-behind": "GitHub does not report this branch as behind its base.",
    "not-main-rooted": "The complete pull request chain is not rooted in main.",
    "preview-owned-by-other": "Another pull request owns the preview slot.",
    "review-required": "Raymond approval is required before merge.",
    "self-review": "Raymond cannot approve his own pull request.",
    "source-unavailable": "Fresh authoritative Delivery state is unavailable.",
    "untrusted-author": "This author is not permitted to run preview code.",
};

export function deliveryActionReason(
    reason: DeliveryActionCapabilityReason | undefined
): string | undefined {
    return reason === undefined ? undefined : actionReasonLabels[reason];
}

export function deliveryFailureMessage(error: unknown): string {
    if (isDashboardOperationOutcomeUnknown(error)) {
        return "The queue outcome could not be confirmed. Check Dashboard jobs before retrying this same request.";
    }
    switch (classifyDashboardBrowserFailure(error)) {
        case "conflict": {
            return "Delivery state changed. Reopen the confirmation from fresh data.";
        }
        case "forbidden": {
            return "This session or GitHub identity is not permitted to perform the action.";
        }
        case "not-found": {
            return "The exact pull request, release, preview, or job target no longer exists.";
        }
        case "rate-limited": {
            return "GitHub rate limits are temporarily preventing this action. Try again later.";
        }
        case "step-up-required": {
            return "Verify your identity again before queueing this Delivery action.";
        }
        case "mfa-enrollment-required": {
            return "Multi-factor authentication must be enrolled before Delivery actions.";
        }
        case "unavailable": {
            return "Delivery is temporarily unavailable. Existing retained data remains read-only.";
        }
        default: {
            return "The Delivery request could not be completed safely. Try again from fresh state.";
        }
    }
}

export const deliveryPullRequestGroupLabels: Readonly<
    Record<DeliveryPullRequestGroupKind, string>
> = {
    "candidate-stack": "Stack candidates",
    "native-stack": "GitHub stacks",
    "read-only-chain": "Read-only chains",
    "standalone-external": "Dependency and external pull requests",
    "standalone-mira": "Mira pull requests",
};

export const deliveryChecksLabels: Readonly<Record<DeliveryChecksState, string>> = {
    attention: "Checks need attention",
    failed: "Checks failed",
    none: "No CI checks",
    passed: "Checks passed",
    running: "Checks running",
    skipped: "Checks skipped",
    unknown: "Checks unknown",
};

export const deliveryReviewLabels: Readonly<Record<DeliveryReviewState, string>> = {
    approved: "Review approved",
    "changes-requested": "Changes requested",
    pending: "Review pending",
    required: "Review required",
    unknown: "Review unknown",
};

export const deliveryCheckoutLabels: Readonly<Record<DeliveryCheckoutCondition, string>> =
    {
        dirty: "Dirty checkout",
        "off-main": "Checkout is off main",
        ready: "Ready to deploy",
        unavailable: "Checkout unavailable",
        "wrong-root": "Unexpected checkout root",
    };

export const deliveryDeploymentOperationLabels: Readonly<
    Record<DeliveryDeploymentOperation, string>
> = {
    deploy: "Deploy main",
    "rollback-release": "Rollback release",
};
