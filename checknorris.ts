// checknorris: polls GitHub for PRs that need a review or have new @mentions.
// Usage: node checknorris.ts          poll forever (config.pollSeconds, default 60)
//        node checknorris.ts once     one poll tick (reviews and replies included), exit
//        node checknorris.ts review <owner/repo> <number>   review one PR now
//        node checknorris.ts list     print tracked PRs and unhandled mentions
import { createSign } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { bot, config, db, type Gh } from "./common.ts";
import { replyToMention, reviewPr } from "./review.ts";

const root = import.meta.dirname;
const api = "https://api.github.com";

// --- GitHub App auth ---
function appJwt() {
  const pem = fs.readFileSync(path.join(root, config.privateKey), "utf8");
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const head = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({ iat: now - 60, exp: now + 540, iss: config.appId })}`;
  return `${head}.${createSign("RSA-SHA256").update(head).sign(pem, "base64url")}`;
}

export function client(auth: () => Promise<string>): Gh {
  return async (p, init) => {
    const r = await fetch(p.startsWith("http") ? p : api + p, {
      ...init,
      headers: { authorization: await auth(), accept: "application/vnd.github+json", "user-agent": "checknorris", ...init?.headers },
    });
    if (!r.ok) throw new Error(`${init?.method ?? "GET"} ${p}: ${r.status} ${await r.text()}`);
    return r.status === 204 ? null : r.headers.get("content-type")?.includes("json") ? r.json() : r.text();
  };
}

const appClient = client(async () => `Bearer ${appJwt()}`);
const tokens = new Map<number, { token: string; exp: number }>();
// Token is re-checked on every call, so a batch or a single long review can outlive the hour-long installation token.
async function installationToken(inst: any) {
  let t = tokens.get(inst.id);
  if (!t || t.exp < Date.now() + 60_000) {
    const r = await appClient(inst.access_tokens_url, { method: "POST" });
    t = { token: r.token, exp: Date.parse(r.expires_at) };
    tokens.set(inst.id, t);
  }
  return t.token;
}
function installationClient(inst: any): { gh: Gh; token: () => Promise<string> } {
  const token = () => installationToken(inst);
  return { gh: client(async () => `token ${await token()}`), token };
}

// --- polling ---
export type Work = { repo: string; reviews: { repo: string; number: number; head_sha: string }[]; mentions: { id: number; repo: string; number: number; kind: string; author: string; body: string }[] };

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
    // ponytail: up to 3 attempts per head, then give up until the next push (or a re-run); no transient/permanent classification.
    if (row?.reviewed_sha !== pr.head.sha && !(row?.failed_sha === pr.head.sha && row.failures >= 3)) work.reviews.push({ repo, number: pr.number, head_sha: pr.head.sha });
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
    const ins = db.prepare("INSERT OR IGNORE INTO mentions (id, repo, number, kind, author, body, url, created_at) VALUES (?,?,?,?,?,?,?,?)")
      .run(c.id, repo, number, c.kind, c.user.login, c.body, c.html_url, c.created_at);
    if (ins.changes) work.mentions.push({ id: c.id, repo, number, kind: c.kind, author: c.user.login, body: c.body });
  }
  db.prepare("UPDATE prs SET comments_since=? WHERE repo=? AND number=?").run(latest, repo, number);
}

export async function poll(handle: (gh: Gh, token: () => Promise<string>, work: Work) => Promise<void>) {
  for (const inst of await appClient("/app/installations")) {
    const { gh, token } = installationClient(inst);
    for (const r of (await gh("/installation/repositories?per_page=100")).repositories) {
      const work: Work = { repo: r.full_name, reviews: [], mentions: [] };
      await scanRepo(gh, r.full_name, work).then(() => handle(gh, token, work)).catch((e) => console.error(`${r.full_name}: ${e.message}`));
    }
  }
}

export async function forRepo(repo: string): Promise<{ gh: Gh; token: () => Promise<string> }> {
  for (const inst of await appClient("/app/installations")) {
    const c = installationClient(inst);
    if ((await c.gh("/installation/repositories?per_page=100")).repositories.some((r: any) => r.full_name === repo)) return c;
  }
  throw new Error(`app not installed on ${repo}`);
}

const log = (s: string) => console.log(`${new Date().toISOString()} ${s}`);
async function printWork(_gh: Gh, _token: unknown, w: Work) {
  for (const r of w.reviews) log(`review   ${r.repo}#${r.number} @ ${r.head_sha.slice(0, 7)}`);
  for (const m of w.mentions) log(`mention  ${m.repo}#${m.number} ${m.author} (${m.kind}): ${m.body.split("\n")[0].slice(0, 80)}`);
}
async function doWork(gh: Gh, token: () => Promise<string>, w: Work) {
  await printWork(gh, token, w);
  for (const r of w.reviews) {
    await reviewPr(gh, token, r.repo, r.number)
      .then((o) => log(`reviewed ${r.repo}#${r.number}: ${o.score}/5${o.approved ? " approved" : ""}, ${o.comments} comments, ${o.seconds.toFixed(0)}s`))
      .catch((e) => { log(`review failed ${r.repo}#${r.number}: ${e.message}`); if (!/\b401\b/.test(e.message)) db.prepare("UPDATE prs SET failures=CASE WHEN failed_sha=? THEN failures+1 ELSE 1 END, failed_sha=? WHERE repo=? AND number=?").run(r.head_sha, r.head_sha, r.repo, r.number); });
  }
  // From the DB, not w.mentions: a mention scanned by `once` or before a crash is still owed a reply.
  for (const m of db.prepare("SELECT id, repo, number, kind, author, body FROM mentions WHERE repo=? AND handled<=0 AND handled>-3").all(w.repo) as Work["mentions"]) {
    await replyToMention(gh, token, m)
      .then(() => log(`replied  ${m.repo}#${m.number} to ${m.author}`))
      .catch((e) => { log(`reply failed ${m.repo}#${m.number}: ${e.message}`); if (!/\b401\b/.test(e.message)) db.prepare("UPDATE mentions SET handled=handled-1 WHERE id=?").run(m.id); }); // handled: 1 done, 0..-2 pending, -3 given up
  }
}

if (import.meta.main) {
  const cmd = process.argv[2] ?? "loop";
  if (cmd === "list") {
    for (const p of db.prepare("SELECT * FROM prs ORDER BY state, repo, number").all() as any[])
      console.log(`${p.state.padEnd(6)} ${p.repo}#${p.number} ${p.head_sha.slice(0, 7)} ${p.reviewed_sha === p.head_sha ? "reviewed" : p.failed_sha === p.head_sha ? `failed×${p.failures}` : "pending "} ${p.title}`);
    for (const m of db.prepare("SELECT * FROM mentions WHERE handled=0").all() as any[])
      console.log(`mention ${m.repo}#${m.number} ${m.author}: ${m.body.split("\n")[0].slice(0, 80)}`);
  } else if (cmd === "once") {
    await poll(doWork);
  } else if (cmd === "review") {
    const [repo, n] = process.argv.slice(3);
    const { gh, token } = await forRepo(repo);
    await doWork(gh, token, { repo, reviews: [{ repo, number: Number(n), head_sha: "" }], mentions: [] });
  } else {
    const every = (config.pollSeconds ?? 60) * 1000;
    while (true) {
      const started = Date.now();
      await poll(doWork).catch((e) => console.error(`poll: ${e.message}`));
      await new Promise((r) => setTimeout(r, Math.max(0, every - (Date.now() - started))));
    }
  }
}
