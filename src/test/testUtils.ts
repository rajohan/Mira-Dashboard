import { jest, type Mock } from "bun:test";

const originalGlobals = new Map<PropertyKey, PropertyDescriptor | undefined>();

export function resetStubbedGlobals(): void {
    for (const [name, descriptor] of originalGlobals) {
        if (descriptor) {
            Object.defineProperty(globalThis, name, descriptor);
        } else {
            Reflect.deleteProperty(globalThis, name);
        }
    }
    originalGlobals.clear();
}

export function stubGlobal(name: PropertyKey, value: unknown): void {
    if (!originalGlobals.has(name)) {
        originalGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    }
    Object.defineProperty(globalThis, name, {
        configurable: true,
        value,
        writable: true,
    });
}

export function unstubAllGlobals(): void {
    resetStubbedGlobals();
}

export function mocked<T extends (...arguments_: never[]) => unknown>(value: T): Mock<T> {
    return value as unknown as Mock<T>;
}

export function hoisted<T>(factory: () => T): T {
    return factory();
}

export async function advanceTimersByTimeAsync(milliseconds: number): Promise<void> {
    jest.advanceTimersByTime(milliseconds);
    await Promise.resolve();
}
