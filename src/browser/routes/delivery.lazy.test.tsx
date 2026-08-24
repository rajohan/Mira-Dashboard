import { expect, test } from "bun:test";

import { dashboardNavigationItems } from "../layout/dashboardNavigation.ts";
import { dashboardRoutePaths } from "../lib/dashboardRoutes.ts";
import { Route as deliveryLazyRoute } from "./delivery.lazy.tsx";

test("Delivery route is authenticated, lazy registered, navigable, and parity-accounted", () => {
    expect(deliveryLazyRoute.options.id).toBe("/delivery");
    expect(deliveryLazyRoute.options.component).toBeFunction();
    expect(dashboardRoutePaths).toContain("/delivery");
    expect(dashboardNavigationItems).toContainEqual(
        expect.objectContaining({ label: "Delivery", to: "/delivery" })
    );
});
