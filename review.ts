// Review one PR (or answer one mention) with a read-only agent over a checkout, then post to GitHub.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { config, db, type Gh } from "./common.ts";

const root = import.meta.dirname;
const SEVERITY = { P0: "🛑 P0", P1: "⚠️ P1", P2: "💡 P2" } as const;

db.exec(`CREATE TABLE IF NOT EXISTS reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT, repo TEXT, number INTEGER, head_sha TEXT, kind TEXT, score INTEGER, approved INTEGER,
  summary TEXT, comments TEXT, model TEXT, tokens_in INTEGER, tokens_out INTEGER, seconds REAL, created_at TEXT)`);

// --- checkout ---
function git(dir: string, args: string[], token?: string) {
  const auth = token ? ["-c", `http.extraheader=AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`] : [];
  // GIT_CEILING_DIRECTORIES: never let git walk up out of checkouts/ into this repo (a failed clone leaves an empty dir).
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_CEILING_DIRECTORIES: path.join(root, "checkouts") };
  try {
    return execFileSync("git", [...auth, ...args], { cwd: dir, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 << 20 });
  } catch (e: any) {
    const msg = String(e.stderr || e.message).trim().slice(0, 300);
    throw new Error(`git ${args[0]}: ${/Authentication failed|HTTP 401|could not read Username/i.test(msg) ? "401 " : ""}${msg}`);
  }
}

// ponytail: one clone per repo, checked out in place; reviews run one at a time so no worktrees.
async function checkout(repo: string, sha: string, baseSha: string, getToken: () => Promise<string>) {
  const token = await getToken();
  const dir = path.join(root, "checkouts", repo.replace("/", "__"));
  if (!fs.existsSync(path.join(dir, ".git"))) {
    fs.mkdirSync(dir, { recursive: true });
    git(dir, ["clone", "--quiet", "--no-checkout", "--filter=blob:none", `https://github.com/${repo}.git`, "."], token);
  }
  git(dir, ["fetch", "--quiet", "origin", sha, baseSha], token);
  git(dir, ["checkout", "--quiet", "--force", "--detach", sha], token); // partial clone: checkout lazily fetches blobs
  return dir;
}

// --- tools ---
const tools = [
  { name: "read", description: "Read a file from the PR head checkout. Returns numbered lines.", parameters: { type: "object", properties: { path: { type: "string" }, start: { type: "integer", description: "1-based first line" }, end: { type: "integer" } }, required: ["path"] } },
  { name: "grep", description: "Search the checkout with git grep (extended regex). Returns path:line:text.", parameters: { type: "object", properties: { pattern: { type: "string" }, path: { type: "string", description: "optional directory or file to restrict" } }, required: ["pattern"] } },
  { name: "ls", description: "List tracked files under a directory.", parameters: { type: "object", properties: { path: { type: "string" } } } },
  { name: "done", description: "Finish. For a review: give the score, summary and findings. For a mention reply: give the reply text in summary.", parameters: { type: "object", properties: {
    score: { type: "integer", minimum: 1, maximum: 5 },
    summary: { type: "string", description: "Markdown. Short: what the PR does, overall assessment, anything not expressible as an inline comment." },
    comments: { type: "array", items: { type: "object", properties: { path: { type: "string" }, line: { type: "integer", description: "line number in the NEW file version; must be inside the diff" }, severity: { type: "string", enum: ["P0", "P1", "P2"] }, body: { type: "string" } }, required: ["path", "line", "severity", "body"] } },
  }, required: ["summary"] } },
].map((f) => ({ type: "function", function: f }));

function runTool(dir: string, name: string, a: any): string {
  const safe = (p = ".") => {
    // Reject anything that resolves (after symlinks) outside the checkout: a PR could add a symlink to ../../config.json.
    const r = path.resolve(dir, p), real = fs.existsSync(r) ? fs.realpathSync(r) : r;
    if (real !== dir && !real.startsWith(dir + path.sep)) throw new Error("path outside checkout");
    return path.relative(dir, r) || ".";
  };
  const cap = (s: string, n = 400) => { const l = s.split("\n"); return l.length > n ? l.slice(0, n).join("\n") + `\n… (${l.length - n} more lines)` : s; };
  try {
    if (name === "read") {
      const lines = fs.readFileSync(path.join(dir, safe(a.path)), "utf8").split("\n");
      const s = Math.max(1, a.start ?? 1), e = Math.min(lines.length, a.end ?? s + 399);
      return lines.slice(s - 1, e).map((l, i) => `${s + i}: ${l}`).join("\n");
    }
    if (name === "grep") return cap(git(dir, ["grep", "-n", "-I", "-E", a.pattern, "--", safe(a.path)])) || "(no matches)";
    if (name === "ls") return cap(git(dir, ["ls-files", "--", safe(a.path)])) || "(no files)";
  } catch (e: any) { return `error: ${(e.stderr || e.message || "").toString().trim().slice(0, 500)}`; }
  return `unknown tool ${name}`;
}

// --- agent ---
async function agent(dir: string, system: string, user: string) {
  const messages: any[] = [{ role: "system", content: system }, { role: "user", content: user }];
  let tokens_in = 0, tokens_out = 0;
  for (let turn = 0; turn < (config.maxTurns ?? 60); turn++) {
    if (process.env.DEBUG) console.error(`llm turn ${turn}, ${messages.length} messages`);
    const r = await fetch(`${config.llm.baseUrl}/chat/completions`, {
      method: "POST", signal: AbortSignal.timeout(600_000),
      headers: { authorization: `Bearer ${config.llm.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model: config.llm.model, messages, tools, tool_choice: "auto" }),
    });
    if (!r.ok) throw new Error(`llm: ${r.status} ${(await r.text()).slice(0, 300)}`);
    const d = await r.json();
    tokens_in += d.usage?.prompt_tokens ?? 0; tokens_out += d.usage?.completion_tokens ?? 0;
    const m = d.choices[0].message;
    messages.push(m);
    if (!m.tool_calls?.length) { messages.push({ role: "user", content: "Call the `done` tool to finish." }); continue; }
    for (const c of m.tool_calls) {
      const a = JSON.parse(c.function.arguments || "{}");
      if (c.function.name === "done") return { ...a, tokens_in, tokens_out };
      messages.push({ role: "tool", tool_call_id: c.id, content: runTool(dir, c.function.name, a) });
    }
  }
  throw new Error("agent hit maxTurns without calling done");
}

// Instructions come from the PR's base commit, not its head: a PR must not be able to rewrite its own reviewer's rules.
async function repoInstructions(dir: string, baseSha: string, getToken: () => Promise<string>) {
  const token = await getToken();
  for (const f of [".checknorris.md", "AGENTS.md", "CLAUDE.md"]) {
    try { return `\n\n# Repository instructions (${f})\n${git(dir, ["show", `${baseSha}:${f}`], token).slice(0, 20_000)}`; } catch {}
  }
  return "";
}

const SYSTEM = `You are Check Norris, a senior code reviewer for pull requests. You have read-only tools over a checkout of the PR head.
Review for material issues only: correctness, security, data loss, regressions, broken requirements, missing tests for risky logic, and violations of the repository's own documented standards. Do not report style, formatting, naming, or speculative concerns. Do not praise.
Read beyond the diff: check callers, tests, and related code before asserting a problem. Every finding must cite evidence you actually read.
Severity: P0 = must fix before merge (bug, security, data loss). P1 = should fix (likely bug, missing safeguard, standard violation). P2 = minor, optional.
Score 1-5: 5 = merge as-is, no P0/P1 findings. 4 = minor fixes. 3 = needs work. 2 = significant problems. 1 = do not merge.
Inline comments must point at a line in the NEW version of a file that appears in the diff. Put anything else in the summary.
Call \`done\` exactly once when finished.`;

function priorFindings(repo: string, number: number) {
  const rows = db.prepare("SELECT kind, head_sha, comments, summary FROM reviews WHERE repo=? AND number=? ORDER BY id DESC LIMIT 5").all(repo, number) as any[];
  if (!rows.length) return "";
  return "\n\n# Your earlier reviews and replies on this PR (do not repeat findings that are fixed or that you withdrew in a reply; re-raise only if still present)\n" +
    rows.map((r) => `## ${r.kind} at ${r.head_sha.slice(0, 7)}\n${r.summary}\n${JSON.parse(r.comments || "[]").map((c: any) => `- ${c.severity} ${c.path}:${c.line} ${c.body}`).join("\n")}`).join("\n");
}

// --- public entry points ---
export async function reviewPr(gh: Gh, token: () => Promise<string>, repo: string, number: number) {
  const started = Date.now();
  const pr = await gh(`/repos/${repo}/pulls/${number}`);
  const sha = pr.head.sha;
  const dir = await checkout(repo, sha, pr.base.sha, token);
  const diff = await gh(`/repos/${repo}/compare/${pr.base.sha}...${sha}`, { headers: { accept: "application/vnd.github.diff" } }); // pinned to the checked-out head
  const truncated = String(diff).length > 200_000;
  const user = `# PR #${number}: ${pr.title}\nAuthor: ${pr.user.login}. Base: ${pr.base.ref}. Head: ${sha}.\n\n${pr.body ?? ""}\n\n# Diff${truncated ? " (TRUNCATED: too large to include fully; use the tools to inspect the rest and say so in the summary)" : ""}\n\`\`\`diff\n${String(diff).slice(0, 200_000)}\n\`\`\``;
  const out = await agent(dir, SYSTEM + (await repoInstructions(dir, pr.base.sha, token)) + priorFindings(repo, number), user);
  const comments: any[] = out.comments ?? [];
  let score = Math.min(5, Math.max(1, Math.round(out.score ?? 3)));
  if (score === 5 && (truncated || comments.some((c) => c.severity !== "P2"))) score = 4; // never approve on an incomplete diff
  const approved = score >= (config.approveThreshold ?? 5);
  const body = `${out.summary}\n\n**Score: ${score}/5**${approved ? " · Approved" : ""}\n\n<sub>Check Norris · ${config.llm.model}</sub>`;
  await postReview(gh, repo, number, sha, approved, body, comments);
  await gh(`/repos/${repo}/statuses/${sha}`, { method: "POST", body: JSON.stringify({ context: "checknorris", state: approved ? "success" : "failure", description: `Score ${score}/5` }) });
  const seconds = (Date.now() - started) / 1000;
  db.prepare("INSERT INTO reviews (repo, number, head_sha, kind, score, approved, summary, comments, model, tokens_in, tokens_out, seconds, created_at) VALUES (?,?,?,'review',?,?,?,?,?,?,?,?,?)")
    .run(repo, number, sha, score, approved ? 1 : 0, out.summary, JSON.stringify(comments), config.llm.model, out.tokens_in, out.tokens_out, seconds, new Date().toISOString());
  db.prepare(`INSERT INTO prs (repo, number, title, url, author, state, head_sha, updated_at, comments_since, reviewed_sha)
    VALUES (?,?,?,?,?,'open',?,?,?,?) ON CONFLICT(repo, number) DO UPDATE SET reviewed_sha=excluded.reviewed_sha, failed_sha=NULL, failures=0`)
    .run(repo, number, pr.title, pr.html_url, pr.user.login, sha, pr.updated_at, pr.created_at, sha);
  return { score, approved, comments: comments.length, seconds };
}

async function postReview(gh: Gh, repo: string, number: number, sha: string, approved: boolean, body: string, comments: any[]) {
  const inline = comments.map((c) => ({ path: c.path, line: c.line, side: "RIGHT", body: `**${SEVERITY[c.severity as keyof typeof SEVERITY] ?? c.severity}** ${c.body}` }));
  const post = (cs: any[], extra = "") => gh(`/repos/${repo}/pulls/${number}/reviews`, { method: "POST", body: JSON.stringify({ commit_id: sha, event: approved ? "APPROVE" : "COMMENT", body: body + extra, comments: cs }) });
  try { await post(inline); } catch (e: any) {
    if (!/422/.test(e.message)) throw e;
    // A comment outside the diff rejects the whole review; fall back to listing findings in the body.
    await post([], "\n\n" + comments.map((c) => `- **${c.severity}** \`${c.path}:${c.line}\` ${c.body}`).join("\n"));
  }
}

export async function replyToMention(gh: Gh, token: () => Promise<string>, m: { id: number; repo: string; number: number; kind: string; author: string; body: string }) {
  const started = Date.now();
  const pr = await gh(`/repos/${m.repo}/pulls/${m.number}`);
  const dir = await checkout(m.repo, pr.head.sha, pr.base.sha, token);
  let context = "", threadId = m.id;
  if (m.kind === "review") {
    const c = await gh(`/repos/${m.repo}/pulls/comments/${m.id}`);
    threadId = c.in_reply_to_id ?? c.id; // replies must target the thread's top-level comment
    context = `\nThe comment is a reply on ${c.path} line ${c.line ?? c.original_line}.\n`;
    if (c.in_reply_to_id) { const p = await gh(`/repos/${m.repo}/pulls/comments/${c.in_reply_to_id}`); context += `Your earlier comment there:\n> ${p.body.replaceAll("\n", "\n> ")}\n`; }
  }
  const rereview = /re-?review|review again|take another look/i.test(m.body);
  const user = `# PR #${m.number}: ${pr.title}\nHead: ${pr.head.sha}.\n${context}\n@${m.author} wrote:\n> ${m.body.replaceAll("\n", "\n> ")}\n\nAnswer them directly and briefly, using the tools to check the code first. Put the reply in \`summary\`.${rereview ? " A fresh full review is already being scheduled; say so." : ""}`;
  const out = await agent(dir, SYSTEM + (await repoInstructions(dir, pr.base.sha, token)) + priorFindings(m.repo, m.number), user);
  const reply = `${out.summary}\n\n<sub>Check Norris · ${config.llm.model}</sub>`;
  if (m.kind === "review") await gh(`/repos/${m.repo}/pulls/${m.number}/comments/${threadId}/replies`, { method: "POST", body: JSON.stringify({ body: reply }) });
  else await gh(`/repos/${m.repo}/issues/${m.number}/comments`, { method: "POST", body: JSON.stringify({ body: reply }) });
  db.prepare("INSERT INTO reviews (repo, number, head_sha, kind, summary, model, tokens_in, tokens_out, seconds, created_at) VALUES (?,?,?,'reply',?,?,?,?,?,?)")
    .run(m.repo, m.number, pr.head.sha, out.summary, config.llm.model, out.tokens_in, out.tokens_out, (Date.now() - started) / 1000, new Date().toISOString());
  db.prepare("UPDATE mentions SET handled=1 WHERE id=?").run(m.id);
  if (rereview) db.prepare("UPDATE prs SET reviewed_sha=NULL, failed_sha=NULL WHERE repo=? AND number=?").run(m.repo, m.number);
}
