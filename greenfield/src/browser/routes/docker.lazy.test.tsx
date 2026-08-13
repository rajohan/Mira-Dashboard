import { expect, test } from "bun:test";

import { dashboardRoutePaths } from "../lib/dashboardRoutes.ts";
import { Route as dockerLazyRoute } from "./docker.lazy.tsx";

test("Docker route is authenticated, lazy registered, and parity-accounted", () => {
    expect(dockerLazyRoute.options.id).toBe("/docker");
    expect(dockerLazyRoute.options.component).toBeFunction();
    expect(dashboardRoutePaths).toContain("/docker");
});
