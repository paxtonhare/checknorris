# Check Norris

Self-hosted AI pull request reviewer. Greptile-style reviews and approvals from
your own OpenAI-compatible endpoint, running on a box you control.

Maintained for my own use. PRs welcome, no roadmap, no support promises.

## What it does

- Polls GitHub for open PRs on every repo the app is installed on. No webhooks,
  no public endpoint; it runs fine on a laptop or a home server.
- Reviews each new head commit: a read-only agent with `read`/`grep`/`ls` over
  a checkout of the PR, plus the repo's `AGENTS.md`/`CLAUDE.md` as instructions.
- Posts inline comments with a severity (P0/P1/P2) and one summary review with
  a 1–5 score. Score at or above the threshold submits the review as
  **Approve**; below it, **Comment**. It never requests changes.
- Sets a `checknorris` commit status so branch protection can gate on it.
- Re-reviews on push and does not repeat findings it already made.
- Dashboard: one page listing PRs, scores, tokens, and full review text, with
  a re-run button.

## What it does not do

Autofix, chat replies, PR summaries, authentication, multi-user, webhooks.
Any user or team wanting those can add them.

## Security model

There is no authentication. Run it on a private network (Tailscale, VPN,
localhost) and do not expose the dashboard to the internet.

## Setup

1. `node scripts/create-github-app.mjs [name] [--org ORG]`, then open
   `http://localhost:3939/` in a browser logged in to GitHub and click
   **Create GitHub App**. This writes `config.json` and the private key.
   Make the app public in its Advanced settings if you want to install it on
   an organization you don't own the app under.
2. Install the app on the repos to review: `https://github.com/apps/<name>/installations/new`.
3. Add your model endpoint to `config.json`:

```json
{
  "appId": 123,
  "appSlug": "checknorrisbot",
  "privateKey": "checknorrisbot.pem",
  "llm": { "baseUrl": "https://your-proxy/v1", "apiKey": "...", "model": "..." },
  "approveThreshold": 5,
  "pollSeconds": 120
}
```

4. `node checknorris.ts` (Node 24+, no dependencies). Dashboard on `http://127.0.0.1:3940`.

### Running it on a Linux box

`scripts/deploy.sh <ssh-host>` installs Node under `~/.local/node`, rsyncs the
code and config, and starts a user-level systemd service (`loginctl
enable-linger` once so it survives logout). Then expose the dashboard on your
tailnet with `tailscale serve --bg 3940` (after `sudo tailscale set
--operator=$USER` once).

Other commands: `node checknorris.ts once` runs one tick; `node checknorris.ts
review <owner/repo> <n>` reviews one PR now; `node checknorris.ts list` prints
state.

## License

MIT
