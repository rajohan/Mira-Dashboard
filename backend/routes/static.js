// Static files & SPA routes
const path = require("path");

module.exports = function(app, frontendPath) {
    const express = require("express");
    app.use(express.static(frontendPath));

    app.get("*", (req, res) => {
        res.sendFile(path.join(frontendPath, "index.html"));
    });
};
