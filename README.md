# Fantasy Advisor

Draft assistant and weekly start/sit advisor for an ESPN PPR league (9 teams, head-to-head points).

- **Draft tab:** tap **Mine** or **Taken** as players come off the board. The top 5 picks are ranked by
  points over a replacement-level player, how much worse that position gets by your next turn,
  and what your roster still needs.
- **This week tab:** your best lineup, your win chance against this week's opponent, and a lean toward
  high-ceiling players when you're the underdog or steady ones when you're the favorite.
- **Waivers tab:** best unrostered players, flagged when they beat someone on your team.

## One-time setup

### 1. Turn on the website (GitHub Pages)
Settings → Pages → Source: **Deploy from a branch** → Branch: `main`, folder `/ (root)` → Save.
After about a minute the site is live at `https://ryanryder.github.io/fantasy-advisor/`.

### 2. Connect your private ESPN league
ESPN only shares a private league's data with a logged-in user, so the refresh script borrows two login cookies.

1. On a computer, log in at fantasy.espn.com and open your league.
2. Open developer tools (F12) → **Application** (Chrome) or **Storage** (Firefox) → **Cookies** → `https://fantasy.espn.com`.
3. Copy the values of **`espn_s2`** (a long string) and **`SWID`** (looks like `{XXXXXXXX-XXXX-...}`, braces included).
4. In this repo: Settings → Secrets and variables → Actions → **New repository secret**:
   - `ESPN_S2` = the espn_s2 value
   - `ESPN_SWID` = the SWID value

Secrets are encrypted and never shown in logs or on the site. The cookies expire after about a year.

### 3. Load the data
Actions tab → **Refresh data** → **Run workflow**. After that it runs every 4 hours by itself.
If the ESPN step can't connect, the run still succeeds with Sleeper data, and its log says why ESPN failed.

## Draft day
1. Open the site on your phone and go to **Draft settings** → set **your draft slot** once ESPN shows the order.
2. For every pick in the ESPN draft room, tap **Taken** (someone else) or **Mine** (you) on that player.
3. Messed up? **Undo last pick.** Want a safety net? **Save backup** downloads the picks as a file.

Draft state is saved in your phone's browser, so it survives a reload. Use the same device the whole draft.

## Where the numbers come from
- Stats, projections, schedule and trending adds: [Sleeper's public API](https://docs.sleeper.com/) (PPR points).
- Rosters, matchups, roster slots and ESPN's draft ranks: your ESPN league (unofficial API).
- Sleeper's PPR scoring is close to ESPN's default PPR but not identical, so treat projections as
  guidance.

## Files
| Path | What |
|---|---|
| `index.html`, `app.js`, `style.css` | The site (no build step) |
| `config.json` | League id, your team id, team count, roster slots |
| `scripts/fetch_data.py` | Fetches data into `data/` (Python standard library only) |
| `.github/workflows/refresh-data.yml` | Runs the fetch every 4 hours and commits `data/` |
