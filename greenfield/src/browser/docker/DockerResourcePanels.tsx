import { Database, Package, Sparkles, Trash2 } from "lucide-react";

import type {
    DockerContainer,
    DockerImage,
    DockerVolume,
} from "../../contracts/docker.ts";
import { formatByteCount } from "../lib/formatMeasurements.ts";
import { Badge } from "../ui/Badge.tsx";
import { Button } from "../ui/Button.tsx";
import { Card } from "../ui/Card.tsx";
import { Heading } from "../ui/Heading.tsx";
import { Icon } from "../ui/Icon.tsx";
import { Text } from "../ui/Text.tsx";

interface DockerResourcePanelsProps {
    readonly busy: boolean;
    readonly containers: readonly DockerContainer[];
    readonly controlsDisabled: boolean;
    readonly images: readonly DockerImage[];
    readonly onDeleteImage: (image: DockerImage) => void;
    readonly onDeleteVolume: (volume: DockerVolume) => void;
    readonly onPreviewPrune: (target: "images" | "volumes") => void;
    readonly volumes: readonly DockerVolume[];
}

function usersLabel(
    ids: readonly string[],
    containerNames: ReadonlyMap<string, string>
): string {
    if (ids.length === 0) return "Unused";
    return ids.map((id) => containerNames.get(id) ?? id.slice(0, 12)).join(", ");
}

/** @returns Exact image and volume inventory, usage, deletion, and prune-preview controls. */
export function DockerResourcePanels({
    busy,
    containers,
    controlsDisabled,
    images,
    onDeleteImage,
    onDeleteVolume,
    onPreviewPrune,
    volumes,
}: DockerResourcePanelsProps) {
    const containerNames = new Map(
        containers.map((container) => [container.id, container.name] as const)
    );
    const imageBytes = images.reduce((total, image) => total + image.sizeBytes, 0);
    const knownVolumeBytes = volumes.reduce(
        (total, volume) => total + (volume.sizeBytes ?? 0),
        0
    );

    return (
        <div className="grid min-w-0 gap-5 xl:grid-cols-2">
            <Card aria-labelledby="docker-images-heading" className="min-w-0">
                <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                    <div className="flex min-w-0 items-start gap-3">
                        <span className="bg-accent-500/10 shrink-0 rounded-lg p-2.5">
                            <Icon icon={Package} tone="accent" />
                        </span>
                        <div>
                            <Heading id="docker-images-heading" level={2}>
                                Images
                            </Heading>
                            <Text className="mt-1" tone="muted">
                                {images.length} images · {formatByteCount(imageBytes)}
                            </Text>
                        </div>
                    </div>
                    <Button
                        aria-label="Preview unused image prune"
                        disabled={controlsDisabled || busy}
                        onClick={() => onPreviewPrune("images")}
                        size="sm"
                        variant="secondary"
                    >
                        <Icon icon={Sparkles} size="sm" />
                        Preview prune
                    </Button>
                </div>
                {images.length === 0 ? (
                    <Text className="mt-5" tone="muted">
                        No images were discovered.
                    </Text>
                ) : (
                    <div className="border-primary-700 mt-5 max-h-128 overflow-auto rounded-lg border">
                        <table
                            aria-label="Docker images"
                            className="w-full min-w-144 border-separate border-spacing-0 text-sm"
                        >
                            <thead className="bg-primary-950 sticky top-0 z-10">
                                <tr>
                                    <th
                                        className="text-primary-300 border-primary-700 border-b p-3 text-left text-xs font-semibold tracking-wide uppercase"
                                        scope="col"
                                    >
                                        Image
                                    </th>
                                    <th
                                        className="text-primary-300 border-primary-700 border-b p-3 text-left text-xs font-semibold tracking-wide uppercase"
                                        scope="col"
                                    >
                                        Size
                                    </th>
                                    <th
                                        className="text-primary-300 border-primary-700 border-b p-3 text-left text-xs font-semibold tracking-wide uppercase"
                                        scope="col"
                                    >
                                        Usage
                                    </th>
                                    <th
                                        className="text-primary-300 border-primary-700 border-b p-3 text-left text-xs font-semibold tracking-wide uppercase"
                                        scope="col"
                                    >
                                        Action
                                    </th>
                                </tr>
                            </thead>
                            <tbody>
                                {images.map((image) => {
                                    const unused = image.usedByContainerIds.length === 0;
                                    return (
                                        <tr
                                            className="border-primary-700 border-b align-top"
                                            key={image.id}
                                        >
                                            <td className="p-3">
                                                {image.references.length === 0 ? (
                                                    <Text
                                                        as="span"
                                                        size="sm"
                                                        tone="muted"
                                                    >
                                                        Untagged
                                                    </Text>
                                                ) : (
                                                    <ul className="text-primary-100 space-y-1">
                                                        {image.references.map(
                                                            (reference) => (
                                                                <li
                                                                    className="wrap-anywhere"
                                                                    key={reference}
                                                                >
                                                                    {reference}
                                                                </li>
                                                            )
                                                        )}
                                                    </ul>
                                                )}
                                                <code className="text-primary-500 mt-2 block text-xs wrap-anywhere">
                                                    {image.id}
                                                </code>
                                            </td>
                                            <td className="text-primary-200 p-3 tabular-nums">
                                                {formatByteCount(image.sizeBytes)}
                                            </td>
                                            <td className="p-3">
                                                <Badge
                                                    variant={unused ? "default" : "info"}
                                                >
                                                    {unused
                                                        ? "Unused"
                                                        : image.usedByContainerIds
                                                              .length + " in use"}
                                                </Badge>
                                                <Text
                                                    as="span"
                                                    className="mt-1 block wrap-anywhere"
                                                    size="sm"
                                                    tone="muted"
                                                >
                                                    {usersLabel(
                                                        image.usedByContainerIds,
                                                        containerNames
                                                    )}
                                                </Text>
                                            </td>
                                            <td className="p-3">
                                                <Button
                                                    aria-label={
                                                        "Delete exact image " + image.id
                                                    }
                                                    disabled={
                                                        controlsDisabled ||
                                                        busy ||
                                                        !unused
                                                    }
                                                    onClick={() => onDeleteImage(image)}
                                                    size="sm"
                                                    variant="danger"
                                                >
                                                    <Icon icon={Trash2} size="sm" />
                                                    Delete
                                                </Button>
                                            </td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    </div>
                )}
            </Card>

            <Card aria-labelledby="docker-volumes-heading" className="min-w-0">
                <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                    <div className="flex min-w-0 items-start gap-3">
                        <span className="bg-accent-500/10 shrink-0 rounded-lg p-2.5">
                            <Icon icon={Database} tone="accent" />
                        </span>
                        <div>
                            <Heading id="docker-volumes-heading" level={2}>
                                Volumes
                            </Heading>
                            <Text className="mt-1" tone="muted">
                                {volumes.length} volumes · at least{" "}
                                {formatByteCount(knownVolumeBytes)}
                            </Text>
                        </div>
                    </div>
                    <Button
                        aria-label="Preview unused volume prune"
                        disabled={controlsDisabled || busy}
                        onClick={() => onPreviewPrune("volumes")}
                        size="sm"
                        variant="secondary"
                    >
                        <Icon icon={Sparkles} size="sm" />
                        Preview prune
                    </Button>
                </div>
                {volumes.length === 0 ? (
                    <Text className="mt-5" tone="muted">
                        No volumes were discovered.
                    </Text>
                ) : (
                    <div className="border-primary-700 mt-5 max-h-128 overflow-auto rounded-lg border">
                        <table
                            aria-label="Docker volumes"
                            className="w-full min-w-128 border-separate border-spacing-0 text-sm"
                        >
                            <thead className="bg-primary-950 sticky top-0 z-10">
                                <tr>
                                    <th
                                        className="text-primary-300 border-primary-700 border-b p-3 text-left text-xs font-semibold tracking-wide uppercase"
                                        scope="col"
                                    >
                                        Volume
                                    </th>
                                    <th
                                        className="text-primary-300 border-primary-700 border-b p-3 text-left text-xs font-semibold tracking-wide uppercase"
                                        scope="col"
                                    >
                                        Size
                                    </th>
                                    <th
                                        className="text-primary-300 border-primary-700 border-b p-3 text-left text-xs font-semibold tracking-wide uppercase"
                                        scope="col"
                                    >
                                        Usage
                                    </th>
                                    <th
                                        className="text-primary-300 border-primary-700 border-b p-3 text-left text-xs font-semibold tracking-wide uppercase"
                                        scope="col"
                                    >
                                        Action
                                    </th>
                                </tr>
                            </thead>
                            <tbody>
                                {volumes.map((volume) => {
                                    const unused = volume.usedByContainerIds.length === 0;
                                    return (
                                        <tr
                                            className="border-primary-700 border-b align-top"
                                            key={volume.name}
                                        >
                                            <td className="p-3">
                                                <div className="text-primary-100 font-medium wrap-anywhere">
                                                    {volume.name}
                                                </div>
                                                <Text
                                                    as="span"
                                                    className="mt-1 block"
                                                    size="sm"
                                                    tone="muted"
                                                >
                                                    {volume.driver} · {volume.scope}
                                                </Text>
                                            </td>
                                            <td className="text-primary-200 p-3 tabular-nums">
                                                {volume.sizeBytes === undefined
                                                    ? "Unknown"
                                                    : formatByteCount(volume.sizeBytes)}
                                            </td>
                                            <td className="p-3">
                                                <Badge
                                                    variant={unused ? "default" : "info"}
                                                >
                                                    {unused
                                                        ? "Unused"
                                                        : volume.usedByContainerIds
                                                              .length + " in use"}
                                                </Badge>
                                                <Text
                                                    as="span"
                                                    className="mt-1 block wrap-anywhere"
                                                    size="sm"
                                                    tone="muted"
                                                >
                                                    {usersLabel(
                                                        volume.usedByContainerIds,
                                                        containerNames
                                                    )}
                                                </Text>
                                            </td>
                                            <td className="p-3">
                                                <Button
                                                    aria-label={
                                                        "Delete exact volume " +
                                                        volume.name
                                                    }
                                                    disabled={
                                                        controlsDisabled ||
                                                        busy ||
                                                        !unused
                                                    }
                                                    onClick={() => onDeleteVolume(volume)}
                                                    size="sm"
                                                    variant="danger"
                                                >
                                                    <Icon icon={Trash2} size="sm" />
                                                    Delete
                                                </Button>
                                            </td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    </div>
                )}
            </Card>
        </div>
    );
}
