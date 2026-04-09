# Nettzone Masters Pool - heyooooooooo

A tiny, self-hosted fantasy pool for the Masters Tournament. Pick six golfers,
your best four scores each round count, lowest team total wins. Friends submit
entries by opening a GitHub issue from a template; scores refresh automatically
every ~15 minutes via GitHub Actions.

Everything is static — there is no server. The site lives on GitHub Pages and
the data lives in JSON files committed to the repo.

## What's in here

```
.
├── index.html              # the leaderboard site
├── assets/
│   ├── app.js              # client-side renderer + scoring
│   └── style.css
├── data/
│   ├── scores.json         # auto-updated by the fetch workflow
│   └── entries.json        # auto-updated when an entry issue is approved
├── scripts/
│   ├── fetch_scores.py     # pulls from ESPN, writes data/scores.json
│   └── ingest_entry.py     # parses an entry issue, writes data/entries.json
└── .github/
    ├── ISSUE_TEMPLATE/pool-entry.yml
    └── workflows/
        ├── update-scores.yml      # cron every ~15 min during Masters week
        └── ingest-entry.yml       # fires when you label an issue "approved"
```

## One-time setup

1. **Create a public repo on GitHub** (e.g. `masters-pool`) and push this
   directory to it. From a shell in `C:\git\Masters`:
   ```bash
   git init
   git add .
   git commit -m "Initial pool setup"
   git branch -M main
   git remote add origin https://github.com/<you>/masters-pool.git
   git push -u origin main
   ```

2. **Enable GitHub Pages.** In the repo: `Settings → Pages → Build and
   deployment → Source: Deploy from a branch → main / (root) → Save`. After a
   minute the site will be live at
   `https://<you>.github.io/masters-pool/`.

3. **Allow Actions to write to the repo.** `Settings → Actions → General →
   Workflow permissions → Read and write permissions → Save`. Without this the
   automated commits will fail.

4. **Create the `approved` label.** `Issues → Labels → New label → Name:
   `approved` → Create`. This is the trigger the ingest workflow listens for.

5. **Kick off the first scores fetch.** `Actions → Update Masters scores → Run
   workflow → main`. This populates `data/scores.json` with the field so picks
   can be validated. After it finishes, the site will show the field on the
   **The field** tab.

## How friends enter

Send your friends the Pages URL. They click **Rules & how to enter →
Submit your entry**, which opens a pre-filled GitHub issue:

- Display name (how they'll appear on the leaderboard)
- Six picks, full names

When they submit, you (the owner) get an issue notification. Glance at it,
then add the **`approved`** label. The ingest workflow runs, parses the picks,
validates them against the field, commits the entry to `data/entries.json`,
closes the issue with a confirmation comment, and the new entry appears on
the site within ~30 seconds.

If a pick is misspelled or ambiguous, the workflow comments back with the
problem and removes the label so the friend (or you) can fix it.

## Scoring rules

- 6 picks per entry, **best 4 scores each round count** toward the team total.
  Your two worst picks each round are dropped (and they can change round to
  round).
- Cut golfers keep their 36-hole to-par total — that score still counts if
  it's one of your best 4.
- Withdrawals and DQs take their last reported to-par **+ 10 stroke penalty**.
- Lowest team total after Sunday wins.

These constants live at the top of `assets/app.js` if you want to tweak them.

## How the automation works

- **`update-scores.yml`** runs on a cron during Masters week (Apr 9–13 2026)
  every 15 minutes. It runs `scripts/fetch_scores.py`, which hits ESPN's
  public golf leaderboard endpoint and rewrites `data/scores.json`. If
  scores changed, it commits and pushes. The site reads `scores.json` on
  page load (with cache busting) and re-renders.

- **`ingest-entry.yml`** fires when you add the `approved` label to an issue.
  It runs `scripts/ingest_entry.py`, which parses the issue body, fuzzy-matches
  picks against the current field, and writes `data/entries.json`. On success
  it comments and closes the issue. On failure it comments the error and
  removes the label.

GitHub Actions cron is best-effort and may be delayed several minutes when
GitHub is busy — fine for golf, not fine for stock trading.

## If something breaks mid-tournament

- **Manual score refresh:** `Actions → Update Masters scores → Run workflow`.
- **ESPN endpoint changes:** edit `scripts/fetch_scores.py`. The shape it
  expects is documented in the parsing functions. Worst case, write the
  fields you care about straight into `data/scores.json` by hand and commit
  — the site only cares about the file's shape, not where it came from.
- **A friend can't get their entry to validate:** check that the player name
  on the **Field** tab matches what they typed. The ingest script accepts
  full names, partial substrings, or unique last names.

## Tweakable constants

| Where | What |
| --- | --- |
| `assets/app.js` top | `PENALTY_WD`, `PENALTY_NULL`, `BEST_OF`, `PICKS_REQUIRED` |
| `.github/workflows/update-scores.yml` | Cron schedule |
| `scripts/fetch_scores.py` | ESPN endpoint, status mapping |

## Local preview

```bash
cd C:\git\Masters
python -m http.server 8000
```

Then open <http://localhost:8000>. The site fetches `data/scores.json` and
`data/entries.json` over HTTP, so opening `index.html` directly via `file://`
won't work — you need a local server.
