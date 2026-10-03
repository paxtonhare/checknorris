import assert from "node:assert/strict";
import { test } from "node:test";
process.env.CHECKNORRIS_DB = ":memory:";
const { scanRepo } = await import("./checknorris.ts"); const { config, db } = await import("./common.ts");
const bot = `${config.appSlug}[bot]`;

const pr = (n: number, sha: string, updated: string, extra = {}) =>
  ({ number: n, title: `PR ${n}`, html_url: `u${n}`, user: { login: "paxton" }, head: { sha }, updated_at: updated, created_at: "2026-01-01T00:00:00Z", draft: false, ...extra });
const comment = (id: number, login: string, body: string, created_at: string, extra = {}) => ({ id, user: { login }, body, created_at, html_url: `c${id}`, ...extra });

let state: Record<string, any> = {};
const gh = async (p: string) => { const k = Object.keys(state).find((k) => p.startsWith(k)); if (!k) throw new Error(`unexpected ${p}`); return state[k]; };
const scan = async () => { const w = { repo: "o/r", reviews: [], mentions: [] as any[] }; await scanRepo(gh, "o/r", w); return w; };

test("new PR needs review; drafts and reviewed heads do not", async () => {
  state = { "/repos/o/r/pulls?": [pr(1, "aaa", "t1"), pr(2, "bbb", "t1", { draft: true })], "/repos/o/r/issues/1/comments": [], "/repos/o/r/pulls/1/comments": [] };
  assert.deepEqual((await scan()).reviews, [{ repo: "o/r", number: 1, head_sha: "aaa" }]);
  db.prepare("UPDATE prs SET reviewed_sha='aaa' WHERE number=1").run();
  assert.deepEqual((await scan()).reviews, []);
  state["/repos/o/r/pulls?"] = [pr(1, "ccc", "t2")];
  assert.deepEqual((await scan()).reviews, [{ repo: "o/r", number: 1, head_sha: "ccc" }]);
});

test("mentions: @bot, replies to bot; ignores bot's own and old comments; no repeats", async () => {
  state = {
    "/repos/o/r/pulls?": [pr(1, "ccc", "t3")],
    "/repos/o/r/issues/1/comments": [comment(10, "paxton", `hey @${config.appSlug} look again`, "2026-01-02T00:00:00Z"), comment(11, bot, `@${config.appSlug} self`, "2026-01-02T00:00:01Z"), comment(12, "paxton", "unrelated", "2026-01-02T00:00:02Z")],
    "/repos/o/r/pulls/1/comments": [comment(20, "paxton", "why?", "2026-01-02T00:00:03Z", { in_reply_to_id: 5 }), comment(21, "paxton", "why?", "2026-01-02T00:00:04Z", { in_reply_to_id: 6 })],
    "/repos/o/r/pulls/comments/5": { user: { login: bot } },
    "/repos/o/r/pulls/comments/6": { user: { login: "someone" } },
  };
  const w = await scan();
  assert.deepEqual(w.mentions.map((m) => m.id), [10, 20]);
  assert.deepEqual((await scan()).mentions, [], "same updated_at: comments not rescanned");
  state["/repos/o/r/pulls?"] = [pr(1, "ccc", "t4")];
  assert.deepEqual((await scan()).mentions, [], "rescanned, nothing newer than comments_since");
});

test("failed heads back off exponentially, then retry", async () => {
  state = { "/repos/o/r/pulls?": [pr(3, "fff", "t1")], "/repos/o/r/issues/3/comments": [], "/repos/o/r/pulls/3/comments": [] };
  assert.equal((await scan()).reviews.length, 1);
  const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
  db.prepare("UPDATE prs SET failed_sha='fff', failures=2, failed_at=? WHERE number=3").run(at(3));
  assert.equal((await scan()).reviews.length, 0, "2 failures: wait 4 minutes");
  db.prepare("UPDATE prs SET failed_at=? WHERE number=3").run(at(5));
  assert.equal((await scan()).reviews.length, 1, "backoff elapsed");
});

test("backoff is capped at 2^10 minutes", async () => {
  const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
  db.prepare("UPDATE prs SET failed_sha='fff', failures=30, failed_at=? WHERE number=3").run(at(1025));
  assert.equal((await scan()).reviews.length, 1);
});
