import { Rocket, RotateCcw } from "lucide-react";

import type {
    DeliveryCheckout,
    DeliveryRelease,
    DeliveryReleases,
} from "../../contracts/delivery.ts";
import { formatDashboardDateTime } from "../lib/formatDateTime.ts";
import { Alert } from "../ui/Alert.tsx";
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
        <Card aria-labelledby="delivery-checkout-card-heading" className="p-3 sm:p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
                <Heading id="delivery-checkout-card-heading" level={3}>
                    Main checkout
                </Heading>
                <Badge variant={checkout.safeForDeploy ? "success" : "warning"}>
                    {deliveryCheckoutLabels[checkout.condition]}
                </Badge>
            </div>
            <dl className="mt-3 grid gap-x-4 gap-y-1.5 text-sm sm:grid-cols-2">
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
        <div
            aria-label={label}
            className="border-primary-700 bg-primary-900/40 rounded-lg border p-3"
        >
            <Heading level={3} size="subsection">
                {label}
            </Heading>
            {release === undefined ? (
                <Text className="mt-2" size="sm" tone="muted">
                    No release available
                </Text>
            ) : (
                <div className="mt-2 space-y-1">
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
        </div>
    );
}

interface ProductionReleasesPanelProps {
    readonly busy: boolean;
    readonly checkout?: DeliveryCheckout;
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
    checkout,
    deployAvailable,
    deployReason,
    onDeploy,
    onRollback,
    releases,
    releasesFresh,
}: ProductionReleasesPanelProps) {
    const rollbackAvailable = releasesFresh && releases.rollback.available;
    const rollbackReason = rollbackUnavailableReason(releases, releasesFresh);
    const rollbackReasonIsError =
        !releases.rollback.available &&
        (releases.rollback.reason === "incompatible" ||
            releases.rollback.reason === "source-unavailable");
    const checkoutIsActive =
        checkout !== undefined && releases.current?.releaseId === checkout.headSha;
    let checkoutBadgeLabel = "Checking";
    if (checkout !== undefined) {
        checkoutBadgeLabel = checkoutIsActive ? "Active" : "Deploy available";
    }
    return (
        <Card aria-label="Production release slots" className="space-y-3 p-3 sm:p-4">
            <div className="grid gap-2 lg:grid-cols-3">
                <ReleaseSlot label="Active release" release={releases.current} />
                <ReleaseSlot
                    label="Previous / rollback target"
                    release={releases.previous}
                />
                <div className="border-primary-700 bg-primary-900/40 rounded-lg border p-3">
                    <div className="flex items-start justify-between gap-2">
                        <Heading level={3}>Main checkout</Heading>
                        <Badge variant={checkoutIsActive ? "success" : "warning"}>
                            {checkoutBadgeLabel}
                        </Badge>
                    </div>
                    <code className="text-primary-100 mt-2 block text-sm">
                        {checkout?.headSha.slice(0, 8) ?? "Checking…"}
                    </code>
                    <Text className="mt-1" size="sm" tone="muted">
                        Control checkout. Deploy syncs latest main first.
                    </Text>
                </div>
            </div>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                {rollbackReason === undefined ? null : (
                    <div
                        className="w-full min-w-0 flex-1"
                        id="delivery-rollback-disabled-reason"
                    >
                        <Alert
                            className="py-2"
                            focusOnError={false}
                            message={rollbackReason}
                            variant={rollbackReasonIsError ? "error" : "warning"}
                        />
                    </div>
                )}
                <div className="flex shrink-0 flex-col gap-2 sm:ml-auto sm:flex-row">
                    <div className="w-full sm:w-auto">
                        <Button
                            aria-describedby={
                                deployReason === undefined
                                    ? undefined
                                    : "delivery-deploy-disabled-reason"
                            }
                            className="w-full sm:w-auto"
                            disabled={!deployAvailable || busy}
                            onClick={onDeploy}
                            title={deployReason}
                        >
                            <Icon icon={Rocket} size="sm" />
                            Deploy latest main
                        </Button>
                        {deployReason === undefined ? null : (
                            <Text
                                className="sr-only"
                                id="delivery-deploy-disabled-reason"
                            >
                                {deployReason}
                            </Text>
                        )}
                    </div>
                    <Button
                        aria-describedby={
                            rollbackReason === undefined
                                ? undefined
                                : "delivery-rollback-disabled-reason"
                        }
                        className="w-full shrink-0 sm:w-auto"
                        disabled={!rollbackAvailable || busy}
                        onClick={onRollback}
                        variant="danger"
                    >
                        <Icon icon={RotateCcw} size="sm" />
                        {releases.previous === undefined
                            ? "Rollback unavailable"
                            : `Roll back to ${releases.previous.releaseId.slice(0, 8)}`}
                    </Button>
                </div>
            </div>
        </Card>
    );
}
