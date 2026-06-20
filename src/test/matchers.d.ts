import type { TestingLibraryMatchers } from "@testing-library/jest-dom/matchers";
import { expect } from "bun:test";

declare module "bun:test" {
    interface Matchers<T = unknown> extends TestingLibraryMatchers<
        typeof expect.stringContaining,
        T
    > {
        readonly __jestDomMatchersBrand?: never;
    }

    interface AsymmetricMatchers extends TestingLibraryMatchers<
        typeof expect.stringContaining,
        unknown
    > {
        readonly __jestDomAsymmetricMatchersBrand?: never;
    }
}
