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

describe("TanStack Router Bun HMR workaround", () => {
    test("defers route-chunk replacement and full-reloads route HMR", () => {
        const transformed = applyTanStackRouterHmrWorkaround(upstreamPrototypeSetup);

        expect(transformed).toContain(
            "RouterCore.prototype._replaceRouteChunk = (...args) => replaceRouteChunk(...args);"
        );
        expect(transformed).toContain("globalThis.location.reload();");
        expect(transformed).not.toContain(
            "RouterCore.prototype._replaceRouteChunk = replaceRouteChunk;"
        );
        expect(transformed).not.toContain("await refreshClientRoute(this);");
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
