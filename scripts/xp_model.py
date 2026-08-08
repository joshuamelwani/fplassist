"""
xp_model.py
Computes an expected-points (xP) forecast for every player, for each of the
next N gameweeks, plus rolled-up horizons (next 1 / next 3 / next 5 GWs).

Model, in plain terms, per fixture:
    xP = appearance_points
       + goal_points        (xG/90 x expected mins x fixture attack multiplier)
       + assist_points      (xA/90 x expected mins x fixture attack multiplier)
       + clean_sheet_points (GK/DEF/MID, from a clean-sheet probability model)
       + goalkeeper_save_points
       + bonus_points_estimate (from BPS rate)
       - card_risk

It is a transparent, tunable heuristic model in the same spirit as the
community "expected points" models (e.g. FPL Review / FPL Form) rather than
FPL's own opaque ep_next field - though ep_next (when available) is blended
in at a small weight as a sanity anchor.
"""
import json
import math
from datetime import datetime, timezone
from pathlib import Path

RAW_DIR = Path(__file__).parent.parent / "data_raw"
OUT_DIR = Path(__file__).parent.parent / "docs" / "data"
OUT_DIR.mkdir(parents=True, exist_ok=True)

HORIZON = 5          # gameweeks to forecast forward
DECAY = 0.82         # discount applied per gameweek further into the future
FORM_WEIGHT = 0.35   # blend of recent form vs season-long underlying rate
EP_ANCHOR_WEIGHT = 0.12  # small blend with FPL's own ep_next, when present

POSITION_MAP = {1: "GKP", 2: "DEF", 3: "MID", 4: "FWD"}
GOAL_VALUE = {1: 6, 2: 6, 3: 5, 4: 4}      # points per goal by position
CS_VALUE = {1: 4, 2: 4, 3: 1, 4: 0}        # clean sheet points by position

FDR_CS_BASE = {1: 0.58, 2: 0.47, 3: 0.36, 4: 0.25, 5: 0.15}
FDR_ATT_MULT = {1: 1.30, 2: 1.15, 3: 1.00, 4: 0.85, 5: 0.70}


def load(name):
    return json.loads((RAW_DIR / name).read_text())


def safe_float(x, default=0.0):
    try:
        if x is None or x == "":
            return default
        return float(x)
    except (TypeError, ValueError):
        return default


def build_team_lookup(bootstrap):
    return {t["id"]: t for t in bootstrap["teams"]}


def build_fixture_lookup(fixtures):
    """team_id -> ordered list of upcoming (unfinished) fixtures."""
    by_team = {}
    for f in fixtures:
        if f.get("finished") or f.get("event") is None:
            continue
        for side, opp_side, is_home in (
            ("team_h", "team_a", True),
            ("team_a", "team_h", False),
        ):
            team_id = f[side]
            by_team.setdefault(team_id, []).append(
                {
                    "event": f["event"],
                    "opponent": f[opp_side],
                    "is_home": is_home,
                    "difficulty": f["team_h_difficulty"] if is_home else f["team_a_difficulty"],
                }
            )
    for team_id in by_team:
        by_team[team_id].sort(key=lambda x: x["event"])
    return by_team


def recent_minutes_profile(summary):
    """Average minutes/appearance and starts-share over the last 5 played games."""
    if not summary or "history" not in summary:
        return None
    history = [h for h in summary["history"] if h.get("minutes", 0) > 0]
    if not history:
        return None
    last5 = history[-5:]
    avg_mins = sum(h["minutes"] for h in last5) / len(last5)
    full_share = sum(1 for h in last5 if h["minutes"] >= 60) / len(last5)
    return {"avg_mins": avg_mins, "full_share": full_share, "n": len(last5)}


def expected_minutes_and_play_probs(player, profile):
    """Returns (expected_minutes, prob_60plus, prob_1to59)."""
    status = player.get("status", "a")
    chance = player.get("chance_of_playing_next_round")
    availability = 1.0
    if status != "a":
        availability = safe_float(chance, 50) / 100.0 if chance is not None else 0.25
    elif chance is not None:
        availability = safe_float(chance, 100) / 100.0

    if profile and profile["n"] >= 2:
        avg_mins = profile["avg_mins"]
        full_share = profile["full_share"]
    else:
        season_mins = player.get("minutes", 0)
        # crude fallback: assume ~ minutes spread over 15 possible starts so far
        avg_mins = min(90, season_mins / 10) if season_mins else 0
        full_share = 0.5 if season_mins > 450 else 0.15

    expected_minutes = avg_mins * availability
    prob_appear = availability * min(1.0, 0.4 + full_share)
    prob_60plus = prob_appear * full_share
    prob_1to59 = max(0.0, prob_appear - prob_60plus)
    return expected_minutes, prob_60plus, prob_1to59


def underlying_rates(player, minutes_played):
    """xG/90 and xA/90 blended from season underlying stats + recent form."""
    mins90 = max(minutes_played, 1) / 90.0
    xg = safe_float(player.get("expected_goals"))
    xa = safe_float(player.get("expected_assists"))
    xg90 = xg / mins90 if mins90 > 0 else 0.0
    xa90 = xa / mins90 if mins90 > 0 else 0.0

    # position-based small priors so players with little/no minutes (new
    # signings, pre-season) aren't scored as zero.
    pos = player["element_type"]
    prior_xg90 = {1: 0.0, 2: 0.03, 3: 0.10, 4: 0.22}[pos]
    prior_xa90 = {1: 0.0, 2: 0.04, 3: 0.09, 4: 0.06}[pos]

    if minutes_played < 180:
        blend = minutes_played / 180.0
        xg90 = xg90 * blend + prior_xg90 * (1 - blend)
        xa90 = xa90 * blend + prior_xa90 * (1 - blend)

    return xg90, xa90


def bps_bonus_estimate(player, expected_minutes):
    bps = safe_float(player.get("bps"))
    minutes = max(player.get("minutes", 0), 1)
    bps90 = bps / (minutes / 90.0)
    # Rough mapping: top bonus earners (bps90 > ~30) net ~0.4-0.6 bonus pts/game
    est = max(0.0, (bps90 - 18) / 40.0) * (expected_minutes / 90.0)
    return min(est, 1.4)


def card_risk(player, expected_minutes):
    minutes = max(player.get("minutes", 0), 1)
    yc = safe_float(player.get("yellow_cards"))
    rc = safe_float(player.get("red_cards"))
    yc90 = yc / (minutes / 90.0)
    rc90 = rc / (minutes / 90.0)
    return (yc90 * 1 + rc90 * 3) * (expected_minutes / 90.0)


def gk_save_points(player, expected_minutes):
    saves = safe_float(player.get("saves"))
    minutes = max(player.get("minutes", 0), 1)
    saves90 = saves / (minutes / 90.0)
    return (saves90 / 3.0) * (expected_minutes / 90.0)  # 1pt per 3 saves


def team_strength_factor(teams, team_id, opp_id, is_home):
    """Adjust clean-sheet base rate using relative attack/defence strength."""
    team = teams[team_id]
    opp = teams[opp_id]
    my_def = team["strength_defence_home"] if is_home else team["strength_defence_away"]
    opp_att = opp["strength_attack_away"] if is_home else opp["strength_attack_home"]
    # league-average strength is ~1100-1250 depending on season; use ratio vs 1150
    ratio = 1150 / max(opp_att, 1) * (my_def / 1150)
    return max(0.5, min(1.8, ratio))


def compute_player_forecast(player, team_id, teams, fixture_list, summary):
    pos = player["element_type"]
    profile = recent_minutes_profile(summary)
    expected_minutes, p60, p1to59 = expected_minutes_and_play_probs(player, profile)
    xg90, xa90 = underlying_rates(player, player.get("minutes", 0))

    # blend in recent-form signal (FPL 'form' = pts/match last 30 days)
    form = safe_float(player.get("form"))
    ppg = safe_float(player.get("points_per_game"))
    form_signal = (form * FORM_WEIGHT + ppg * (1 - FORM_WEIGHT)) if (form or ppg) else None

    ep_next = safe_float(player.get("ep_next")) if player.get("ep_next") not in (None, "") else None

    gw_forecasts = []
    upcoming = fixture_list.get(team_id, [])[:HORIZON]

    if not upcoming:
        return {"per_gw": [], "xP_next": 0.0, "xP_3gw": 0.0, "xP_5gw": 0.0, "blank_next": True}

    # group by event in case of double gameweeks
    events = sorted(set(f["event"] for f in upcoming))

    for idx, ev in enumerate(events):
        fixtures_this_gw = [f for f in upcoming if f["event"] == ev]
        decay = DECAY ** idx
        gw_xp = 0.0
        opponents = []
        for fx in fixtures_this_gw:
            opp_id = fx["opponent"]
            is_home = fx["is_home"]
            fdr = fx["difficulty"]
            opponents.append({
                "opp": teams[opp_id]["short_name"],
                "home": is_home,
                "fdr": fdr,
            })

            att_mult = FDR_ATT_MULT.get(fdr, 1.0) * team_strength_factor(teams, team_id, opp_id, is_home)
            cs_base = FDR_CS_BASE.get(fdr, 0.30)
            cs_prob = max(0.03, min(0.75, cs_base + (0.04 if is_home else -0.04)))

            app_pts = 2 * p60 + 1 * p1to59
            goal_pts = xg90 * (expected_minutes / 90.0) * att_mult * GOAL_VALUE[pos]
            assist_pts = xa90 * (expected_minutes / 90.0) * att_mult * 3
            cs_pts = cs_prob * CS_VALUE[pos] * (p60)  # need 60+ mins for CS credit
            save_pts = gk_save_points(player, expected_minutes) if pos == 1 else 0.0
            bonus_pts = bps_bonus_estimate(player, expected_minutes)
            cards = card_risk(player, expected_minutes)

            fixture_xp = app_pts + goal_pts + assist_pts + cs_pts + save_pts + bonus_pts - cards
            gw_xp += max(0.0, fixture_xp)

        # light blend with FPL's own next-gw estimate and recent form, first GW only
        if idx == 0:
            blended = gw_xp
            if ep_next is not None and ep_next > 0:
                blended = blended * (1 - EP_ANCHOR_WEIGHT) + ep_next * EP_ANCHOR_WEIGHT
            gw_xp = blended

        gw_forecasts.append({
            "event": ev,
            "xP": round(gw_xp, 2),
            "opponents": opponents,
        })

    xp_next = gw_forecasts[0]["xP"] if gw_forecasts else 0.0
    xp_3 = sum(g["xP"] * (DECAY ** i) for i, g in enumerate(gw_forecasts[:3]))
    xp_5 = sum(g["xP"] * (DECAY ** i) for i, g in enumerate(gw_forecasts[:5]))

    return {
        "per_gw": gw_forecasts,
        "xP_next": round(xp_next, 2),
        "xP_3gw": round(xp_3, 2),
        "xP_5gw": round(xp_5, 2),
        "blank_next": False,
    }


def main():
    bootstrap = load("bootstrap.json")
    fixtures = load("fixtures.json")
    try:
        summaries_raw = load("summaries.json")
        summaries = {int(k): v for k, v in summaries_raw.items()}
    except FileNotFoundError:
        summaries = {}

    teams = build_team_lookup(bootstrap)
    fixture_list = build_fixture_lookup(fixtures)

    events = bootstrap["events"]
    next_event = next((e for e in events if e.get("is_next")), None)
    current_event = next((e for e in events if e.get("is_current")), None)

    players_out = []
    for player in bootstrap["elements"]:
        pid = player["id"]
        team_id = player["team"]
        summary = summaries.get(pid)
        forecast = compute_player_forecast(player, team_id, teams, fixture_list, summary)

        players_out.append({
            "id": pid,
            "name": player["web_name"],
            "full_name": f"{player['first_name']} {player['second_name']}".strip(),
            "team": teams[team_id]["short_name"],
            "team_id": team_id,
            "pos": POSITION_MAP[player["element_type"]],
            "pos_id": player["element_type"],
            "cost": round(player["now_cost"] / 10.0, 1),
            "selected_by": safe_float(player.get("selected_by_percent")),
            "status": player.get("status", "a"),
            "news": player.get("news", ""),
            "xP_next": forecast["xP_next"],
            "xP_3gw": forecast["xP_3gw"],
            "xP_5gw": forecast["xP_5gw"],
            "value_next": round(forecast["xP_next"] / max(player["now_cost"] / 10.0, 4.0), 3),
            "fixtures": forecast["per_gw"],
            "blank_next": forecast["blank_next"],
        })

    out = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "next_event": next_event["id"] if next_event else (current_event["id"] + 1 if current_event else 1),
        "current_event": current_event["id"] if current_event else 0,
        "players": players_out,
        "teams": [{"id": t["id"], "name": t["name"], "short_name": t["short_name"]} for t in bootstrap["teams"]],
    }

    (OUT_DIR / "players.json").write_text(json.dumps(out))
    print(f"Wrote forecasts for {len(players_out)} players -> {OUT_DIR / 'players.json'}")


if __name__ == "__main__":
    main()
