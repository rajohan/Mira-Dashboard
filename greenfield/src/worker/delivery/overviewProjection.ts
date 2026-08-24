import * as v from "valibot";

import {
    deliveryCheckoutCachePayloadSchema,
    deliveryOperationAuthoritySnapshotSchema,
    deliveryPullRequestsPayloadMaximumBytes,
    deliveryPreviewCachePayloadSchema,
    deliveryPullRequestsCachePayloadSchema,
    deliveryReleasesCachePayloadSchema,
    type DeliveryActionCapabilityReason,
    type DeliveryCheckout,
    type DeliveryCheckoutCachePayload,
    type DeliveryOperationAuthoritySnapshot,
    type DeliveryPreview,
    type DeliveryPreviewCachePayload,
    type DeliveryPullRequest,
    type DeliveryPullRequestActionCapability,
    type DeliveryPullRequestGroup,
    type DeliveryPullRequestGroupKind,
    type DeliveryPullRequestsCachePayload,
    type DeliveryReleases,
    type DeliveryReleasesCachePayload,
    type DeliveryReviewerCapability,
} from "../../contracts/delivery.ts";
import {
    deliveryGitHubBaseBranch,
    deliveryGitHubMiraLogin,
    deliveryGitHubReviewerLogin,
    type DeliveryGitHubPullRequest,
} from "../../contracts/deliveryGithub.ts";
import { utf8ByteLength } from "../../shared/encoding.ts";
import type { PreviewHostStatus } from "./previewHost.ts";
import {
    hasReviewerApproval,
    resolvePullRequestChecksState,
    resolvePullRequestReviewState,
} from "./pullRequestScope.ts";

const trustedPreviewAuthors = new Set<string>([
    deliveryGitHubMiraLogin,
    deliveryGitHubReviewerLogin,
]);

export type DeliveryReviewerAuthority =
    | Readonly<{ state: "available" }>
    | Readonly<{
          reason: "credential-missing" | "identity-mismatch" | "provider-unavailable";
          state: "unavailable";
      }>;

export interface DeliveryProductionAuthoritySnapshot {
    readonly actionActive: boolean;
    readonly releases: DeliveryReleases;
}

export interface DeliveryOverviewProjectionInput {
    readonly checkoutInspection: Readonly<{
        branch?: string;
        condition?: "dirty" | "off-main" | "ready" | "wrong-root";
        headSha: string;
        safe: boolean;
        upstream?: string;
    }>;
    readonly mainHeadSha: string;
    readonly observedAtMs: number;
    readonly previewControlsAvailable?: boolean;
    readonly previewStatus: PreviewHostStatus;
    readonly production: DeliveryProductionAuthoritySnapshot;
    readonly pullRequests: readonly DeliveryGitHubPullRequest[];
    readonly reviewer: DeliveryReviewerAuthority;
    readonly supportsNativeStacks: boolean;
}

interface GroupDraft {
    readonly kind: DeliveryPullRequestGroupKind;
    readonly members: readonly DeliveryGitHubPullRequest[];
}

function digest(value: unknown): string {
    return new Bun.CryptoHasher("sha256").update(JSON.stringify(value)).digest("hex");
}

function compareStrings(left: string, right: string): number {
    if (left < right) return -1;
    if (left > right) return 1;
    return 0;
}

function timestamp(value: string): number {
    const parsed = Date.parse(value);
    if (!Number.isSafeInteger(parsed) || parsed < 0) {
        throw new TypeError("Delivery overview authority is invalid");
    }
    return parsed;
}

function boundedTitle(value: string): string {
    let result = "";
    let count = 0;
    for (const character of value) {
        if (count >= 500) break;
        result += character;
        count += 1;
    }
    return result;
}

function nativeGroups(
    pullRequests: readonly DeliveryGitHubPullRequest[]
): readonly GroupDraft[] {
    const byStack = new Map<number, DeliveryGitHubPullRequest[]>();
    for (const pullRequest of pullRequests) {
        if (pullRequest.stack === undefined) continue;
        const members = byStack.get(pullRequest.stack.number) ?? [];
        members.push(pullRequest);
        byStack.set(pullRequest.stack.number, members);
    }
    return [...byStack.values()].map((members): GroupDraft => {
        const ordered = members.toSorted(
            (left, right) =>
                (left.stack?.position ?? Number.MAX_SAFE_INTEGER) -
                    (right.stack?.position ?? Number.MAX_SAFE_INTEGER) ||
                left.number - right.number
        );
        const first = ordered[0]?.stack;
        const valid =
            ordered.length > 0 &&
            first !== undefined &&
            first.baseRefName === deliveryGitHubBaseBranch &&
            ordered.every(
                (member, index) =>
                    member.stack !== undefined &&
                    member.stack.number === first.number &&
                    member.stack.size === first.size &&
                    member.stack.baseRefName === first.baseRefName &&
                    member.stack.position > 0 &&
                    (index === 0 ||
                        member.stack.position > ordered[index - 1]!.stack!.position)
            );
        return Object.freeze({
            kind: valid ? "native-stack" : "read-only-chain",
            members: Object.freeze(ordered),
        });
    });
}

function connectedComponents(
    pullRequests: readonly DeliveryGitHubPullRequest[]
): readonly (readonly DeliveryGitHubPullRequest[])[] {
    const remaining = new Set(pullRequests.map(({ number }) => number));
    const byNumber = new Map(pullRequests.map((item) => [item.number, item] as const));
    const components: DeliveryGitHubPullRequest[][] = [];
    while (remaining.size > 0) {
        const firstNumber = [...remaining].toSorted((left, right) => left - right)[0]!;
        const queue = [firstNumber];
        const component: DeliveryGitHubPullRequest[] = [];
        remaining.delete(firstNumber);
        while (queue.length > 0) {
            const current = byNumber.get(queue.shift()!);
            if (current === undefined) continue;
            component.push(current);
            for (const candidate of pullRequests) {
                if (
                    !remaining.has(candidate.number) ||
                    (candidate.baseRefName !== current.headRefName &&
                        current.baseRefName !== candidate.headRefName)
                ) {
                    continue;
                }
                remaining.delete(candidate.number);
                queue.push(candidate.number);
            }
        }
        components.push(component);
    }
    return Object.freeze(components.map((component) => Object.freeze(component)));
}

function orderedLinearChain(
    component: readonly DeliveryGitHubPullRequest[]
): readonly DeliveryGitHubPullRequest[] | undefined {
    const roots = component.filter(
        ({ baseRefName }) => baseRefName === deliveryGitHubBaseBranch
    );
    if (roots.length !== 1) return undefined;
    const ordered: DeliveryGitHubPullRequest[] = [];
    const seen = new Set<number>();
    let current: DeliveryGitHubPullRequest | undefined = roots[0];
    while (current !== undefined) {
        if (seen.has(current.number)) return undefined;
        ordered.push(current);
        seen.add(current.number);
        const children = component.filter(
            ({ baseRefName, number }) =>
                !seen.has(number) && baseRefName === current?.headRefName
        );
        if (children.length > 1) return undefined;
        current = children[0];
    }
    return ordered.length === component.length ? Object.freeze(ordered) : undefined;
}

function nonNativeGroups(
    pullRequests: readonly DeliveryGitHubPullRequest[]
): readonly GroupDraft[] {
    const crossRepository = pullRequests.filter(({ isCrossRepository }) =>
        Boolean(isCrossRepository)
    );
    const local = pullRequests.filter(({ isCrossRepository }) => !isCrossRepository);
    const result: GroupDraft[] = crossRepository.map((member) =>
        Object.freeze({
            kind:
                member.baseRefName === deliveryGitHubBaseBranch
                    ? "standalone-external"
                    : "read-only-chain",
            members: Object.freeze([member]),
        })
    );
    for (const component of connectedComponents(local)) {
        const ordered = orderedLinearChain(component);
        if (ordered === undefined) {
            result.push(
                Object.freeze({
                    kind: "read-only-chain",
                    members: Object.freeze(
                        [...component].toSorted(
                            (left, right) => left.number - right.number
                        )
                    ),
                })
            );
            continue;
        }
        if (ordered.length >= 2) {
            result.push(Object.freeze({ kind: "candidate-stack", members: ordered }));
            continue;
        }
        const member = ordered[0]!;
        result.push(
            Object.freeze({
                kind:
                    member.authorLogin === deliveryGitHubMiraLogin
                        ? "standalone-mira"
                        : "standalone-external",
                members: ordered,
            })
        );
    }
    return Object.freeze(result);
}

function groupDrafts(
    pullRequests: readonly DeliveryGitHubPullRequest[]
): readonly GroupDraft[] {
    const open = pullRequests.filter(({ state }) => state === "OPEN");
    const native = open.filter(({ stack }) => stack !== undefined);
    const nonNative = open.filter(({ stack }) => stack === undefined);
    return Object.freeze([...nativeGroups(native), ...nonNativeGroups(nonNative)]);
}

function unavailable(
    action: DeliveryPullRequestActionCapability["action"],
    actor: DeliveryPullRequestActionCapability["actor"],
    reason: DeliveryActionCapabilityReason,
    scope: DeliveryPullRequestActionCapability["scope"]
): DeliveryPullRequestActionCapability {
    return Object.freeze({ action, actor, available: false, reason, scope });
}

function available(
    action: DeliveryPullRequestActionCapability["action"],
    actor: DeliveryPullRequestActionCapability["actor"],
    scope: DeliveryPullRequestActionCapability["scope"]
): DeliveryPullRequestActionCapability {
    return Object.freeze({ action, actor, available: true, scope });
}

function readOnlyReason(group: GroupDraft): DeliveryActionCapabilityReason {
    return group.members.some(
        ({ baseRefName, stack }) =>
            (stack?.baseRefName ?? baseRefName) !== deliveryGitHubBaseBranch
    )
        ? "not-main-rooted"
        : "ambiguous-chain";
}

function mergeBlockReason(input: {
    readonly checkout: DeliveryCheckout;
    readonly group: GroupDraft;
    readonly production: DeliveryProductionAuthoritySnapshot;
    readonly scopeMembers: readonly DeliveryGitHubPullRequest[];
    readonly supportsNativeStacks: boolean;
}): DeliveryActionCapabilityReason | undefined {
    if (!input.supportsNativeStacks) return "native-stacks-unavailable";
    if (
        input.group.kind !== "native-stack" &&
        input.group.kind !== "standalone-external" &&
        input.group.kind !== "standalone-mira"
    ) {
        return input.group.kind === "read-only-chain"
            ? readOnlyReason(input.group)
            : "ambiguous-chain";
    }
    if (input.group.kind === "native-stack") return "head-guard-unavailable";
    if (input.production.actionActive) return "action-active";
    if (input.scopeMembers.some(({ isDraft }) => isDraft)) return "draft";
    if (
        input.scopeMembers.some(
            (pullRequest) => resolvePullRequestChecksState(pullRequest) !== "passed"
        )
    ) {
        return "checks-blocked";
    }
    if (input.scopeMembers.some((pullRequest) => !hasReviewerApproval(pullRequest))) {
        return "review-required";
    }
    if (
        input.scopeMembers.some(
            (pullRequest) =>
                ["CONFLICTING", "DIRTY"].includes(pullRequest.mergeable.toUpperCase()) ||
                ["BLOCKED", "DIRTY"].includes(pullRequest.mergeStateStatus.toUpperCase())
        )
    ) {
        return "merge-conflict";
    }
    if (!input.checkout.safeForDeploy) return "checkout-unsafe";
    return undefined;
}

function reviewBlockReason(
    group: GroupDraft,
    pullRequest: DeliveryGitHubPullRequest,
    reviewer: DeliveryReviewerAuthority,
    actionActive: boolean
): DeliveryActionCapabilityReason | undefined {
    if (actionActive) return "action-active";
    if (group.kind === "read-only-chain") return readOnlyReason(group);
    if (reviewer.state === "unavailable") {
        return reviewer.reason === "provider-unavailable"
            ? "source-unavailable"
            : "credential-missing";
    }
    if (pullRequest.authorLogin === deliveryGitHubReviewerLogin) return "self-review";
    if (pullRequest.isDraft) return "draft";
    if (hasReviewerApproval(pullRequest)) return "already-approved";
    return undefined;
}

function previewBlockReason(input: {
    readonly actionActive: boolean;
    readonly group: GroupDraft;
    readonly preview: DeliveryPreview;
    readonly pullRequest: DeliveryGitHubPullRequest;
    readonly scopeMembers: readonly DeliveryGitHubPullRequest[];
    readonly supportsNativeStacks: boolean;
}): DeliveryActionCapabilityReason | undefined {
    if (input.actionActive) return "action-active";
    if (!input.supportsNativeStacks) return "native-stacks-unavailable";
    if (
        input.group.kind === "read-only-chain" ||
        input.scopeMembers[0]?.baseRefName !== deliveryGitHubBaseBranch
    ) {
        return input.group.kind === "read-only-chain"
            ? readOnlyReason(input.group)
            : "not-main-rooted";
    }
    if (
        input.scopeMembers.some(
            ({ authorLogin }) =>
                authorLogin === undefined || !trustedPreviewAuthors.has(authorLogin)
        )
    ) {
        return "untrusted-author";
    }
    if (
        input.preview.status !== "stopped" &&
        input.preview.number !== undefined &&
        input.preview.number !== input.pullRequest.number
    ) {
        return "preview-owned-by-other";
    }
    if (!input.preview.controlsAvailable) return "source-unavailable";
    return undefined;
}

function nonOrdinaryReason(group: GroupDraft): DeliveryActionCapabilityReason {
    return group.kind === "read-only-chain" ? readOnlyReason(group) : "ambiguous-chain";
}

function rejectBlockReason(
    ordinary: boolean,
    group: GroupDraft,
    supportsNativeStacks: boolean,
    actionActive: boolean
): DeliveryActionCapabilityReason | undefined {
    if (actionActive) return "action-active";
    if (!supportsNativeStacks) return "native-stacks-unavailable";
    if (ordinary) return "head-guard-unavailable";
    return nonOrdinaryReason(group);
}

function updateBlockReason(
    ordinary: boolean,
    group: GroupDraft,
    pullRequest: DeliveryGitHubPullRequest,
    supportsNativeStacks: boolean,
    actionActive: boolean
): DeliveryActionCapabilityReason | undefined {
    if (actionActive) return "action-active";
    if (!supportsNativeStacks) return "native-stacks-unavailable";
    if (ordinary) {
        if (["CONFLICTING", "DIRTY"].includes(pullRequest.mergeable.toUpperCase())) {
            return "merge-conflict";
        }
        return pullRequest.mergeStateStatus.toUpperCase() === "BEHIND"
            ? undefined
            : "not-behind";
    }
    return nonOrdinaryReason(group);
}

function deploymentBlockReason(
    mergeReason: DeliveryActionCapabilityReason | undefined,
    production: DeliveryProductionAuthoritySnapshot
): DeliveryActionCapabilityReason | undefined {
    if (mergeReason !== undefined) return mergeReason;
    return production.releases.current === undefined ? "source-unavailable" : undefined;
}

function actions(input: {
    readonly checkout: DeliveryCheckout;
    readonly group: GroupDraft;
    readonly index: number;
    readonly preview: DeliveryPreview;
    readonly production: DeliveryProductionAuthoritySnapshot;
    readonly reviewer: DeliveryReviewerAuthority;
    readonly supportsNativeStacks: boolean;
}): readonly DeliveryPullRequestActionCapability[] {
    const pullRequest = input.group.members[input.index]!;
    const stackScopeMembers = input.group.members.slice(0, input.index + 1);
    const result: DeliveryPullRequestActionCapability[] = [];

    const reviewReason = reviewBlockReason(
        input.group,
        pullRequest,
        input.reviewer,
        input.production.actionActive
    );
    result.push(
        reviewReason === undefined
            ? available("approve-review", "raymond", "self")
            : unavailable("approve-review", "raymond", reviewReason, "self")
    );

    if (
        input.group.kind === "candidate-stack" &&
        input.index === input.group.members.length - 1
    ) {
        let createStack = unavailable(
            "create-stack",
            "mira",
            "head-guard-unavailable",
            "group"
        );
        if (input.production.actionActive) {
            createStack = unavailable("create-stack", "mira", "action-active", "group");
        } else if (!input.supportsNativeStacks) {
            createStack = unavailable(
                "create-stack",
                "mira",
                "native-stacks-unavailable",
                "group"
            );
        }
        result.push(createStack);
    }

    const mergeReason = mergeBlockReason({
        checkout: input.checkout,
        group: input.group,
        production: input.production,
        scopeMembers: stackScopeMembers,
        supportsNativeStacks: input.supportsNativeStacks,
    });
    result.push(
        mergeReason === undefined
            ? available("merge", "mira", "prefix")
            : unavailable("merge", "mira", mergeReason, "prefix")
    );

    const deployReason = deploymentBlockReason(mergeReason, input.production);
    result.push(
        deployReason === undefined
            ? available("merge-and-deploy", "mira", "prefix")
            : unavailable("merge-and-deploy", "mira", deployReason, "prefix")
    );

    const previewReason = previewBlockReason({
        actionActive: input.production.actionActive,
        group: input.group,
        preview: input.preview,
        pullRequest,
        scopeMembers: stackScopeMembers,
        supportsNativeStacks: input.supportsNativeStacks,
    });
    result.push(
        previewReason === undefined
            ? available("preview-start", "mira", "prefix")
            : unavailable("preview-start", "mira", previewReason, "prefix")
    );

    const ordinary =
        input.group.kind === "standalone-external" ||
        input.group.kind === "standalone-mira";
    const rejectReason = rejectBlockReason(
        ordinary,
        input.group,
        input.supportsNativeStacks,
        input.production.actionActive
    );
    result.push(
        rejectReason === undefined
            ? available("reject", "mira", "self")
            : unavailable("reject", "mira", rejectReason, "self")
    );

    const updateReason = updateBlockReason(
        ordinary,
        input.group,
        pullRequest,
        input.supportsNativeStacks,
        input.production.actionActive
    );
    result.push(
        updateReason === undefined
            ? available("update-branch", "mira", "self")
            : unavailable("update-branch", "mira", updateReason, "self")
    );

    return Object.freeze(
        result.toSorted((left, right) => compareStrings(left.action, right.action))
    );
}

function checkout(
    inspection: DeliveryOverviewProjectionInput["checkoutInspection"],
    mainHeadSha: string
): DeliveryCheckout {
    const condition = inspection.condition ?? (inspection.safe ? "ready" : "dirty");
    const safe = inspection.safe && condition === "ready";
    const branch = inspection.branch ?? "main";
    const upstream = inspection.upstream;
    return Object.freeze({
        branch,
        condition,
        expectedBranch: "main",
        headSha: inspection.headSha,
        remoteHeadSha: mainHeadSha,
        revision: digest({
            branch,
            condition,
            headSha: inspection.headSha,
            remoteHeadSha: mainHeadSha,
            safe,
            ...(upstream === undefined ? {} : { upstream }),
        }),
        safeForDeploy: safe,
        ...(upstream === undefined ? {} : { upstream }),
    });
}

function preview(
    input: Pick<
        DeliveryOverviewProjectionInput,
        "previewControlsAvailable" | "previewStatus"
    >
): DeliveryPreview {
    const status = input.previewStatus;
    const statusUrl = status.url;
    const revision = digest({
        controlsAvailable: input.previewControlsAvailable !== false,
        headSha: status.headSha,
        number: status.number,
        previewRevision: status.previewRevision,
        reason: status.reason,
        startedAtMs: status.startedAtMs,
        status: status.status,
        updatedAtMs: status.updatedAtMs,
        url: status.status === "running" ? statusUrl : undefined,
    });
    let reason: string | undefined;
    if (status.reason === "expired") reason = "Preview expired.";
    if (status.reason === "runtime-failed") reason = "Preview runtime failed.";
    if (status.reason === "startup-interrupted") {
        reason = "Preview startup was interrupted.";
    }
    return Object.freeze({
        controlsAvailable: input.previewControlsAvailable !== false,
        ...(status.headSha === undefined ? {} : { headSha: status.headSha }),
        ...(status.number === undefined ? {} : { number: status.number }),
        ...(reason === undefined ? {} : { reason }),
        revision,
        ...(status.startedAtMs === undefined ? {} : { startedAtMs: status.startedAtMs }),
        status: status.status,
        ...(status.title === undefined ? {} : { title: boundedTitle(status.title) }),
        updatedAtMs: status.updatedAtMs,
        ...(statusUrl === undefined || status.status !== "running"
            ? {}
            : { url: statusUrl }),
    });
}

function reviewerCapability(
    reviewer: DeliveryReviewerAuthority
): DeliveryReviewerCapability {
    const revision = digest(reviewer);
    return reviewer.state === "available"
        ? Object.freeze({ actor: "raymond", available: true, revision })
        : Object.freeze({
              actor: "raymond",
              available: false,
              reason: reviewer.reason,
              revision,
          });
}

function publicPullRequest(input: {
    readonly actions: readonly DeliveryPullRequestActionCapability[];
    readonly pullRequest: DeliveryGitHubPullRequest;
}): DeliveryPullRequest {
    const pullRequest = input.pullRequest;
    let mergeability: DeliveryPullRequest["mergeability"] = "unknown";
    if (pullRequest.mergeable.toUpperCase() === "MERGEABLE") {
        mergeability = "mergeable";
    } else if (pullRequest.mergeable.toUpperCase() === "CONFLICTING") {
        mergeability = "conflicting";
    }
    return {
        actions: [...input.actions],
        additions: pullRequest.additions,
        author: pullRequest.authorLogin ?? "ghost",
        baseRef: pullRequest.baseRefName,
        ...(pullRequest.body === "" ? {} : { body: pullRequest.body }),
        changedFiles: pullRequest.changedFiles,
        checksState: resolvePullRequestChecksState(pullRequest),
        createdAtMs: timestamp(pullRequest.createdAt),
        deletions: pullRequest.deletions,
        headRef: pullRequest.headRefName,
        headSha: pullRequest.headSha,
        isCrossRepository: pullRequest.isCrossRepository,
        isDraft: pullRequest.isDraft,
        mergeState: pullRequest.mergeStateStatus,
        mergeability,
        number: pullRequest.number,
        reviewState: resolvePullRequestReviewState(pullRequest),
        title: boundedTitle(pullRequest.title),
        updatedAtMs: timestamp(pullRequest.updatedAt),
        url: pullRequest.url,
    };
}

function publicGroups(input: {
    readonly checkout: DeliveryCheckout;
    readonly drafts: readonly GroupDraft[];
    readonly preview: DeliveryPreview;
    readonly production: DeliveryProductionAuthoritySnapshot;
    readonly reviewer: DeliveryReviewerAuthority;
    readonly supportsNativeStacks: boolean;
}): DeliveryPullRequestGroup[] {
    return input.drafts
        .map((group): DeliveryPullRequestGroup => ({
            id: digest({
                kind: group.kind,
                members: group.members.map(({ headSha, number }) => ({
                    headSha,
                    number,
                })),
            }),
            kind: group.kind,
            members: group.members.map((pullRequest, index) =>
                publicPullRequest({
                    actions: actions({
                        checkout: input.checkout,
                        group,
                        index,
                        preview: input.preview,
                        production: input.production,
                        reviewer: input.reviewer,
                        supportsNativeStacks: input.supportsNativeStacks,
                    }),
                    pullRequest,
                })
            ),
        }))
        .toSorted((left, right) => compareStrings(left.id, right.id));
}

function omitBodiesToFit(
    groups: readonly DeliveryPullRequestGroup[],
    payload: object,
    maximumBytes: number
): void {
    let serializedBytes = utf8ByteLength(JSON.stringify(payload));
    if (serializedBytes <= maximumBytes) return;
    const candidates = groups
        .flatMap(({ members }) => members)
        .flatMap((pullRequest) => {
            if (pullRequest.body === undefined) return [];
            return [
                {
                    bytes: utf8ByteLength(`,"body":${JSON.stringify(pullRequest.body)}`),
                    pullRequest,
                },
            ];
        })
        .toSorted(
            (left, right) =>
                right.bytes - left.bytes ||
                left.pullRequest.number - right.pullRequest.number
        );
    for (const { bytes, pullRequest } of candidates) {
        delete pullRequest.body;
        serializedBytes -= bytes;
        if (serializedBytes <= maximumBytes) return;
    }
}

/**
 * Projects the independently retained exact production checkout authority.
 * @param input Validated local checkout and authenticated remote-main authority.
 * @returns The bounded checkout cache section.
 */
export function projectDeliveryCheckout(
    input: Pick<
        DeliveryOverviewProjectionInput,
        "checkoutInspection" | "mainHeadSha" | "observedAtMs"
    >
): DeliveryCheckoutCachePayload {
    const projected = checkout(input.checkoutInspection, input.mainHeadSha);
    return v.parse(deliveryCheckoutCachePayloadSchema, {
        checkout: projected,
        observedAtMs: input.observedAtMs,
        sourceRevision: digest(projected),
    });
}

/**
 * Projects the independently retained managed-preview authority.
 * @param input Validated preview status and global mutation state.
 * @returns The bounded preview cache section.
 */
export function projectDeliveryPreview(
    input: Pick<
        DeliveryOverviewProjectionInput,
        "observedAtMs" | "previewControlsAvailable" | "previewStatus"
    > & { readonly actionActive: boolean }
): DeliveryPreviewCachePayload {
    const projected = preview(input);
    return v.parse(deliveryPreviewCachePayloadSchema, {
        actionActive: input.actionActive,
        observedAtMs: input.observedAtMs,
        preview: projected,
        sourceRevision: digest({ actionActive: input.actionActive, preview: projected }),
    });
}

/**
 * Projects the independently retained production release/rollback authority.
 * @param input Immutable activation slots and global mutation state.
 * @returns The bounded releases cache section.
 */
export function projectDeliveryReleases(
    input: Pick<DeliveryOverviewProjectionInput, "observedAtMs" | "production">
): DeliveryReleasesCachePayload {
    return v.parse(deliveryReleasesCachePayloadSchema, {
        actionActive: input.production.actionActive,
        observedAtMs: input.observedAtMs,
        releases: input.production.releases,
        sourceRevision: digest({
            actionActive: input.production.actionActive,
            releases: input.production.releases,
        }),
    });
}

/**
 * Projects the GitHub/reviewer inventory while dependency state only gates actions.
 * @param input Exact GitHub, checkout, preview, reviewer, and release authority.
 * @returns The bounded pull-request cache section.
 */
export function projectDeliveryPullRequests(
    input: DeliveryOverviewProjectionInput
): DeliveryPullRequestsCachePayload {
    if (!Number.isSafeInteger(input.observedAtMs) || input.observedAtMs < 0) {
        throw new TypeError("Delivery overview authority is invalid");
    }
    const projectedCheckout = checkout(input.checkoutInspection, input.mainHeadSha);
    const projectedPreview = preview(input);
    const drafts = groupDrafts(input.pullRequests);
    const projectedReviewer = reviewerCapability(input.reviewer);
    const groups = publicGroups({
        checkout: projectedCheckout,
        drafts,
        preview: projectedPreview,
        production: input.production,
        reviewer: input.reviewer,
        supportsNativeStacks: input.supportsNativeStacks,
    });
    const payload: DeliveryPullRequestsCachePayload = {
        groups,
        observedAtMs: input.observedAtMs,
        reviewerCapability: projectedReviewer,
        sourceRevision: digest({
            groups: groups.map(({ id, kind, members }) => ({
                id,
                kind,
                members: members.map(({ body: _body, ...member }) => member),
            })),
            reviewerCapability: projectedReviewer,
            supportsNativeStacks: input.supportsNativeStacks,
        }),
    };
    omitBodiesToFit(groups, payload, deliveryPullRequestsPayloadMaximumBytes);
    return v.parse(deliveryPullRequestsCachePayloadSchema, payload);
}

/**
 * Projects one ephemeral, server-authoritative and secret-free operation snapshot.
 * @returns Strict operation authority assembled from independently persisted sections.
 */
export function projectDeliveryOperationAuthority(
    input: DeliveryOverviewProjectionInput
): DeliveryOperationAuthoritySnapshot {
    if (!Number.isSafeInteger(input.observedAtMs) || input.observedAtMs < 0) {
        throw new TypeError("Delivery overview authority is invalid");
    }
    const checkoutSection = projectDeliveryCheckout(input);
    const previewSection = projectDeliveryPreview({
        ...input,
        actionActive: input.production.actionActive,
    });
    const releasesSection = projectDeliveryReleases(input);
    const pullRequestsSection = projectDeliveryPullRequests(input);
    const payload: DeliveryOperationAuthoritySnapshot = {
        checkout: checkoutSection.checkout,
        observedAtMs: input.observedAtMs,
        preview: previewSection.preview,
        pullRequestGroups: pullRequestsSection.groups,
        releases: releasesSection.releases,
        reviewerCapability: pullRequestsSection.reviewerCapability,
        sourceRevision: digest({
            checkout: checkoutSection.sourceRevision,
            preview: previewSection.sourceRevision,
            pullRequests: pullRequestsSection.sourceRevision,
            releases: releasesSection.sourceRevision,
        }),
    };
    omitBodiesToFit(
        payload.pullRequestGroups,
        payload,
        deliveryPullRequestsPayloadMaximumBytes
    );
    return v.parse(deliveryOperationAuthoritySnapshotSchema, payload);
}
