import express from "express";
import fs from "fs";
import fsp from "fs/promises";
import path from "path";

/** Registers static API routes. */
export default function staticRoutes(
    app: express.Application,
    frontendPath: string
): void {
    // Check if frontend build exists
    const indexExists = fs.existsSync(path.join(frontendPath, "index.html"));

    if (indexExists) {
        // Serve static files. Avoid stale dashboard bundles during active development;
        // hashed asset names still keep payloads stable, but the browser must revalidate
        // so chat capability fixes land immediately after a shouldDeploy/restart.
        app.use(
            express.static(frontendPath, {
                index: false,
                setHeaders: (response) => {
                    response.setHeader("Cache-Control", "no-store");
                },
            })
        );

        app.get(/^(?!\/api(?:\/|$)).*\.[\da-z]+$/i, async (request, response, next) => {
            if (
                request.path.includes("/") &&
                request.path !== `/${path.basename(request.path)}`
            ) {
                next();
                return;
            }

            const assetPath = path.join(
                frontendPath,
                "assets",
                path.basename(request.path)
            );
            try {
                const stat = await fsp.stat(assetPath);
                if (!stat.isFile()) {
                    response.status(404).type("text/plain").send("Not found");
                    return;
                }
            } catch {
                response.status(404).type("text/plain").send("Not found");
                return;
            }

            response.setHeader("Cache-Control", "no-store");
            response.sendFile(assetPath, (error) => {
                if (!error) {
                    return;
                }

                console.error("[Static] Error serving asset:", error.message);
                response.status(500).type("text/plain").send("Error loading asset");
            });
        });

        // SPA fallback - serve index.html for app routes, but never for asset/file
        // requests. Browsers enforce module MIME types, so a missing JS chunk must
        // be a 404 instead of index.html.
        app.get(/^(?!\/api(?:\/|$)).*/, (request, response) => {
            if (request.path.startsWith("/assets/") || path.extname(request.path)) {
                response.status(404).type("text/plain").send("Not found");
                return;
            }

            const indexPath = path.join(frontendPath, "index.html");
            response.setHeader("Cache-Control", "no-store");
            response.sendFile(indexPath, (error) => {
                if (!error) {
                    return;
                }

                console.error("[Static] Error serving index.html:", error.message);
                response.status(500).send("Error loading application");
            });
        });
    } else {
        // Frontend not built - serve a placeholder
        app.get(/^(?!\/api(?:\/|$)).*/, (_request, response) => {
            response.status(503).send(`
                <html>
                <head><title>Mira Dashboard - Not Built</title></head>
                <body style="font-family: system-ui; padding: 2rem; background: #1a1a2e; color: #eee;">
                    <h1>🚧 Frontend Not Built</h1>
                    <p>Run <code style="background: #333; padding: 2px 6px; border-radius: 4px;">bun run build</code> in the frontend directory.</p>
                    <p style="color: #888; margin-top: 2rem;">
                        Backend API is available at <code style="background: #333; padding: 2px 6px;">/api/*</code>
                    </p>
                </body>
                </html>
            `);
        });
    }
}
