// Moltbook API routes
const https = require("https");

const MOLTBOOK_API = "https://www.moltbook.com/api/v1";

function moltbookGet(endpoint, res) {
    https
        .get(
            MOLTBOOK_API + endpoint,
            {
                headers: { Authorization: "Bearer " + process.env.MOLTBOOK_API_KEY },
            },
            (moltRes) => {
                let data = "";
                moltRes.on("data", (chunk) => (data += chunk));
                moltRes.on("end", () => {
                    try {
                        res.json(JSON.parse(data));
                    } catch {
                        res.status(500).json({ error: "Invalid JSON from Moltbook" });
                    }
                });
            }
        )
        .on("error", (e) => res.status(500).json({ error: e.message }));
}

module.exports = function (app) {
    app.get("/api/moltbook/home", async (req, res) => moltbookGet("/home", res));

    app.get("/api/moltbook/feed", async (req, res) => {
        const sort = req.query.sort || "hot";
        const limit = req.query.limit || 25;
        moltbookGet("/feed?sort=" + sort + "&limit=" + limit, res);
    });

    app.get("/api/moltbook/profile", async (req, res) =>
        moltbookGet("/agents/profile?name=mira_2026", res)
    );

    app.get("/api/moltbook/my-posts", async (req, res) => {
        https
            .get(
                MOLTBOOK_API + "/agents/profile?name=mira_2026",
                {
                    headers: { Authorization: "Bearer " + process.env.MOLTBOOK_API_KEY },
                },
                (moltRes) => {
                    let data = "";
                    moltRes.on("data", (chunk) => (data += chunk));
                    moltRes.on("end", () => {
                        try {
                            const json = JSON.parse(data);
                            res.json({
                                posts: json.recentPosts || [],
                                comments: json.recentComments || [],
                            });
                        } catch {
                            res.status(500).json({ error: "Invalid JSON" });
                        }
                    });
                }
            )
            .on("error", (e) => res.status(500).json({ error: e.message }));
    });
};
