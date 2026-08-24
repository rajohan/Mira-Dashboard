/** One disallowed message found in test-process output. */
export interface TestOutputViolation {
    readonly description: string;
}

interface TestOutputRule extends TestOutputViolation {
    readonly pattern: RegExp;
}

const testOutputRules: readonly TestOutputRule[] = Object.freeze([
    {
        description: "React update was not wrapped in act(...)",
        pattern: /not wrapped in act/i,
    },
    {
        description: "React act environment is not configured",
        pattern: /current testing environment is not configured to support act/i,
    },
    {
        description: "Headless UI Web Animations test shim is missing",
        pattern: /Headless UI has polyfilled `Element\.prototype\.getAnimations`/i,
    },
    {
        description: "Bun main thread panicked",
        pattern: /panic\(main thread\):/i,
    },
    {
        description: "Bun crashed",
        pattern: /oh no: Bun has crashed/i,
    },
]);

const retainedOutputTailCharacters = 256;

/**
 * Finds a warning or runtime failure that is forbidden in otherwise passing test output.
 * @param output Decoded stdout or stderr text.
 * @returns The first matched policy violation, if any.
 */
export function findTestOutputViolation(output: string): TestOutputViolation | undefined {
    const rule = testOutputRules.find((candidate) => candidate.pattern.test(output));
    return rule === undefined ? undefined : { description: rule.description };
}

/**
 * Incrementally checks one continuous output stream without retaining the full test log.
 * A small tail preserves matches split across adjacent stream chunks.
 */
export class TestOutputInspector {
    #tail = "";
    #violation: TestOutputViolation | undefined;

    /** @returns First violation found in this stream. */
    get violation(): TestOutputViolation | undefined {
        return this.#violation;
    }

    /**
     * Adds the next decoded output chunk to the policy check.
     * @param chunk Text from one continuous process-output stream.
     */
    inspect(chunk: string): void {
        if (this.#violation !== undefined || chunk.length === 0) return;

        const candidate = this.#tail + chunk;
        this.#violation = findTestOutputViolation(candidate);
        this.#tail = candidate.slice(-retainedOutputTailCharacters);
    }
}
