import { GitBranch, Rocket, RotateCcw } from "lucide-react";

import type {
    DeliveryCheckout,
    DeliveryRelease,
    DeliveryReleases,
} from "../../contracts/delivery.ts";
import { formatDashboardDateTime } from "../lib/formatDateTime.ts";
import { Badge } from "../ui/Badge.tsx";
import { Button } from "../ui/Button.tsx";
import { Card } from "../ui/Card.tsx";
import { ExternalLink } from "../ui/ExternalLink.tsx";
import { Heading } from "../ui/Heading.tsx";
import { Icon } from "../ui/Icon.tsx";
import { Text } from "../ui/Text.tsx";
import { deliveryCheckoutLabels } from "./deliveryPresentation.ts";

interface ProductionCheckoutCardProps {
    readonly checkout: DeliveryCheckout;
}

/** @returns Sanitized production Git status without roots or dirty filenames. */
export function ProductionCheckoutCard({ checkout }: ProductionCheckoutCardProps) {
    return (
        <Card aria-labelledby="delivery-checkout-card-heading">
            <div className="flex flex-wrap items-center justify-between gap-3">
                <Heading id="delivery-checkout-card-heading" level={3}>
                    Main checkout
                </Heading>
                <Badge variant={checkout.safeForDeploy ? "success" : "warning"}>
                    {deliveryCheckoutLabels[checkout.condition]}
                </Badge>
            </div>
            <dl className="mt-4 grid gap-3 sm:grid-cols-2">
                <div>
                    <dt className="text-primary-400 text-sm">Branch</dt>
                    <dd className="text-primary-100">
                        {checkout.branch} · expected {checkout.expectedBranch}
                    </dd>
                </div>
                <div>
                    <dt className="text-primary-400 text-sm">Upstream</dt>
                    <dd className="text-primary-100">
                        {checkout.upstream ?? "Unavailable"}
                    </dd>
                </div>
                <div className="sm:col-span-2">
                    <dt className="text-primary-400 text-sm">Exact HEAD</dt>
                    <dd className="text-primary-100 font-mono text-xs wrap-anywhere">
                        {checkout.headSha}
                    </dd>
                </div>
            </dl>
        </Card>
    );
}

function ReleaseSlot({
    label,
    release,
}: {
    readonly label: string;
    readonly release?: DeliveryRelease;
}) {
    return (
        <Card aria-label={label}>
            <Heading level={3}>{label}</Heading>
            {release === undefined ? (
                <Text className="mt-3" tone="muted">
                    No release available
                </Text>
            ) : (
                <div className="mt-3 space-y-2">
                    <ExternalLink href={release.commitUrl}>
                        {release.commitTitle}
                    </ExternalLink>
                    <code className="text-primary-400 block text-xs wrap-anywhere">
                        {release.releaseId}
                    </code>
                    <Text size="sm" tone="muted">
                        Built {formatDashboardDateTime(release.builtAtMs)} · schema target{" "}
                        {release.schemaTarget}
                    </Text>
                </div>
            )}
        </Card>
    );
}

interface ProductionReleasesPanelProps {
    readonly busy: boolean;
    readonly deployAvailable: boolean;
    readonly deployReason?: string;
    readonly onDeploy: () => void;
    readonly onRollback: () => void;
    readonly releases: DeliveryReleases;
    readonly releasesFresh: boolean;
}

const rollbackReasons = {
    "action-active": "Another production Delivery action is active.",
    incompatible: "The previous release is not compatible with paired rollback.",
    "no-previous-release": "No previous release and database snapshot are available.",
    "source-unavailable": "Authoritative activation state is unavailable.",
} as const;

function rollbackUnavailableReason(releases: DeliveryReleases, fresh: boolean) {
    if (!releases.rollback.available) return rollbackReasons[releases.rollback.reason];
    return fresh ? undefined : "A fresh activation revision is required.";
}

/** @returns Immutable current/previous release slots and exact deploy/rollback controls. */
export function ProductionReleasesPanel({
    busy,
    deployAvailable,
    deployReason,
    onDeploy,
    onRollback,
    releases,
    releasesFresh,
}: ProductionReleasesPanelProps) {
    const rollbackAvailable = releasesFresh && releases.rollback.available;
    const rollbackReason = rollbackUnavailableReason(releases, releasesFresh);
    return (
        <div className="space-y-4">
            <div className="grid gap-4 lg:grid-cols-2">
                <ReleaseSlot label="Active release" release={releases.current} />
                <ReleaseSlot
                    label="Previous / rollback target"
                    release={releases.previous}
                />
            </div>
            <Card aria-labelledby="delivery-production-actions-heading">
                <Heading id="delivery-production-actions-heading" level={3}>
                    Production actions
                </Heading>
                <Text className="mt-1" tone="muted">
                    Every operation is queued as a durable Job and revalidates exact main,
                    activation, release, runtime, and database snapshot identities.
                </Text>
                <div className="mt-4 flex flex-wrap gap-3">
                    <div>
                        <Button
                            aria-describedby={
                                deployReason === undefined
                                    ? undefined
                                    : "delivery-deploy-disabled-reason"
                            }
                            disabled={!deployAvailable || busy}
                            onClick={onDeploy}
                        >
                            <Icon icon={Rocket} size="sm" />
                            Deploy latest main
                        </Button>
                        {deployReason === undefined ? null : (
                            <Text
                                className="mt-1 max-w-72"
                                id="delivery-deploy-disabled-reason"
                                size="sm"
                                tone="muted"
                            >
                                {deployReason}
                            </Text>
                        )}
                    </div>
                    <div>
                        <Button
                            aria-describedby={
                                rollbackReason === undefined
                                    ? undefined
                                    : "delivery-rollback-disabled-reason"
                            }
                            disabled={!rollbackAvailable || busy}
                            onClick={onRollback}
                            variant="danger"
                        >
                            <Icon icon={RotateCcw} size="sm" />
                            Rollback to previous
                        </Button>
                        {rollbackReason === undefined ? null : (
                            <Text
                                className="mt-1 max-w-72"
                                id="delivery-rollback-disabled-reason"
                                size="sm"
                                tone="muted"
                            >
                                {rollbackReason}
                            </Text>
                        )}
                    </div>
                </div>
                <div className="mt-4 flex items-center gap-2">
                    <Icon icon={GitBranch} size="sm" />
                    <Text size="sm" tone="muted">
                        Rollback targets only the authoritative previous release tuple.
                    </Text>
                </div>
            </Card>
        </div>
    );
}
