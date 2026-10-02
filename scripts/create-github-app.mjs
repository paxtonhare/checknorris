#!/usr/bin/env node
// Creates the checknorris GitHub App via GitHub's manifest flow and writes config.json + the private key.
// Usage: node scripts/create-github-app.mjs [app-name] [--org ORG]
// Opens one page; you click "Create GitHub App"; GitHub redirects back here with a code we exchange.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const org = args.includes("--org") ? args[args.indexOf("--org") + 1] : null;
const name = args.find((a) => !a.startsWith("--") && a !== org) ?? "checknorrisbot";
const port = 3939;
const configPath = path.join(root, "config.json");
const pemPath = path.join(root, `${name}.pem`);

const manifest = {
  name,
  url: "https://github.com/paxtonhare/checknorris",
  description: "Self-hosted AI PR reviewer",
  public: false,
  redirect_url: `http://localhost:${port}/callback`,
  default_permissions: { pull_requests: "write", contents: "read", statuses: "write", metadata: "read" },
  default_events: [],
};
const target = org ? `https://github.com/organizations/${org}/settings/apps/new` : "https://github.com/settings/apps/new";

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${port}`);
  if (url.pathname === "/") {
    res.setHeader("content-type", "text/html");
    res.end(`<form id="f" method="post" action="${target}"><input type="hidden" name="manifest" value='${JSON.stringify(manifest).replaceAll("'", "&#39;")}'><button>Continue to GitHub</button></form><script>document.getElementById("f").submit()</script>`);
    return;
  }
  if (url.pathname === "/callback") {
    const code = url.searchParams.get("code");
    const r = await fetch(`https://api.github.com/app-manifests/${code}/conversions`, { method: "POST", headers: { accept: "application/vnd.github+json" } });
    if (!r.ok) { res.statusCode = 500; res.end(`conversion failed: ${r.status} ${await r.text()}`); return; }
    const app = await r.json();
    fs.writeFileSync(pemPath, app.pem, { mode: 0o600 });
    const existing = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, "utf8")) : {};
    fs.writeFileSync(configPath, JSON.stringify({ ...existing, appId: app.id, appSlug: app.slug, privateKey: path.basename(pemPath) }, null, 2) + "\n");
    res.setHeader("content-type", "text/html");
    res.end(`<h1>Created ${app.slug} (id ${app.id})</h1><p>Wrote ${configPath} and ${pemPath}.</p><p>Next: <a href="https://github.com/apps/${app.slug}/installations/new">install it on your repos</a>.</p>`);
    console.log(`created app ${app.slug} id=${app.id}; wrote ${configPath}, ${pemPath}`);
    setTimeout(() => server.close(), 500);
    return;
  }
  res.statusCode = 404; res.end();
});
server.listen(port, "127.0.0.1", () => console.log(`open http://localhost:${port}/ in a browser where you're logged in to GitHub`));
