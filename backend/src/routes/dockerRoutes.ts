import { dockerContainerRoutes } from "./docker/containerRoutes.ts";
import { dockerExecRoutes } from "./docker/execRoutes.ts";
import { dockerStackRoutes } from "./docker/stackRoutes.ts";
import { dockerStorageRoutes } from "./docker/storageRoutes.ts";
import { dockerUpdaterRoutes } from "./docker/updaterRoutes.ts";

export const dockerRoutes = {
    ...dockerContainerRoutes,
    ...dockerExecRoutes,
    ...dockerStorageRoutes,
    ...dockerStackRoutes,
    ...dockerUpdaterRoutes,
} as const;
