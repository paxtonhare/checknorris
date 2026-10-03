// Dashboard: one page listing PRs and their latest review, one page per PR, a re-run button.
// No auth: bind to localhost and expose over Tailscale (tailscale serve) or another private network.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { config, db } from "./common.ts";
import { LABEL } from "./review.ts";

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const ago = (iso?: string) => { if (!iso) return ""; const m = (Date.now() - Date.parse(iso)) / 60_000; return m < 60 ? `${m | 0}m` : m < 1440 ? `${(m / 60) | 0}h` : `${(m / 1440) | 0}d`; };
const score = (r: any) => r?.score == null ? "" : `<b class="s${r.score}">${r.score}/5</b> <span class="mute">${LABEL[r.score]}</span>${r.approved ? " ✓" : ""}`;

const page = (title: string, body: string) => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${esc(title)} · Check Norris</title><link rel="icon" href="/icon.png">
<style>
:root{color-scheme:light dark;--fg:#1a1a1a;--bg:#fff;--mute:#777;--line:#ddd;--ok:#1a7f37;--warn:#9a6700;--bad:#cf222e}
@media(prefers-color-scheme:dark){:root{--fg:#e6e6e6;--bg:#111;--mute:#999;--line:#333;--ok:#3fb950;--warn:#d29922;--bad:#f85149}}
body{font:15px/1.5 system-ui,sans-serif;color:var(--fg);background:var(--bg);margin:0 auto;max-width:1000px;padding:1rem}
a{color:inherit}table{width:100%;border-collapse:collapse}td,th{text-align:left;padding:.4rem .5rem;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--mute);font-weight:500}.mute{color:var(--mute)}.s5{color:var(--ok)}.s4{color:var(--ok)}.s3{color:var(--warn)}.s2,.s1{color:var(--bad)}
pre,.body{white-space:pre-wrap;word-break:break-word;background:color-mix(in srgb,var(--fg) 5%,transparent);padding:.6rem .8rem;border-radius:6px}
button{font:inherit;padding:.3rem .7rem;cursor:pointer}h1{font-size:1.3rem}h2{font-size:1.1rem;margin-top:2rem}.c{margin:.6rem 0 .6rem 1rem}
</style><h1 style="display:flex;align-items:center;gap:.6rem"><img src="/icon.png" width="36" height="36" alt="" style="border-radius:8px"><a href="/" style="text-decoration:none">Check Norris</a> <span class="mute" style="font-weight:400;font-size:.9rem">${esc(config.llm.model)}</span></h1>${body}`;

function index() {
  const prs = db.prepare(`SELECT p.*, r.score, r.approved, r.created_at reviewed_at, r.seconds, r.tokens_in, r.tokens_out,
    (SELECT COUNT(*) FROM reviews x WHERE x.repo=p.repo AND x.number=p.number) runs
    FROM prs p LEFT JOIN reviews r ON r.id = (SELECT MAX(id) FROM reviews WHERE repo=p.repo AND number=p.number AND kind='review')
    ORDER BY p.state='open' DESC, COALESCE(r.created_at, p.updated_at) DESC LIMIT 200`).all() as any[];
  const t = db.prepare("SELECT COUNT(*) n, COALESCE(SUM(tokens_in),0) tin, COALESCE(SUM(tokens_out),0) tout FROM reviews WHERE created_at > datetime('now','-1 day')").get() as any;
  const rows = prs.map((p) => `<tr><td>${esc(p.state)}</td><td><a href="/pr/${esc(p.repo)}/${p.number}">${esc(p.repo)}#${p.number}</a><br><span class="mute">${esc(p.title)}</span></td>
    <td>${score(p)}</td><td class="mute">${p.reviewed_sha === p.head_sha ? "reviewed" : p.failed_sha === p.head_sha ? `failed ×${p.failures}` : "pending"}</td>
    <td class="mute">${ago(p.reviewed_at)}</td><td class="mute">${p.runs || ""}</td></tr>`).join("");
  return page("PRs", `<p class="mute">Last 24h: ${t.n} runs, ${t.tin.toLocaleString()} in / ${t.tout.toLocaleString()} out tokens.</p>
    <table><tr><th>State</th><th>PR</th><th>Score</th><th>Head</th><th>Reviewed</th><th>Runs</th></tr>${rows || "<tr><td colspan=6 class=mute>Nothing yet.</td></tr>"}</table>`);
}

function pr(repo: string, number: number) {
  const p: any = db.prepare("SELECT * FROM prs WHERE repo=? AND number=?").get(repo, number);
  if (!p) return null;
  const runs = db.prepare("SELECT * FROM reviews WHERE repo=? AND number=? ORDER BY id DESC").all(repo, number) as any[];
  const mentions = db.prepare("SELECT * FROM mentions WHERE repo=? AND number=? ORDER BY id DESC").all(repo, number) as any[];
  const run = (r: any) => `<h2>${r.kind} · ${score(r)} <span class="mute" style="font-weight:400;font-size:.85rem">${esc(r.head_sha.slice(0, 7))} · ${esc(r.model)} · ${r.seconds?.toFixed(0)}s · ${r.tokens_in?.toLocaleString()} in / ${r.tokens_out?.toLocaleString()} out · ${ago(r.created_at)} ago</span></h2>
    <div class="body">${esc(r.summary)}</div>${r.rationale ? `<p><b>Why ${r.score}/5</b></p><div class="body">${esc(r.rationale)}</div>` : ""}${JSON.parse(r.comments || "[]").map((c: any) => `<div class="c"><b>${esc(c.severity)}</b> <code>${esc(c.path)}:${c.line}</code><br>${esc(c.body)}</div>`).join("")}`;
  return page(`${repo}#${number}`, `<p><a href="${esc(p.url)}">${esc(repo)}#${number}</a> ${esc(p.title)} <span class="mute">by ${esc(p.author)} · ${esc(p.state)} · head ${esc(p.head_sha.slice(0, 7))}
    ${p.reviewed_sha === p.head_sha ? "reviewed" : p.failed_sha === p.head_sha ? `failed ×${p.failures}` : "pending"}</span>
    <form method="post" action="/rerun" style="display:inline"><input type="hidden" name="repo" value="${esc(repo)}"><input type="hidden" name="number" value="${number}"><button>Re-run review</button></form></p>
    ${mentions.length ? `<h2>Mentions</h2>${mentions.map((m) => `<div class="c"><b>${esc(m.author)}</b> <span class="mute">${esc(m.kind)} · ${m.handled === 1 ? "replied" : m.handled <= -3 ? "gave up" : "pending"}</span><br>${esc(m.body)}</div>`).join("")}` : ""}
    ${runs.map(run).join("") || "<p class=mute>No runs yet.</p>"}`);
}

export function serve() {
  const port = config.port ?? 3940;
  http.createServer(async (req, res) => {
    const url = new URL(req.url!, "http://x");
    const send = (code: number, html: string | null, headers: Record<string, string> = {}) => { res.writeHead(code, { "content-type": "text/html; charset=utf-8", ...headers }); res.end(html); };
    if (req.method === "GET" && url.pathname === "/") return send(200, index());
    if (req.method === "GET" && url.pathname === "/icon.png") { res.writeHead(200, { "content-type": "image/png", "cache-control": "max-age=86400" }); return res.end(fs.readFileSync(path.join(import.meta.dirname, "icon.png"))); }
    const m = url.pathname.match(/^\/pr\/([^/]+\/[^/]+)\/(\d+)$/);
    if (req.method === "GET" && m) { const html = pr(m[1], Number(m[2])); return html ? send(200, html) : send(404, "not found"); }
    if (req.method === "POST" && url.pathname === "/rerun") {
      let body = ""; for await (const chunk of req) body += chunk;
      const f = new URLSearchParams(body), repo = f.get("repo")!, number = Number(f.get("number"));
      db.prepare("UPDATE prs SET reviewed_sha=NULL, failed_sha=NULL, failures=0 WHERE repo=? AND number=?").run(repo, number);
      return send(303, null, { location: `/pr/${repo}/${number}` });
    }
    send(404, "not found");
  }).listen(port, "127.0.0.1", () => console.log(`dashboard on http://127.0.0.1:${port}`));
}
