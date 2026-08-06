import { routes } from "../../backend/src/routes/registry.ts";

const httpMethods = new Set(["DELETE", "GET", "HEAD", "PATCH", "POST", "PUT"]);

interface RouteIdentity {
    readonly id: string;
    readonly method: "DELETE" | "GET" | "HEAD" | "PATCH" | "POST" | "PUT";
    readonly path: string;
}

const identities: RouteIdentity[] = [];
for (const [routePath, entry] of Object.entries(
    routes as Readonly<Record<string, unknown>>
)) {
    if (routePath === "/api/*") continue;
    if (!routePath.startsWith("/api/")) {
        throw new Error(`Legacy route registry contains an unexpected path ${routePath}`);
    }
    if (typeof entry !== "object" || entry === null || entry instanceof Response) {
        throw new Error(`Legacy API route ${routePath} has no explicit method table`);
    }
    const methods = Object.keys(entry);
    if (methods.length === 0 || methods.some((method) => !httpMethods.has(method))) {
        throw new Error(`Legacy API route ${routePath} has an unrecognized method table`);
    }
    for (const method of methods) {
        const typedMethod = method as RouteIdentity["method"];
        identities.push({
            id: `${typedMethod} ${routePath}`,
            method: typedMethod,
            path: routePath,
        });
    }
}

process.stdout.write(`${JSON.stringify(identities)}\n`);
