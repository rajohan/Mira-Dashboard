import { Effect } from "effect";

import { completeShutdownScenario } from "./completeShutdownScenario.ts";

const report = await Effect.runPromise(completeShutdownScenario);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
