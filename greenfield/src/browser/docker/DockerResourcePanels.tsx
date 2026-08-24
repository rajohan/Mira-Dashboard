import { Database, Package, Trash2 } from "lucide-react";

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

interface ResourceDeleteButtonProps {
    readonly accessibleLabel: string;
    readonly disabled: boolean;
    readonly onClick: () => void;
}

function ResourceDeleteButton({
    accessibleLabel,
    disabled,
    onClick,
}: ResourceDeleteButtonProps) {
    return (
        <Button
            aria-label={accessibleLabel}
            className="shrink-0"
            disabled={disabled}
            onClick={onClick}
            size="sm"
            title={accessibleLabel}
            variant="danger"
        >
            <Icon icon={Trash2} size="sm" />
        </Button>
    );
}

interface DockerImageMobileCardProps {
    readonly containerNames: ReadonlyMap<string, string>;
    readonly deleteDisabled: boolean;
    readonly image: DockerImage;
    readonly onDelete: (image: DockerImage) => void;
}

function DockerImageMobileCard({
    containerNames,
    deleteDisabled,
    image,
    onDelete,
}: DockerImageMobileCardProps) {
    const unused = image.usedByContainerIds.length === 0;
    const label = image.references[0] ?? "Untagged";
    return (
        <li
            aria-label={`${label} image`}
            className="border-primary-700 bg-primary-950/40 rounded-lg border p-3 shadow-sm shadow-black/10"
        >
            <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                    {image.references.length === 0 ? (
                        <Text as="span" size="sm" tone="muted">
                            Untagged
                        </Text>
                    ) : (
                        <ul className="text-primary-100 space-y-1 text-sm">
                            {image.references.map((reference) => (
                                <li className="wrap-anywhere" key={reference}>
                                    {reference}
                                </li>
                            ))}
                        </ul>
                    )}
                    <code
                        className="text-primary-400 mt-1 block truncate text-xs"
                        title={image.id}
                    >
                        {image.id}
                    </code>
                </div>
                <ResourceDeleteButton
                    accessibleLabel={`Delete exact image ${image.id}`}
                    disabled={deleteDisabled || !unused}
                    onClick={() => onDelete(image)}
                />
            </div>
            <dl className="text-primary-400 mt-3 grid grid-cols-2 gap-3 text-xs">
                <div>
                    <dt>Size</dt>
                    <dd className="text-primary-200 mt-1 tabular-nums">
                        {formatByteCount(image.sizeBytes)}
                    </dd>
                </div>
                <div>
                    <dt>Usage</dt>
                    <dd className="mt-1">
                        <Badge variant={unused ? "default" : "info"}>
                            {unused
                                ? "Unused"
                                : `${image.usedByContainerIds.length} in use`}
                        </Badge>
                    </dd>
                </div>
            </dl>
            {!unused && (
                <Text className="mt-2 wrap-anywhere" size="sm" tone="muted">
                    Used by: {usersLabel(image.usedByContainerIds, containerNames)}
                </Text>
            )}
        </li>
    );
}

interface DockerVolumeMobileCardProps {
    readonly containerNames: ReadonlyMap<string, string>;
    readonly deleteDisabled: boolean;
    readonly onDelete: (volume: DockerVolume) => void;
    readonly volume: DockerVolume;
}

function DockerVolumeMobileCard({
    containerNames,
    deleteDisabled,
    onDelete,
    volume,
}: DockerVolumeMobileCardProps) {
    const unused = volume.usedByContainerIds.length === 0;
    return (
        <li
            aria-label={`${volume.name} volume`}
            className="border-primary-700 bg-primary-950/40 rounded-lg border p-3 shadow-sm shadow-black/10"
        >
            <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                    <div className="text-primary-100 font-medium wrap-anywhere">
                        {volume.name}
                    </div>
                    <Text as="span" className="mt-1 block" size="sm" tone="muted">
                        {volume.driver} · {volume.scope}
                    </Text>
                </div>
                <ResourceDeleteButton
                    accessibleLabel={`Delete exact volume ${volume.name}`}
                    disabled={deleteDisabled || !unused}
                    onClick={() => onDelete(volume)}
                />
            </div>
            <dl className="text-primary-400 mt-3 grid grid-cols-2 gap-3 text-xs">
                <div>
                    <dt>Size</dt>
                    <dd className="text-primary-200 mt-1 tabular-nums">
                        {volume.sizeBytes === undefined
                            ? "Unknown"
                            : formatByteCount(volume.sizeBytes)}
                    </dd>
                </div>
                <div>
                    <dt>Usage</dt>
                    <dd className="mt-1">
                        <Badge variant={unused ? "default" : "info"}>
                            {unused
                                ? "Unused"
                                : `${volume.usedByContainerIds.length} in use`}
                        </Badge>
                    </dd>
                </div>
            </dl>
            {!unused && (
                <Text className="mt-2 wrap-anywhere" size="sm" tone="muted">
                    Used by: {usersLabel(volume.usedByContainerIds, containerNames)}
                </Text>
            )}
        </li>
    );
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
    const unusedImageCount = images.filter(
        (image) => image.usedByContainerIds.length === 0
    ).length;
    const knownVolumeBytes = volumes.reduce(
        (total, volume) => total + (volume.sizeBytes ?? 0),
        0
    );
    const unusedVolumeCount = volumes.filter(
        (volume) => volume.usedByContainerIds.length === 0
    ).length;

    return (
        <div className="@container min-w-0">
            <div className="grid min-w-0 gap-5 xl:grid-cols-2 @min-[66rem]:grid-cols-2">
                <Card
                    aria-labelledby="docker-images-heading"
                    className="@container min-w-0"
                >
                    <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                        <div className="min-w-0">
                            <div className="flex min-w-0 items-center gap-2">
                                <Icon icon={Package} tone="accent" />
                                <Heading id="docker-images-heading" level={2}>
                                    Images
                                </Heading>
                            </div>
                            <Text className="mt-1" tone="muted">
                                {images.length} images · {formatByteCount(imageBytes)}
                            </Text>
                        </div>
                        <Button
                            aria-label="Prune unused images"
                            className="w-full sm:w-auto"
                            disabled={controlsDisabled || busy}
                            onClick={() => onPreviewPrune("images")}
                            size="sm"
                            variant="secondary"
                        >
                            <Icon icon={Trash2} size="sm" />
                            Prune unused ({unusedImageCount})
                        </Button>
                    </div>
                    {images.length === 0 ? (
                        <Text className="mt-5" tone="muted">
                            No images were discovered.
                        </Text>
                    ) : (
                        <>
                            <ul
                                aria-label="Docker images"
                                className="mt-5 space-y-3 @min-[30rem]:hidden"
                            >
                                {images.map((image) => (
                                    <DockerImageMobileCard
                                        containerNames={containerNames}
                                        deleteDisabled={controlsDisabled || busy}
                                        image={image}
                                        key={image.id}
                                        onDelete={onDeleteImage}
                                    />
                                ))}
                            </ul>
                            <div className="border-primary-700 mt-5 hidden max-h-128 overflow-hidden overflow-y-auto rounded-lg border @min-[30rem]:block">
                                <table
                                    aria-label="Docker images"
                                    className="bg-primary-950/40 w-full table-fixed border-separate border-spacing-0 text-sm"
                                >
                                    <colgroup>
                                        <col className="w-[45%]" />
                                        <col className="w-[18%]" />
                                        <col className="w-[25%]" />
                                        <col className="w-[12%]" />
                                    </colgroup>
                                    <thead className="bg-primary-950 sticky top-0 z-10">
                                        <tr>
                                            <th
                                                className="text-primary-300 border-primary-700 border-b px-3 py-2 text-left text-xs font-semibold tracking-wide uppercase"
                                                scope="col"
                                            >
                                                Image
                                            </th>
                                            <th
                                                className="text-primary-300 border-primary-700 border-b px-3 py-2 text-left text-xs font-semibold tracking-wide uppercase"
                                                scope="col"
                                            >
                                                Size
                                            </th>
                                            <th
                                                className="text-primary-300 border-primary-700 border-b px-3 py-2 text-left text-xs font-semibold tracking-wide uppercase"
                                                scope="col"
                                            >
                                                Usage
                                            </th>
                                            <th
                                                className="text-primary-300 border-primary-700 border-b p-2 text-center text-xs font-semibold tracking-wide uppercase"
                                                scope="col"
                                            >
                                                <span className="sr-only">Actions</span>
                                            </th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {images.map((image) => {
                                            const unused =
                                                image.usedByContainerIds.length === 0;
                                            return (
                                                <tr
                                                    className="align-top [&:last-child>td]:border-b-0"
                                                    key={image.id}
                                                >
                                                    <td className="border-primary-700/60 max-w-0 overflow-hidden border-b p-3">
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
                                                                            key={
                                                                                reference
                                                                            }
                                                                        >
                                                                            {reference}
                                                                        </li>
                                                                    )
                                                                )}
                                                            </ul>
                                                        )}
                                                        <code
                                                            className="text-primary-400 mt-2 block truncate text-xs"
                                                            title={image.id}
                                                        >
                                                            {image.id}
                                                        </code>
                                                    </td>
                                                    <td className="text-primary-200 border-primary-700/60 overflow-hidden border-b p-3 whitespace-nowrap tabular-nums">
                                                        {formatByteCount(image.sizeBytes)}
                                                    </td>
                                                    <td className="border-primary-700/60 max-w-0 overflow-hidden border-b p-3">
                                                        <Badge
                                                            variant={
                                                                unused
                                                                    ? "default"
                                                                    : "info"
                                                            }
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
                                                    <td className="border-primary-700/60 overflow-hidden border-b px-2 py-3 text-center">
                                                        <ResourceDeleteButton
                                                            accessibleLabel={
                                                                "Delete exact image " +
                                                                image.id
                                                            }
                                                            disabled={
                                                                controlsDisabled ||
                                                                busy ||
                                                                !unused
                                                            }
                                                            onClick={() =>
                                                                onDeleteImage(image)
                                                            }
                                                        />
                                                    </td>
                                                </tr>
                                            );
                                        })}
                                    </tbody>
                                </table>
                            </div>
                        </>
                    )}
                </Card>

                <Card
                    aria-labelledby="docker-volumes-heading"
                    className="@container min-w-0"
                >
                    <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                        <div className="min-w-0">
                            <div className="flex min-w-0 items-center gap-2">
                                <Icon icon={Database} tone="accent" />
                                <Heading id="docker-volumes-heading" level={2}>
                                    Volumes
                                </Heading>
                            </div>
                            <Text className="mt-1" tone="muted">
                                {volumes.length} volumes · at least{" "}
                                {formatByteCount(knownVolumeBytes)}
                            </Text>
                        </div>
                        <Button
                            aria-label="Prune unused volumes"
                            className="w-full sm:w-auto"
                            disabled={controlsDisabled || busy}
                            onClick={() => onPreviewPrune("volumes")}
                            size="sm"
                            variant="secondary"
                        >
                            <Icon icon={Trash2} size="sm" />
                            Prune unused ({unusedVolumeCount})
                        </Button>
                    </div>
                    {volumes.length === 0 ? (
                        <Text className="mt-5" tone="muted">
                            No volumes were discovered.
                        </Text>
                    ) : (
                        <>
                            <ul
                                aria-label="Docker volumes"
                                className="mt-5 space-y-3 @min-[30rem]:hidden"
                            >
                                {volumes.map((volume) => (
                                    <DockerVolumeMobileCard
                                        containerNames={containerNames}
                                        deleteDisabled={controlsDisabled || busy}
                                        key={volume.name}
                                        onDelete={onDeleteVolume}
                                        volume={volume}
                                    />
                                ))}
                            </ul>
                            <div className="border-primary-700 mt-5 hidden max-h-128 overflow-hidden overflow-y-auto rounded-lg border @min-[30rem]:block">
                                <table
                                    aria-label="Docker volumes"
                                    className="bg-primary-950/40 w-full table-fixed border-separate border-spacing-0 text-sm"
                                >
                                    <colgroup>
                                        <col className="w-[43%]" />
                                        <col className="w-[18%]" />
                                        <col className="w-[27%]" />
                                        <col className="w-[12%]" />
                                    </colgroup>
                                    <thead className="bg-primary-950 sticky top-0 z-10">
                                        <tr>
                                            <th
                                                className="text-primary-300 border-primary-700 border-b px-3 py-2 text-left text-xs font-semibold tracking-wide uppercase"
                                                scope="col"
                                            >
                                                Volume
                                            </th>
                                            <th
                                                className="text-primary-300 border-primary-700 border-b px-3 py-2 text-left text-xs font-semibold tracking-wide uppercase"
                                                scope="col"
                                            >
                                                Size
                                            </th>
                                            <th
                                                className="text-primary-300 border-primary-700 border-b px-3 py-2 text-left text-xs font-semibold tracking-wide uppercase"
                                                scope="col"
                                            >
                                                Usage
                                            </th>
                                            <th
                                                className="text-primary-300 border-primary-700 border-b p-2 text-center text-xs font-semibold tracking-wide uppercase"
                                                scope="col"
                                            >
                                                <span className="sr-only">Actions</span>
                                            </th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {volumes.map((volume) => {
                                            const unused =
                                                volume.usedByContainerIds.length === 0;
                                            return (
                                                <tr
                                                    className="align-top [&:last-child>td]:border-b-0"
                                                    key={volume.name}
                                                >
                                                    <td className="border-primary-700/60 max-w-0 overflow-hidden border-b p-3">
                                                        <div className="text-primary-100 font-medium wrap-anywhere">
                                                            {volume.name}
                                                        </div>
                                                        <Text
                                                            as="span"
                                                            className="mt-1 block"
                                                            size="sm"
                                                            tone="muted"
                                                        >
                                                            {volume.driver} ·{" "}
                                                            {volume.scope}
                                                        </Text>
                                                    </td>
                                                    <td className="text-primary-200 border-primary-700/60 overflow-hidden border-b p-3 whitespace-nowrap tabular-nums">
                                                        {volume.sizeBytes === undefined
                                                            ? "Unknown"
                                                            : formatByteCount(
                                                                  volume.sizeBytes
                                                              )}
                                                    </td>
                                                    <td className="border-primary-700/60 max-w-0 overflow-hidden border-b p-3">
                                                        <Badge
                                                            variant={
                                                                unused
                                                                    ? "default"
                                                                    : "info"
                                                            }
                                                        >
                                                            {unused
                                                                ? "Unused"
                                                                : volume
                                                                      .usedByContainerIds
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
                                                    <td className="border-primary-700/60 overflow-hidden border-b px-2 py-3 text-center">
                                                        <ResourceDeleteButton
                                                            accessibleLabel={
                                                                "Delete exact volume " +
                                                                volume.name
                                                            }
                                                            disabled={
                                                                controlsDisabled ||
                                                                busy ||
                                                                !unused
                                                            }
                                                            onClick={() =>
                                                                onDeleteVolume(volume)
                                                            }
                                                        />
                                                    </td>
                                                </tr>
                                            );
                                        })}
                                    </tbody>
                                </table>
                            </div>
                        </>
                    )}
                </Card>
            </div>
        </div>
    );
}
