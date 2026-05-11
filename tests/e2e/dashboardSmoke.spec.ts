import { expect, test } from "@playwright/test";

const smokeRoutes = [
    { path: "/", title: "Dashboard" },
    { path: "/tasks", title: "Tasks" },
    { path: "/pull-requests", title: "PRs" },
    { path: "/settings", title: "Settings" },
];

test.describe("Mira Dashboard smoke tests", () => {
    test("backend health endpoint is reachable", async ({ request }) => {
        const response = await request.get("/api/health");
        await expect(response).toBeOK();
        await expect(await response.json()).toEqual(
            expect.objectContaining({ status: "ok" })
        );
    });

    for (const route of smokeRoutes) {
        test(`${route.title} page renders`, async ({ page }) => {
            await page.goto(route.path);

            await expect(
                page.getByRole("heading", { name: route.title }).first()
            ).toBeVisible();
            await expect(
                page.getByRole("navigation", { name: "Main navigation" })
            ).toBeVisible();
            await expect(page.getByRole("button", { name: "Log out" })).toBeVisible();
        });
    }

    test("primary navigation moves between critical pages", async ({ page }) => {
        await page.goto("/");
        await page.getByRole("link", { name: "Tasks" }).click();
        await expect(page).toHaveURL(/\/tasks$/u);
        await expect(page.getByRole("heading", { name: "Tasks" }).first()).toBeVisible();

        await page.getByRole("link", { name: "PRs" }).click();
        await expect(page).toHaveURL(/\/pull-requests$/u);
        await expect(page.getByRole("heading", { name: "PRs" }).first()).toBeVisible();
    });
});
