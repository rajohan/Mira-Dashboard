import { writeCliError, writeCliOutput } from "./lib/cliOutput.ts";
import { runReleaseLifecycleCommand } from "./services/releases/lifecycle.ts";

export { runReleaseLifecycleCommand } from "./services/releases/lifecycle.ts";

if (import.meta.main) {
    try {
        const result = await runReleaseLifecycleCommand(Bun.argv.slice(2));
        writeCliOutput(JSON.stringify(result));
    } catch (error) {
        writeCliError(
            error instanceof Error ? error.message : "Release lifecycle failed"
        );
        process.exitCode = 1;
    }
}
