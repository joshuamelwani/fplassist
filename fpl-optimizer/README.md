# Squad Room — FPL Team Selector & Transfer Optimizer

A self-updating Fantasy Premier League tool: an expected-points (xP) forecast
model, an ILP squad optimizer (15-man squad, £100m budget, valid formation,
captain), and a mobile web app for building your GW1 squad and getting a
weekly transfer suggestion — all running for free on GitHub Actions + GitHub
Pages. No server, no API keys, no cost.

## What's inside

```
scripts/
  fetch_data.py     pulls raw data from the official (public) FPL API
  xp_model.py        turns raw data into a per-player expected-points forecast
  optimizer.py        ILP solver: best 15-man squad + starting XI + captain
docs/                 the static site (GitHub Pages serves this folder)
  index.html, app.js, style.css
  data/                generated JSON the site reads (created by the workflow)
.github/workflows/
  update-data.yml     scheduled job: fetch -> forecast -> optimize -> publish
```

## 1. Get it on GitHub

1. Create a new **public** repository on GitHub (Pages on the free tier needs
   public, unless you're on GitHub Pro/Team/Enterprise).
2. Upload everything in this folder to the repo (drag-and-drop on
   github.com works fine, or `git push` if you're comfortable with git).
3. In the repo, go to **Settings → Pages** and set **Source** to
   **GitHub Actions**.
4. Go to the **Actions** tab → select **"Refresh FPL data"** → **Run workflow**.
   This does the first data pull and publishes the site. It takes a
   few minutes (it fetches ~700 player summaries from the FPL API).
5. Once it finishes, your site is live at
   `https://<your-username>.github.io/<repo-name>/`.

After that, it keeps itself current automatically — the workflow re-runs
every **Wednesday and Friday** to catch team news, price changes, and
updated underlying stats before most gameweeks. Trigger it manually any
time from the Actions tab if you want a fresher pull.

## 2. Use it on your phone

Open the GitHub Pages URL from step 5 on your phone's browser, then:
- **iOS Safari:** Share → Add to Home Screen
- **Android Chrome:** ⋮ menu → Add to Home screen

It'll behave like a lightweight app (own icon, no browser chrome).

## 3. How to use it

**Squad tab** — Toggle between:
- *Optimizer pick*: the ILP-optimal 15 for the next 5 gameweeks, already
  split into a legal starting XI + bench + captain/vice.
- *Build my own*: tap empty shirt slots to fill your squad manually; the
  budget bar and 3-per-club rule are enforced live. Tap a filled player for
  bench/start/captain/replace actions.

Tap **Save as my team** once you're happy — this is what the Transfers tab
uses each week.

**Transfers tab** — Set how many free transfers you're carrying (1, or 2 if
you rolled one over), and it suggests the single best swap (always free),
plus a second swap if taking a -4 hit is still worth it, ranked by
projected gain over the next 3 gameweeks.

**Players tab** — Full sortable/searchable player pool: next GW, next 3,
next 5 gameweek forecasts, and value (xP per £m).

**Fixtures tab** — Fixture difficulty for every club, next 5 gameweeks.

## 4. How the forecast model works

For each player and fixture, `xp_model.py` estimates:

```
xP = appearance points
   + goal points        (xG/90 x expected minutes x fixture attack multiplier)
   + assist points       (xA/90 x expected minutes x fixture attack multiplier)
   + clean sheet points (GK/DEF/MID, from a difficulty-adjusted CS probability)
   + goalkeeper save points
   + bonus points estimate (from BPS rate)
   - card risk
```

Minutes are estimated from recent playing-time patterns and the player's
official injury/fitness status. Underlying rates blend season-long
xG/xA with recent form, and fixture difficulty is derived from each club's
attack/defence strength ratings plus home/away. It's a transparent
heuristic model, not a black box — every weight lives in
`scripts/xp_model.py` and is easy to retune (see `FORM_WEIGHT`, `DECAY`,
`FDR_CS_BASE`, etc. near the top of the file).

## 5. How the optimizer works

`scripts/optimizer.py` is a proper integer linear program (via
[PuLP](https://coin-or.github.io/pulp/), solved with the bundled CBC
solver — no external solver install needed): it maximises starting-XI xP
+ captain double, subject to the real FPL rules (2 GKP / 5 DEF / 5 MID /
3 FWD, ≤ £100m, ≤ 3 players per club, legal formation), so what it
recommends is genuinely optimal against the forecast, not a greedy
approximation. The client-side transfer suggestions in the app use a
faster swap-search heuristic (fine for 1-2 transfers a week; the full ILP
runs server-side in Actions).

## 6. Customizing

- **Budget / squad rules**: `BUDGET`, `SQUAD_SLOTS`, `MAX_PER_TEAM` in
  `scripts/optimizer.py`.
- **Forecast weights**: constants at the top of `scripts/xp_model.py`.
- **Refresh schedule**: the two `cron` lines in
  `.github/workflows/update-data.yml`.
- **Look and feel**: design tokens (colors, fonts) at the top of
  `docs/style.css`.

## Notes

- Uses only the official, public, unauthenticated FPL API
  (`fantasy.premierleague.com/api/...`) — nothing to configure, no keys.
- Everything runs client-side once the JSON is published; the site works
  fully offline after first load except for the weekly data refresh.
- This is a forecasting and decision-support tool, not a guarantee —
  treat the projections as a well-informed second opinion.
