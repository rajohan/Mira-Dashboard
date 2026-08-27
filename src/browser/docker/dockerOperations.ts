import type {
    DockerContainer,
    DockerImage,
    DockerRequestOperationInput,
    DockerUpdaterService,
    DockerVolume,
} from "../../contracts/docker.ts";

export interface DockerOperationPrompt {
    readonly confirmLabel: string;
    readonly danger: boolean;
    readonly description: string;
    readonly input: DockerRequestOperationInput;
    readonly title: string;
}

/** @returns One browser-generated idempotency key retained across safe retries. */
export function createDockerIdempotencyKey(): string {
    return globalThis.crypto.randomUUID().replaceAll("-", "");
}

export function containerOperationPrompt(
    container: DockerContainer,
    operation: "container-restart" | "container-start" | "container-stop",
    sourceRevision: string
): DockerOperationPrompt {
    const idempotencyKey = createDockerIdempotencyKey();
    switch (operation) {
        case "container-start": {
            return {
                confirmLabel: "Queue start",
                danger: false,
                description:
                    "Start “" +
                    container.name +
                    "” using exact container ID " +
                    container.id +
                    "?",
                input: {
                    confirmation: "start-docker-container",
                    containerId: container.id,
                    idempotencyKey,
                    operation,
                    sourceRevision,
                },
                title: "Start container?",
            };
        }
        case "container-stop": {
            return {
                confirmLabel: "Queue stop",
                danger: true,
                description:
                    "Stop “" +
                    container.name +
                    "” using exact container ID " +
                    container.id +
                    "?",
                input: {
                    confirmation: "stop-docker-container",
                    containerId: container.id,
                    idempotencyKey,
                    operation,
                    sourceRevision,
                },
                title: "Stop container?",
            };
        }
        case "container-restart": {
            return {
                confirmLabel: "Queue restart",
                danger: true,
                description:
                    "Restart “" +
                    container.name +
                    "” using exact container ID " +
                    container.id +
                    "?",
                input: {
                    confirmation: "restart-docker-container",
                    containerId: container.id,
                    idempotencyKey,
                    operation,
                    sourceRevision,
                },
                title: "Restart container?",
            };
        }
    }
}

export function stackOperationPrompt(
    operation: "stack-restart" | "stack-start" | "stack-stop",
    sourceRevision: string
): DockerOperationPrompt {
    const idempotencyKey = createDockerIdempotencyKey();
    switch (operation) {
        case "stack-start": {
            return {
                confirmLabel: "Queue stack start",
                danger: false,
                description:
                    "Start the discovered root Compose stack at this exact source revision?",
                input: {
                    confirmation: "start-docker-stack",
                    idempotencyKey,
                    operation,
                    sourceRevision,
                },
                title: "Start Docker stack?",
            };
        }
        case "stack-stop": {
            return {
                confirmLabel: "Queue stack stop",
                danger: true,
                description:
                    "Stop the discovered root Compose stack at this exact source revision?",
                input: {
                    confirmation: "stop-docker-stack",
                    idempotencyKey,
                    operation,
                    sourceRevision,
                },
                title: "Stop Docker stack?",
            };
        }
        case "stack-restart": {
            return {
                confirmLabel: "Queue stack restart",
                danger: true,
                description:
                    "Restart the discovered root Compose stack at this exact source revision?",
                input: {
                    confirmation: "restart-docker-stack",
                    idempotencyKey,
                    operation,
                    sourceRevision,
                },
                title: "Restart Docker stack?",
            };
        }
    }
}

export function imageDeletePrompt(
    image: DockerImage,
    sourceRevision: string
): DockerOperationPrompt {
    return {
        confirmLabel: "Queue image deletion",
        danger: true,
        description:
            "Delete exact unused image " +
            image.id +
            "? Tags: " +
            (image.references.join(", ") || "none") +
            ".",
        input: {
            confirmation: "delete-docker-image",
            idempotencyKey: createDockerIdempotencyKey(),
            imageId: image.id,
            operation: "image-delete",
            sourceRevision,
        },
        title: "Delete Docker image?",
    };
}

export function volumeDeletePrompt(
    volume: DockerVolume,
    sourceRevision: string
): DockerOperationPrompt {
    return {
        confirmLabel: "Queue volume deletion",
        danger: true,
        description:
            "Delete exact unused volume “" +
            volume.name +
            "”? Its stored data cannot be recovered from Docker.",
        input: {
            confirmation: "delete-docker-volume",
            idempotencyKey: createDockerIdempotencyKey(),
            operation: "volume-delete",
            sourceRevision,
            volumeName: volume.name,
        },
        title: "Delete Docker volume?",
    };
}

export function updaterOperationPrompt(
    operation: "updater-run" | "updater-scan",
    sourceRevision: string
): DockerOperationPrompt {
    if (operation === "updater-scan") {
        return {
            confirmLabel: "Queue scan",
            danger: false,
            description:
                "Scan every managed Docker service for registry updates at this source revision?",
            input: {
                confirmation: "scan-docker-updates",
                idempotencyKey: createDockerIdempotencyKey(),
                operation,
                sourceRevision,
            },
            title: "Scan Docker updates?",
        };
    }
    return {
        confirmLabel: "Queue updater",
        danger: false,
        description:
            "Update every managed Docker service with an available registry candidate at this source revision?",
        input: {
            confirmation: "run-docker-updates",
            idempotencyKey: createDockerIdempotencyKey(),
            operation,
            sourceRevision,
        },
        title: "Run Docker updates?",
    };
}

export function serviceUpdatePrompt(
    service: DockerUpdaterService,
    sourceRevision: string
): DockerOperationPrompt {
    if (service.status.state !== "update-available") {
        throw new TypeError("Docker service update candidate is unavailable");
    }
    const candidate = service.status.candidateImage;
    return {
        confirmLabel: "Queue service update",
        danger: false,
        description:
            "Update exact Compose service “" +
            service.project +
            " / " +
            service.service +
            "” from " +
            service.currentImage +
            " to " +
            candidate +
            "?",
        input: {
            candidateImage: candidate,
            confirmation: "update-docker-service",
            currentImage: service.currentImage,
            idempotencyKey: createDockerIdempotencyKey(),
            operation: "updater-update-service",
            serviceId: service.id,
            sourceRevision,
        },
        title: "Update Docker service?",
    };
}
