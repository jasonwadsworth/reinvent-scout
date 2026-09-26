// Synthetic fixture -- a plain HTTP server with no cloud-provider dependency of any kind.
const express = require("express");

const app = express();

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

app.listen(3000);
