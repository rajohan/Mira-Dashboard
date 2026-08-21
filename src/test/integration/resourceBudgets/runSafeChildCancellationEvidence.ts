import { Effect } from "effect";

import { interruptedShutdownScenario } from "../shutdown/completeShutdownScenario.ts";

const report = await Effect.runPromise(interruptedShutdownScenario);
if (
    report.processGroupMembersWhileReady.length === 0 ||
    report.processGroupMembersAfterInterruption.length > 0 ||
    report.stoppedStatus.phase !== "stopped"
) {
    throw new Error("Interrupted child-process scope did not cleanly terminate");
}
process.stdout.write(
    `${JSON.stringify({
        processGroupMembersAfterInterruption: report.processGroupMembersAfterInterruption,
        processGroupMembersWhileReady: report.processGroupMembersWhileReady.length,
        stoppedPhase: report.stoppedStatus.phase,
    })}\n`
);
