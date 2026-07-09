import { Boxes } from "lucide-react";

import { useCacheEntry } from "../../../hooks/useCache";
import { type DockerSummaryCache } from "../../../hooks/useDocker";
import { Card } from "../../ui/Card";
import { formatBytes } from "../docker/dockerFormatters";

/** Renders the Docker overview card UI. */
export function DockerOverviewCard() {
    const { data, isError, isLoading } = useCacheEntry<DockerSummaryCache>(
        "docker.summary",
        30_000
    );
    const docker = data?.data;
    const containers = docker?.containers ?? [];
    const images = docker?.images ?? [];
    const volumes = docker?.volumes ?? [];
    const running = containers.filter(
        (container) => container.state === "running"
    ).length;
    const unhealthy = containers.filter(
        (container) => container.health === "unhealthy"
    ).length;
    const updateAvailable = docker?.updaterSummary.updateAvailable ?? 0;
    const totalImageSize = images.reduce((sum, image) => sum + image.size, 0);

    return (
        <Card>
            <div className="mb-3 flex items-center justify-between gap-2">
                <h3 className="text-sm font-semibold tracking-wide text-primary-300 uppercase">
                    Docker
                </h3>
                <Boxes className="size-4 text-primary-400" />
            </div>

            {isLoading ? (
                <div className="text-sm text-primary-300">Loading Docker cache…</div>
            ) : isError || !docker ? (
                <div className="text-sm text-rose-300">Docker cache unavailable.</div>
            ) : (
                <div className="space-y-2 text-sm text-primary-200">
                    <div className="flex items-center justify-between">
                        <span>Containers</span>
                        <span className="font-semibold text-primary-50">
                            {running}/{containers.length} running
                        </span>
                    </div>
                    <div className="flex items-center justify-between">
                        <span>Unhealthy</span>
                        <span
                            className={unhealthy > 0 ? "text-red-300" : "text-green-300"}
                        >
                            {unhealthy}
                        </span>
                    </div>
                    <div className="flex items-center justify-between">
                        <span>Images</span>
                        <span className="text-primary-100">{images.length}</span>
                    </div>
                    <div className="flex items-center justify-between">
                        <span>Volumes</span>
                        <span className="text-primary-100">{volumes.length}</span>
                    </div>
                    <div className="flex items-center justify-between">
                        <span>Updates</span>
                        <span
                            className={
                                updateAvailable > 0 ? "text-yellow-300" : "text-green-300"
                            }
                        >
                            {updateAvailable}
                        </span>
                    </div>
                    <div className="flex items-center justify-between">
                        <span>Image size</span>
                        <span className="text-primary-100">
                            {formatBytes(totalImageSize)}
                        </span>
                    </div>
                </div>
            )}
        </Card>
    );
}
