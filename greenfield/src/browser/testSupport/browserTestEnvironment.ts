import { GlobalRegistrator } from "@happy-dom/global-registrator";

interface BrowserTestEnvironmentLease {
    /** Releases this test module's ownership of the shared browser environment. */
    readonly release: () => Promise<void>;
}

let activeLeases = 0;
let ownsRegisteredEnvironment = false;
let previousActEnvironment: unknown;
let previouslyHadActEnvironment = false;
let environmentTransition: Promise<unknown> = Promise.resolve();

async function serializeEnvironmentTransition<Result>(
    transition: () => Result | Promise<Result>
): Promise<Result> {
    const result = environmentTransition.then(transition, transition);
    environmentTransition = result.then(
        () => null,
        () => null
    );
    return result;
}

/**
 * Acquires a reference-counted Happy DOM environment for browser tests.
 * @returns A lease that restores globals after the last local owner releases it.
 */
export async function acquireBrowserTestEnvironment(): Promise<BrowserTestEnvironmentLease> {
    await serializeEnvironmentTransition(() => {
        if (activeLeases === 0) {
            ownsRegisteredEnvironment = globalThis.document === undefined;
            if (ownsRegisteredEnvironment) {
                GlobalRegistrator.register({ url: "https://dashboard.test/" });
            }
            previouslyHadActEnvironment = Object.hasOwn(
                globalThis,
                "IS_REACT_ACT_ENVIRONMENT"
            );
            previousActEnvironment = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
            Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
        }
        activeLeases += 1;
    });
    let released = false;

    return {
        release: async () => {
            if (released) return;
            released = true;
            await serializeEnvironmentTransition(async () => {
                activeLeases -= 1;
                if (activeLeases !== 0) return;

                if (previouslyHadActEnvironment) {
                    Reflect.set(
                        globalThis,
                        "IS_REACT_ACT_ENVIRONMENT",
                        previousActEnvironment
                    );
                } else {
                    Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
                }
                if (ownsRegisteredEnvironment) await GlobalRegistrator.unregister();
                ownsRegisteredEnvironment = false;
                previousActEnvironment = undefined;
                previouslyHadActEnvironment = false;
            });
        },
    };
}
