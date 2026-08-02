import type { DeploymentJob } from "../../../../../contracts/delivery/deployments";
import { Badge } from "../../ui/Badge";
import { CardTitle } from "../../ui/Card";

interface SectionHeaderProperties {
    badgeVariant: Parameters<typeof Badge>[0]["variant"];
    count: number;
    title: string;
}

/**
 * Renders a pull-request section title and count badge.
 * @param properties Section label, count, and badge presentation.
 * @returns Pull-request section header.
 */
export function SectionHeader({ title, count, badgeVariant }: SectionHeaderProperties) {
    const countLabel = `${count} ${count === 1 ? "PR" : "PRs"}`;
    return (
        <div className="flex flex-wrap items-center gap-2">
            <CardTitle className="text-base">{title}</CardTitle>
            <Badge variant={badgeVariant}>{countLabel}</Badge>
        </div>
    );
}

/**
 * Renders a deployment title and abbreviated commit reference.
 * @param properties Deployment to label.
 * @returns Deployment commit label.
 */
export function DeploymentCommitLabel({ deployment }: { deployment: DeploymentJob }) {
    const commit = deployment.commit?.slice(0, 8) || deployment.id;
    if (!deployment.commitTitle) return commit;

    return (
        <>
            <span className="line-clamp-2 min-w-0 flex-1 wrap-break-word">
                {deployment.commitTitle}
            </span>
            <span className="shrink-0 whitespace-nowrap text-primary-500">
                ({commit})
            </span>
        </>
    );
}
