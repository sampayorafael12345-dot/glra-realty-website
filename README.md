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
