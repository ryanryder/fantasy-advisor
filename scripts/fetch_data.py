#!/usr/bin/env python3
"""Refresh data/*.json for the advisor page.

- data/sleeper.json: players, weekly PPR stats, weekly PPR projections, NFL schedule,
  trending adds. Sleeper's API is free and needs no auth.
- data/league.json: your ESPN league (teams, rosters, matchups, roster slots, ESPN draft
  ranks). Needs ESPN_S2 and ESPN_SWID env vars for a private league. Optional: if it
  fails, the page still works from Sleeper data plus what you mark in the draft.

Stdlib only, so the GitHub Action needs no pip install.
"""
import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
CONFIG = json.loads((ROOT / "config.json").read_text())
POSITIONS = {"QB", "RB", "WR", "TE", "K", "DEF"}
LAST_WEEK = 17  # last fantasy week we project through

# ESPN proTeamId -> Sleeper team abbreviation (Sleeper DEF player_id is the team abbrev)
ESPN_TEAMS = {
    1: "ATL", 2: "BUF", 3: "CHI", 4: "CIN", 5: "CLE", 6: "DAL", 7: "DEN", 8: "DET",
    9: "GB", 10: "TEN", 11: "IND", 12: "KC", 13: "LV", 14: "LAR", 15: "MIA", 16: "MIN",
    17: "NE", 18: "NO", 19: "NYG", 20: "NYJ", 21: "PHI", 22: "ARI", 23: "PIT", 24: "LAC",
    25: "SF", 26: "SEA", 27: "TB", 28: "WAS", 29: "CAR", 30: "JAX", 33: "BAL", 34: "HOU",
}
ESPN_POS = {1: "QB", 2: "RB", 3: "WR", 4: "TE", 5: "K", 16: "DEF"}
ESPN_SLOTS = {0: "QB", 2: "RB", 3: "RB/WR", 4: "WR", 5: "WR/TE", 6: "TE", 7: "OP",
              16: "DST", 17: "K", 20: "BE", 21: "IR", 23: "FLEX"}


def get(url, headers=None, cookies=None, retries=3):
    h = {"User-Agent": "fantasy-advisor/1.0", "Accept": "application/json"}
    h.update(headers or {})
    if cookies:
        h["Cookie"] = "; ".join(f"{k}={v}" for k, v in cookies.items())
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=h), timeout=60) as r:
                return json.loads(r.read().decode())
        except urllib.error.HTTPError as e:
            if e.code < 500 or attempt == retries - 1:
                raise
        except (urllib.error.URLError, TimeoutError):
            if attempt == retries - 1:
                raise
        time.sleep(2 ** attempt)


def ppr_points(resp, keep_zero_if_played):
    """Sleeper returns either {player_id: stats} or [{player_id, stats}]; normalize."""
    if isinstance(resp, dict):
        items = resp.items()
    else:
        items = ((r.get("player_id"), r.get("stats") or {}) for r in resp or [])
    out = {}
    for pid, s in items:
        if not pid or not isinstance(s, dict):
            continue
        v = s.get("pts_ppr")
        if v is None:
            continue
        v = float(v)
        if v != 0 or (keep_zero_if_played and (s.get("gp") or 0) > 0):
            out[str(pid)] = round(v, 2)
    return out


def fetch_sleeper():
    state = get("https://api.sleeper.app/v1/state/nfl")
    season = str(CONFIG.get("season") or state["season"])
    stype = state.get("season_type")
    week = int(state.get("week") or 1)
    if stype == "pre":
        week = 1
    elif stype in ("post", "off"):
        week = LAST_WEEK + 1
    print(f"Sleeper: season {season}, week {week} ({stype})")

    raw = get("https://api.sleeper.app/v1/players/nfl")

    stats = {}
    for w in range(1, min(week, LAST_WEEK) + 1):
        stats[w] = ppr_points(get(f"https://api.sleeper.app/v1/stats/nfl/regular/{season}/{w}"), True)
    proj = {}
    for w in range(max(week, 1), LAST_WEEK + 1):
        proj[w] = ppr_points(get(f"https://api.sleeper.app/v1/projections/nfl/regular/{season}/{w}"), False)

    schedule = {}
    try:
        games = get(f"https://api.sleeper.com/schedule/nfl/regular/{season}")
        for g in games:
            w, home, away = int(g["week"]), g.get("home"), g.get("away")
            if home and away:
                schedule.setdefault(w, {})[home] = away
                schedule[w][away] = home
    except Exception as e:  # schedule is a nice-to-have (byes, matchup grades)
        print(f"WARN schedule unavailable: {e}", file=sys.stderr)

    trending = []
    try:
        trending = [t["player_id"] for t in
                    get("https://api.sleeper.app/v1/players/nfl/trending/add?lookback_hours=48&limit=40")]
    except Exception as e:
        print(f"WARN trending unavailable: {e}", file=sys.stderr)

    seen = set()
    for table in list(stats.values()) + list(proj.values()):
        seen.update(table)
    players = {}
    for pid, p in raw.items():
        pos = p.get("position")
        if pos not in POSITIONS or (pid not in seen and not p.get("team")):
            continue
        if pos == "DEF":
            name = f"{p.get('last_name') or pid} D/ST"
        else:
            name = p.get("full_name") or f"{p.get('first_name', '')} {p.get('last_name', '')}".strip()
        players[pid] = {
            "n": name, "p": pos, "t": p.get("team"), "i": p.get("injury_status"),
            "r": p.get("search_rank"), "e": p.get("espn_id"), "a": p.get("age"),
        }
    # Drop stats/projections for players we filtered out (IDPs, etc.) to keep the file small.
    stats = {w: {k: v for k, v in t.items() if k in players} for w, t in stats.items()}
    proj = {w: {k: v for k, v in t.items() if k in players} for w, t in proj.items()}

    return {
        "updated": int(time.time()), "season": int(season), "week": week, "lastWeek": LAST_WEEK,
        "players": players, "stats": stats, "proj": proj, "schedule": schedule, "trending": trending,
    }, raw


def fetch_espn(raw_players):
    s2, swid = os.environ.get("ESPN_S2"), os.environ.get("ESPN_SWID")
    # Send whichever cookies we have; espn_s2 alone sometimes works when SWID can't be found.
    cookies = {k: v for k, v in (("espn_s2", s2), ("SWID", swid)) if v} or None
    base = (f"https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/{CONFIG['season']}"
            f"/segments/0/leagues/{CONFIG['leagueId']}")
    d = get(f"{base}?view=mTeam&view=mRoster&view=mMatchup&view=mSettings", cookies=cookies)

    by_espn = {str(p.get("espn_id")): pid for pid, p in raw_players.items() if p.get("espn_id")}
    by_name = {((p.get("full_name") or "").lower(), p.get("position")): pid
               for pid, p in raw_players.items() if p.get("full_name")}

    def sleeper_id(espn_id, player):
        pos = ESPN_POS.get(player.get("defaultPositionId"))
        if pos == "DEF":
            return ESPN_TEAMS.get(player.get("proTeamId"))
        return by_espn.get(str(espn_id)) or by_name.get(((player.get("fullName") or "").lower(), pos))

    members = {m["id"]: (m.get("firstName") or m.get("displayName") or "").strip()
               for m in d.get("members", [])}
    teams = []
    for t in d.get("teams", []):
        roster = []
        for e in (t.get("roster") or {}).get("entries", []):
            p = (e.get("playerPoolEntry") or {}).get("player") or {}
            roster.append({
                "sid": sleeper_id(e.get("playerId"), p), "espnId": e.get("playerId"),
                "name": p.get("fullName"), "pos": ESPN_POS.get(p.get("defaultPositionId")),
                "slot": ESPN_SLOTS.get(e.get("lineupSlotId"), str(e.get("lineupSlotId"))),
            })
        owner_ids = t.get("owners") or [t.get("primaryOwner")]
        teams.append({
            "id": t["id"], "abbrev": t.get("abbrev"),
            "name": t.get("name") or f"{t.get('location', '')} {t.get('nickname', '')}".strip(),
            "owner": ", ".join(filter(None, (members.get(o) for o in owner_ids))),
            "roster": roster,
        })

    schedule = [{
        "period": m.get("matchupPeriodId"),
        "home": (m.get("home") or {}).get("teamId"),
        "away": (m.get("away") or {}).get("teamId"),
    } for m in d.get("schedule", [])]

    settings = d.get("settings") or {}
    slot_counts = (settings.get("rosterSettings") or {}).get("lineupSlotCounts") or {}
    roster_slots = {}
    for k, n in slot_counts.items():
        name = ESPN_SLOTS.get(int(k))
        if name and n:
            roster_slots[name] = n
    # matchupPeriods maps fantasy matchup period -> NFL scoring periods (weeks)
    periods = (settings.get("scheduleSettings") or {}).get("matchupPeriods") or {}

    status = d.get("status") or {}
    league = {
        "updated": int(time.time()),
        "name": settings.get("name"),
        "scoringPeriod": d.get("scoringPeriodId"),
        "currentPeriod": status.get("currentMatchupPeriod"),
        "matchupPeriods": periods,
        "rosterSlots": roster_slots,
        "teams": teams,
        "schedule": schedule,
        "espnRanks": {},
    }

    # ESPN's own PPR draft ranks: the best predictor of what your family will pick,
    # since ESPN's draft room and autodraft sort by them.
    try:
        flt = {"players": {"limit": 400, "sortDraftRanks": {"sortPriority": 100, "sortAsc": True, "value": "PPR"}}}
        kona = get(f"{base}?view=kona_player_info", cookies=cookies,
                   headers={"X-Fantasy-Filter": json.dumps(flt)})
        for entry in kona.get("players", []):
            p = entry.get("player") or {}
            rank = ((p.get("draftRanksByRankType") or {}).get("PPR") or {}).get("rank")
            sid = sleeper_id(entry.get("id"), p)
            if sid and rank:
                league["espnRanks"][sid] = rank
    except Exception as e:
        print(f"WARN ESPN draft ranks unavailable: {e}", file=sys.stderr)
    return league


def write(name, obj):
    DATA.mkdir(exist_ok=True)
    (DATA / name).write_text(json.dumps(obj, separators=(",", ":"), sort_keys=True))
    print(f"wrote data/{name} ({(DATA / name).stat().st_size // 1024} KB)")


def main():
    sleeper, raw = fetch_sleeper()
    write("sleeper.json", sleeper)
    try:
        write("league.json", fetch_espn(raw))
    except Exception as e:
        # Don't fail the run: Sleeper data alone still powers the draft board.
        print(f"WARN ESPN league fetch failed ({e}). For a private league, set the ESPN_S2 and "
              f"ESPN_SWID repo secrets. See README.", file=sys.stderr)


if __name__ == "__main__":
    main()
