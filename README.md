# GLRA Realty website

The public site (glrarealty.com), the office admin dashboard and the agent
workspace. One Node/Express server that also serves the static pages.

No passwords, keys or account logins belong in this repo. Those live in `.env`
on your computer, in Render's Environment settings, and in the recovery sheet
kept in the password manager.

## Run it on your computer

1. Install Node.js (the same major version Render uses).
2. `npm install`
3. Copy `.env.example` to `.env` and fill it in (the file explains each line).
4. `npm start`, then open http://localhost:3000

## Folder map

| Path | What it is |
|---|---|
| `server.js` | The Express app: public API, listing pages, sitemap, admin API, email |
| `server/db.js` | Every MongoDB model (mongoose) |
| `server/*.js` | One file per module: auth, cases, leads, leasing, staff, staff-bot, agents, chatbot, PDFs, hazard map data |
| `public/*.html` | The public pages, plus `admin.html` (office dashboard) and `agent.html` (agent workspace) |
| `public/js`, `public/css` | Shared browser scripts and stylesheets |
| `public/sw.js` | The service worker (offline cache) |
| `scripts/check.js` | The pre-upload check (below) |
| `docs/` | Notes for integrations, e.g. the staff bot API |

## Before every upload: run the check

```
npm run check
```

It syntax-checks every server file and browser script, parses every inline
`<script>` in every page, and validates the JSON-LD blocks. It changes
nothing. **If it prints CHECK FAILED, do not upload.** One broken inline
script once took the dashboard and both listing pages offline for 20 hours.

It cannot see the HTML that `server.js` builds for listing pages; open one
listing page locally after changing those templates.

## Deploying

The site runs on Render from the GitHub repo. Upload the changed files to
GitHub; Render then redeploys (if it does not, use "Manual Deploy" in Render).

- Changed a file in `public/`? Bump `CACHE_VERSION` in `public/sw.js` **and**
  the `?v=` number on the changed CSS/JS links in the pages that load them.
  The `?v=` stamp is what actually reaches returning visitors; the browser's
  own cache ignores the service worker version.
- Changed `server.js` or anything in `server/`? Render restarts the server on
  deploy; check https://glrarealty.com/api/health afterwards.

## Four stylesheet "worlds"

A style change in one does not reach the others:

1. The public pages (`index.html` and friends: `brutalist-theme.css`,
   `styles.css`, `tactile.css`)
2. `admin.html` (its own inline styles)
3. `agent.html` (its own inline styles)
4. The listing and area pages that `server.js` generates (inline styles in
   the templates there)

## Backups

Admin dashboard, Backup section: one button downloads every collection in the
database as Excel or JSON. Passwords, reset tokens, calendar-feed tokens and
key hashes are deliberately left out, so after a restore everyone sets a new
password with "Forgot password". Keep the JSON copy; Excel cuts very long cells.

## Facebook and Instagram (Meta)

`server/meta.js` connects the Facebook Page, the Instagram account and the ad
account to the dashboard. It only **reads** from Meta: there is no code that
creates, edits or pauses ads or changes a budget. The one write is the admin
button "Connect Page to webhook" (it tells Meta to send the Page's events
here).

Three switches in Render's Environment settings, all off by default. While a
switch is off its routes answer 404 and its timers never start.

| Switch | What it turns on |
|---|---|
| `META_LEADS_ENABLED=1` | Lead-ad forms arrive by webhook at `/api/meta/webhook` and land in the Leads tab (kind "Facebook / Instagram lead ad"), deduplicated like any website enquiry. An email goes to the Leads alert address and, if set, a Telegram message. An hourly check of every lead form catches anything the webhook missed. |
| `META_INSIGHTS_ENABLED=1` | A daily snapshot (about 6 am Manila) of Page, Instagram and ad-account numbers, the admin **Meta** tab (date filters, campaigns with cost per lead, top posts, CSV export) and a Monday 8 am summary email. |
| `META_INBOX_ENABLED=1` | Messenger and Instagram messages and comments on posts become lead touches with a link to the conversation; the Page's own reply counts as contact and stops the reply clock. Needs Meta App Review first. |

Other settings: `META_APP_ID`, `META_APP_SECRET`, `META_VERIFY_TOKEN`,
`META_SYSTEM_TOKEN` (System User token, expiry "Never"), `META_PAGE_ID`,
`META_IG_USER_ID`, `META_AD_ACCOUNT_ID`, `META_GRAPH_VERSION` (default v24.0),
`TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`. See `.env.example`.

- **Who can see it:** the Meta tab needs the `meta_view` permission (admins
  only by default; switch it on per person in Accounts). The leads themselves
  are in the Leads tab as before (`leads_view`).
- **Token check:** once a day the token is checked with Meta. If it is
  invalid, expires within 7 days or is missing a permission, the Meta tab
  shows a red banner and one email goes out.
- **Errors:** every Graph API error lands in the Meta tab's error log (kept 90
  days). Raw webhook deliveries are kept 30 days. Tokens are never logged.
- **When Meta renames a metric:** the metric names are listed once, near the
  top of the insights section in `server/meta.js` (`PAGE_METRICS`,
  `IG_METRICS`). A retired name only marks its own tile "Retired by Meta".
- **Testing locally:** `scripts/test-meta.js` sends signed fake webhooks to a
  local server pointed at a stub Graph API (`META_GRAPH_BASE` and
  `TELEGRAM_API_BASE` are honoured only for a localhost address). Read the
  top of that file for how to run it.

## GLRA Social (Facebook and Instagram Page manager)

`public/social.html` (+ `public/js/social.js`, `public/css/social.css`) is a
private page for the three Facebook Pages and their Instagram accounts. It
opens from the admin menu ("Social", new tab) and uses the same admin sign-in
and the same Glass / Bold, dark / light look. Server: `server/social.js`
(routes, approvals, publisher clock, inbox, insights), `server/social-ai.js`
(AI drafts), `server/social-report.js` (weekly email + PDF). The Graph client
shared with `server/meta.js` lives in `server/meta-graph.js`.

- **Switch:** `SOCIAL_ENABLED=1` in Render, plus `META_PAGE_IDS` (comma
  separated). Off = every route 404 and no timers. Tokens stay in the
  environment (`META_SYSTEM_TOKEN`); Page tokens are fetched and kept in memory.
- **Permissions (Accounts):** `social_view` (open it), `social_draft` (write
  posts, replies, templates), `social_approve` (publish, schedule, send, hide,
  delete). All off for a new staff account. The server refuses anything that
  reaches a Page without `social_approve`; approvals and deletions also go to
  the Audit Log, everything to the Social activity log (`SocialLog`).
- **Publishing:** Facebook scheduled posts use Facebook's own scheduler (10
  minutes to 75 days ahead). Instagram has no API scheduler: a per-minute
  clock in the server publishes it (keep the server awake: Render Starter).
  Links to glrarealty.com get `utm_*` tags naming the post and Page, so leads
  are credited to the post.
- **Inbox:** comments and messages arrive through the same signed webhook
  (`/api/meta/webhook`, forwarded to Social while it is on) and a 10-minute
  check. Replies to messages only within 24 hours of the person's last
  message.
- **Extras:** listing studio, AI drafts (Gemini / Groq keys of the website
  chat; always a draft), best time to post, hashtag sets, media library with
  Instagram ratio checks, recurring posts, CSV bulk scheduling (approve a
  batch in one click), one-time approve links by email
  (`social-approve.html`), weekly report email + PDF.
- **Claude review key:** made / revoked by an admin in Settings, stored as a
  hash. `GET /api/social/review/summary|posts|insights|inbox` (masked: names
  as initials, phones and emails removed) and `POST /api/social/review/drafts`
  / `reply-drafts` (always waiting for approval). Header `x-glra-review-key`.
  Every call is logged.
- **Ads are read-only.** No code creates, edits or pauses ads or budgets.
- **Testing locally:** `scripts/test-social.js` (stub Graph API + stub AI on
  localhost; read the top of the file). Run it on a freshly started stack;
  `--off` checks a stack started without `SOCIAL_ENABLED`.
