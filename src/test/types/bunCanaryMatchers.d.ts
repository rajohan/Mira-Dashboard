declare module "bun:test" {
    interface Matchers<T = unknown> {
        toContainEqual(expected: unknown): void;
        toEqual(expected: unknown): void;
    }

    /**
     * Bun Canary currently types asymmetric matchers as `any`. Narrowing the
     * public return type keeps strict linting useful without changing runtime.
     */
    interface AsymmetricMatchersBuiltin {
        any(
            constructor:
                | ((...arguments_: never[]) => unknown)
                | (new (...arguments_: never[]) => unknown)
        ): unknown;
        anything(): unknown;
        arrayContaining<E = unknown>(items: readonly E[]): unknown;
        closeTo(value: number, precision?: number): unknown;
        objectContaining(value: object): unknown;
        stringContaining(value: string): unknown;
        stringMatching(value: RegExp | string): unknown;
    }

    interface Expect {
        any(
            constructor:
                | ((...arguments_: never[]) => unknown)
                | (new (...arguments_: never[]) => unknown)
        ): unknown;
        anything(): unknown;
        arrayContaining<E = unknown>(items: readonly E[]): unknown;
        closeTo(value: number, precision?: number): unknown;
        objectContaining(value: object): unknown;
        stringContaining(value: string): unknown;
        stringMatching(value: RegExp | string): unknown;
    }
}
