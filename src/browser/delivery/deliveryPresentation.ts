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

const actionReasonLabels: Readonly<
    Partial<Record<DeliveryActionCapabilityReason, string>>
> = {
    "action-active": "Another Delivery action is active.",
    "already-approved": "This exact pull request head is already approved.",
    "ambiguous-chain": "The pull request chain is ambiguous or incomplete.",
    "checkout-unsafe": "The production checkout is not ready and clean on main.",
    "credential-missing": "The dedicated approval credential is unavailable.",
    draft: "Draft pull requests cannot use this action.",
    "merge-conflict": "GitHub reports a merge conflict or blocked merge state.",
    "native-stacks-unavailable": "GitHub native stacks are currently unavailable.",
    "not-behind": "GitHub does not report this branch as behind its base.",
    "not-main-rooted": "The complete pull request chain is not rooted in main.",
    "preview-owned-by-other": "Another pull request owns the preview slot.",
    "review-required": "Approval is required before merge.",
    "self-review": "An author cannot approve their own pull request.",
    "source-unavailable": "Fresh authoritative Delivery state is unavailable.",
};

const actionSubjects: Readonly<
    Record<DeliveryPullRequestActionCapability["action"], string>
> = {
    "approve-review": "Approval",
    "create-stack": "Stack creation",
    merge: "Merge",
    "preview-start": "Preview",
    reject: "Rejection",
    "update-branch": "Branch update",
};

export function deliveryActionReason(
    action: DeliveryPullRequestActionCapability["action"],
    reason: DeliveryActionCapabilityReason | undefined
): string | undefined {
    if (reason === undefined) return undefined;
    if (reason === "checks-blocked") {
        return `${actionSubjects[action]} requires all latest CI checks to pass.`;
    }
    if (reason === "head-guard-unavailable") {
        return `${actionSubjects[action]} is unavailable because GitHub cannot atomically bind it to the reviewed pull request head or stack heads.`;
    }
    if (reason === "untrusted-author") {
        return `${actionSubjects[action]} is unavailable for this author.`;
    }
    return actionReasonLabels[reason];
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
