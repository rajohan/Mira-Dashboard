import { Effect } from "effect";

import { resourceBudgetEvidence } from "./resourceBudgetOrchestration.ts";

try {
    const report = await Effect.runPromise(resourceBudgetEvidence);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} catch (error) {
    process.stderr.write(
        `${Bun.inspect(error, { colors: false, depth: 8 }).slice(0, 32 * 1024)}\n`
    );
    process.exitCode = 1;
}
