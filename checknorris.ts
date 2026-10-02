// checknorris: polls GitHub for PRs that need a review or have new @mentions.
// Usage: node checknorris.ts          poll forever (config.pollSeconds, default 60)
//        node checknorris.ts once     one poll, print work, exit
//        node checknorris.ts list     print tracked PRs and unhandled mentions
import { createSign } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const root = import.meta.dirname;
export const config = JSON.parse(fs.readFileSync(path.join(root, "config.json"), "utf8"));
const bot = `${config.appSlug}[bot]`;
const api = "https://api.github.com";

export const db = new DatabaseSync(path.join(root, process.env.CHECKNORRIS_DB ?? config.db ?? "checknorris.db"));
db.exec(`
  CREATE TABLE IF NOT EXISTS prs (
    repo TEXT, number INTEGER, title TEXT, url TEXT, author TEXT, state TEXT,
    head_sha TEXT, updated_at TEXT, reviewed_sha TEXT, comments_since TEXT,
    PRIMARY KEY (repo, number));
  CREATE TABLE IF NOT EXISTS mentions (
    id INTEGER PRIMARY KEY, repo TEXT, number INTEGER, kind TEXT, author TEXT, body TEXT,
    url TEXT, created_at TEXT, handled INTEGER DEFAULT 0);
`);

export type Gh = (p: string, init?: RequestInit) => Promise<any>;

// --- GitHub App auth ---
function appJwt() {
  const pem = fs.readFileSync(path.join(root, config.privateKey), "utf8");
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const head = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({ iat: now - 60, exp: now + 540, iss: config.appId })}`;
  return `${head}.${createSign("RSA-SHA256").update(head).sign(pem, "base64url")}`;
}

export function client(auth: string): Gh {
  return async (p, init) => {
    const r = await fetch(p.startsWith("http") ? p : api + p, {
      ...init,
      headers: { authorization: auth, accept: "application/vnd.github+json", "user-agent": "checknorris", ...init?.headers },
    });
    if (!r.ok) throw new Error(`${init?.method ?? "GET"} ${p}: ${r.status} ${await r.text()}`);
    return r.status === 204 ? null : r.json();
  };
}

const tokens = new Map<number, { token: string; exp: number }>();
async function installationClient(inst: any): Promise<Gh> {
  let t = tokens.get(inst.id);
  if (!t || t.exp < Date.now() + 60_000) {
    const r = await client(`Bearer ${appJwt()}`)(inst.access_tokens_url, { method: "POST" });
    t = { token: r.token, exp: Date.parse(r.expires_at) };
    tokens.set(inst.id, t);
  }
  return client(`token ${t.token}`);
}

// --- polling ---
export type Work = { reviews: { repo: string; number: number; head_sha: string }[]; mentions: any[] };

const isMention = (body: string) => new RegExp(`(^|\\W)@${config.appSlug}\\b`, "i").test(body ?? "");

export async function scanRepo(gh: Gh, repo: string, work: Work) {
  // ponytail: per_page=100, no pagination; >100 open PRs in one repo is not my life.
  const prs = await gh(`/repos/${repo}/pulls?state=open&per_page=100`);
  db.prepare(`UPDATE prs SET state='closed' WHERE repo=? AND state='open' AND number NOT IN (${prs.map(() => "?").join(",") || "-1"})`)
    .run(repo, ...prs.map((p: any) => p.number));
  for (const pr of prs) {
    const row: any = db.prepare("SELECT * FROM prs WHERE repo=? AND number=?").get(repo, pr.number);
    db.prepare(`INSERT INTO prs (repo, number, title, url, author, state, head_sha, updated_at, comments_since)
      VALUES (?,?,?,?,?,'open',?,?,?) ON CONFLICT(repo, number) DO UPDATE SET
      title=excluded.title, state='open', head_sha=excluded.head_sha, updated_at=excluded.updated_at`)
      .run(repo, pr.number, pr.title, pr.html_url, pr.user.login, pr.head.sha, pr.updated_at, row?.comments_since ?? pr.created_at);
    if (pr.draft) continue;
    if (row?.reviewed_sha !== pr.head.sha) work.reviews.push({ repo, number: pr.number, head_sha: pr.head.sha });
    if (!row || row.updated_at !== pr.updated_at) await scanComments(gh, repo, pr.number, row?.comments_since ?? pr.created_at, work);
  }
}

async function scanComments(gh: Gh, repo: string, number: number, since: string, work: Work) {
  const issue = await gh(`/repos/${repo}/issues/${number}/comments?since=${since}&per_page=100`);
  const review = await gh(`/repos/${repo}/pulls/${number}/comments?since=${since}&per_page=100`);
  let latest = since;
  for (const c of [...issue.map((c: any) => ({ ...c, kind: "issue" })), ...review.map((c: any) => ({ ...c, kind: "review" }))]) {
    if (c.created_at > latest) latest = c.created_at;
    if (c.created_at <= since || c.user.login === bot) continue;
    let addressed = isMention(c.body);
    if (!addressed && c.in_reply_to_id) {
      const parent = await gh(`/repos/${repo}/pulls/comments/${c.in_reply_to_id}`);
      addressed = parent.user.login === bot;
    }
    if (!addressed) continue;
    db.prepare("INSERT OR IGNORE INTO mentions (id, repo, number, kind, author, body, url, created_at) VALUES (?,?,?,?,?,?,?,?)")
      .run(c.id, repo, number, c.kind, c.user.login, c.body, c.html_url, c.created_at);
    work.mentions.push({ id: c.id, repo, number, kind: c.kind, author: c.user.login, body: c.body });
  }
  db.prepare("UPDATE prs SET comments_since=? WHERE repo=? AND number=?").run(latest, repo, number);
}

export async function poll(): Promise<Work> {
  const work: Work = { reviews: [], mentions: [] };
  for (const inst of await client(`Bearer ${appJwt()}`)("/app/installations")) {
    const gh = await installationClient(inst);
    for (const r of (await gh("/installation/repositories?per_page=100")).repositories) {
      await scanRepo(gh, r.full_name, work).catch((e) => console.error(`${r.full_name}: ${e.message}`));
    }
  }
  return work;
}

function printWork(w: Work) {
  for (const r of w.reviews) console.log(`review   ${r.repo}#${r.number} @ ${r.head_sha.slice(0, 7)}`);
  for (const m of w.mentions) console.log(`mention  ${m.repo}#${m.number} ${m.author} (${m.kind}): ${m.body.split("\n")[0].slice(0, 80)}`);
}

if (import.meta.main) {
  const cmd = process.argv[2] ?? "loop";
  if (cmd === "list") {
    for (const p of db.prepare("SELECT * FROM prs ORDER BY state, repo, number").all() as any[])
      console.log(`${p.state.padEnd(6)} ${p.repo}#${p.number} ${p.head_sha.slice(0, 7)} ${p.reviewed_sha === p.head_sha ? "reviewed" : "pending "} ${p.title}`);
    for (const m of db.prepare("SELECT * FROM mentions WHERE handled=0").all() as any[])
      console.log(`mention ${m.repo}#${m.number} ${m.author}: ${m.body.split("\n")[0].slice(0, 80)}`);
  } else if (cmd === "once") {
    printWork(await poll());
  } else {
    const every = (config.pollSeconds ?? 60) * 1000;
    while (true) {
      const started = Date.now();
      await poll().then(printWork, (e) => console.error(`poll: ${e.message}`));
      await new Promise((r) => setTimeout(r, Math.max(0, every - (Date.now() - started))));
    }
  }
}
