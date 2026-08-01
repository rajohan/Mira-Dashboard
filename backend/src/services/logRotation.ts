export { runLogRotationService } from "./logRotation/core.ts";
export {
    runElevatedLogRotationService,
    runLogRotationCli,
} from "./logRotation/runtime.ts";
export type { ElevatedLogRotationResult } from "./logRotation/runtime.ts";
export { registerLogRotationScheduledJobs } from "./logRotation/scheduler.ts";
