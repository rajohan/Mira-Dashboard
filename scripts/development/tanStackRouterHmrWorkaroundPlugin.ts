const routerCoreModuleFilter =
    /[/\\]node_modules[/\\]@tanstack[/\\]router-core[/\\]dist[/\\]esm[/\\]router\.js$/u;

const eagerReplaceRouteChunkAssignment =
    "\tRouterCore.prototype._replaceRouteChunk = replaceRouteChunk;";
const deferredReplaceRouteChunkAssignment =
    "\tRouterCore.prototype._replaceRouteChunk = (...args) => replaceRouteChunk(...args);";
const upstreamRefreshRouteImplementation = [
    "\tRouterCore.prototype._refreshRoute = async function() {",
    "\t\tthis._serverResult = void 0;",
    "\t\tthis.updateLatestLocation();",
    "\t\tawait refreshClientRoute(this);",
    "\t};",
].join("\n");
const reloadRefreshRouteImplementation = [
    "\tRouterCore.prototype._refreshRoute = async function() {",
    "\t\tglobalThis.location.reload();",
    "\t};",
].join("\n");

function replaceKnownImplementation(
    source: string,
    upstream: string,
    workaround: string,
    implementationName: string
): string {
    const upstreamIndex = source.indexOf(upstream);
    const workaroundIndex = source.indexOf(workaround);
    if (upstreamIndex === -1) {
        if (workaroundIndex !== -1) return source;
        throw new Error(
            `Unsupported @tanstack/router-core ${implementationName} implementation`
        );
    }
    if (
        workaroundIndex !== -1 ||
        source.includes(upstream, upstreamIndex + upstream.length)
    ) {
        throw new Error(
            `Ambiguous @tanstack/router-core ${implementationName} implementation`
        );
    }
    return source.replace(upstream, workaround);
}

/**
 * Applies the narrow development workaround for Bun's TanStack Router HMR cycle.
 * @param source Installed ESM router-core module source.
 * @returns Source with deferred lazy-route replacement and safe route refresh.
 */
export function applyTanStackRouterHmrWorkaround(source: string): string {
    const deferredSource = replaceKnownImplementation(
        source,
        eagerReplaceRouteChunkAssignment,
        deferredReplaceRouteChunkAssignment,
        "_replaceRouteChunk"
    );
    return replaceKnownImplementation(
        deferredSource,
        upstreamRefreshRouteImplementation,
        reloadRefreshRouteImplementation,
        "_refreshRoute"
    );
}

const tanStackRouterHmrWorkaroundPlugin: Bun.BunPlugin = {
    name: "tanstack-router-bun-hmr-workaround",
    target: "browser",
    setup(build) {
        build.onLoad(
            { filter: routerCoreModuleFilter, namespace: "file" },
            async ({ path }) => ({
                contents: applyTanStackRouterHmrWorkaround(await Bun.file(path).text()),
                loader: "js",
            })
        );
    },
};

export default tanStackRouterHmrWorkaroundPlugin;
