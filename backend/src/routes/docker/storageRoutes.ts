import { parseDockerPruneRequest } from "../../../../contracts/docker/operations.ts";
import { json } from "../../http/core.ts";
import { getImages, getVolumes } from "../../services/docker/inventory.ts";
import { outputString, runQueuedDockerAction } from "./mutationExecution.ts";
import {
    dockerIdentifier,
    dockerImageIdentifier,
    invalidDockerIdentifier,
    parameters,
    readDockerJson,
} from "./request.ts";

export const dockerStorageRoutes = {
    "/api/docker/images": {
        GET: async () => json({ images: await getImages() }),
    },
    "/api/docker/images/:imageId": {
        DELETE: async (request: Request) => {
            const imageId = dockerImageIdentifier(parameters(request).imageId);
            if (!imageId) return invalidDockerIdentifier("imageId");
            await runQueuedDockerAction({
                actionKey: "docker.image.delete",
                displayName: "Delete Docker image",
                payload: { imageId },
                timeoutMs: 2 * 60 * 1000,
            });
            return json({ isSuccess: true });
        },
    },
    "/api/docker/prune": {
        POST: async (request: Request) => {
            const body = await readDockerJson(request, parseDockerPruneRequest);
            if (body instanceof Response) return body;
            if (body.target === "images") {
                return json({
                    isSuccess: true,
                    output: outputString(
                        await runQueuedDockerAction({
                            actionKey: "docker.prune.images",
                            displayName: "Prune Docker images",
                            payload: { target: "images" },
                            timeoutMs: 10 * 60 * 1000,
                        }),
                        "output"
                    ),
                });
            }
            return json({
                isSuccess: true,
                output: outputString(
                    await runQueuedDockerAction({
                        actionKey: "docker.prune.volumes",
                        displayName: "Prune Docker volumes",
                        payload: { target: "volumes" },
                        timeoutMs: 10 * 60 * 1000,
                    }),
                    "output"
                ),
            });
        },
    },
    "/api/docker/volumes": {
        GET: async () => json({ volumes: await getVolumes() }),
    },
    "/api/docker/volumes/:volumeName": {
        DELETE: async (request: Request) => {
            const volumeName = dockerIdentifier(parameters(request).volumeName);
            if (!volumeName) return invalidDockerIdentifier("volumeName");
            await runQueuedDockerAction({
                actionKey: "docker.volume.delete",
                displayName: "Delete Docker volume",
                payload: { volumeName },
                timeoutMs: 2 * 60 * 1000,
            });
            return json({ isSuccess: true });
        },
    },
} as const;
