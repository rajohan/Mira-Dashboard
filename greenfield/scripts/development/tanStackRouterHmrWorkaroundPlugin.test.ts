import { describe, expect, test } from "bun:test";

import { applyTanStackRouterHmrWorkaround } from "./tanStackRouterHmrWorkaroundPlugin.ts";

const upstreamPrototypeSetup = `
let replaceRouteChunk;
let refreshClientRouteCalls = 0;
class RouterCore {
    latestLocationUpdates = 0;
    updateLatestLocation() {
        this.latestLocationUpdates += 1;
    }
}
if (process.env.NODE_ENV !== "production") {
\tRouterCore.prototype._replaceRouteChunk = replaceRouteChunk;
\tRouterCore.prototype._refreshRoute = async function() {
\t\tthis._serverResult = void 0;
\t\tthis.updateLatestLocation();
\t\tawait refreshClientRoute(this);
\t};
}
replaceRouteChunk = (...args) => replaceRouteChunkCalls.push(args);
async function refreshClientRoute() {
    refreshClientRouteCalls += 1;
}
const replaceRouteChunkCalls = [];
export { RouterCore, refreshClientRouteCalls, replaceRouteChunkCalls };
`;

interface RouterFixtureModule {
    readonly RouterCore: new () => {
        readonly _refreshRoute: () => Promise<void>;
        readonly _replaceRouteChunk: (...arguments_: unknown[]) => void;
        readonly latestLocationUpdates: number;
    };
    readonly refreshClientRouteCalls: number;
    readonly replaceRouteChunkCalls: readonly (readonly unknown[])[];
}

async function importFixture(source: string): Promise<RouterFixtureModule> {
    const encoded = Buffer.from(source).toString("base64");
    return (await import(
        `data:text/javascript;base64,${encoded}`
    )) as RouterFixtureModule;
}

describe("TanStack Router Bun HMR workaround", () => {
    test("defers route-chunk replacement and full-reloads route HMR", async () => {
        const originalLocation = Object.getOwnPropertyDescriptor(globalThis, "location");
        let reloadCalls = 0;
        Object.defineProperty(globalThis, "location", {
            configurable: true,
            value: {
                reload: () => {
                    reloadCalls += 1;
                },
            },
        });

        try {
            const transformed = applyTanStackRouterHmrWorkaround(upstreamPrototypeSetup);
            const fixture = await importFixture(transformed);
            const router = new fixture.RouterCore();

            router._replaceRouteChunk("route", "lazy");
            await router._refreshRoute();

            expect(fixture.replaceRouteChunkCalls).toEqual([["route", "lazy"]]);
            expect(fixture.refreshClientRouteCalls).toBe(0);
            expect(router.latestLocationUpdates).toBe(0);
            expect(reloadCalls).toBe(1);
        } finally {
            if (originalLocation === undefined) {
                Reflect.deleteProperty(globalThis, "location");
            } else {
                Object.defineProperty(globalThis, "location", originalLocation);
            }
        }
    });

    test("is idempotent across incremental development rebuilds", () => {
        const transformed = applyTanStackRouterHmrWorkaround(upstreamPrototypeSetup);

        expect(applyTanStackRouterHmrWorkaround(transformed)).toBe(transformed);
    });

    test.each([
        {
            implementationName: "_replaceRouteChunk",
            source: upstreamPrototypeSetup.replace(
                "\tRouterCore.prototype._replaceRouteChunk = replaceRouteChunk;",
                "\tRouterCore.prototype._replaceRouteChunk = replacement;"
            ),
        },
        {
            implementationName: "_refreshRoute",
            source: upstreamPrototypeSetup.replace(
                "\t\tawait refreshClientRoute(this);",
                "\t\tawait refreshRoutes(this);"
            ),
        },
    ])(
        "fails closed when upstream $implementationName drifts",
        ({ source, implementationName }) => {
            expect(() => applyTanStackRouterHmrWorkaround(source)).toThrow(
                `Unsupported @tanstack/router-core ${implementationName} implementation`
            );
        }
    );
});
