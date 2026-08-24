import { Effect } from "effect";

import { completeShutdownQualification } from "./completeShutdownQualification.ts";

const report = await Effect.runPromise(completeShutdownQualification);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
