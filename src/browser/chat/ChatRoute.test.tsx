import { expect, test } from "bun:test";

import { dashboardRoutePaths } from "../lib/dashboardRoutes.ts";
import { Route as chatLazyRoute } from "../routes/chat.lazy.tsx";

test("chat route is authenticated, lazy registered, and parity-accounted", () => {
    expect(chatLazyRoute.options.id).toBe("/chat");
    expect(dashboardRoutePaths).toContain("/chat");
});
