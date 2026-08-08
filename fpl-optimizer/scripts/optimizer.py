"""
optimizer.py
Integer-linear-program squad selector. Builds the FPL-legal 15-man squad
(2 GKP / 5 DEF / 5 MID / 3 FWD, budget <= 100.0m, max 3 players per real
team) that maximises projected points, then picks the best legal starting
XI + captain from within that squad.

Also exposed as a reusable function (optimize_squad) so the same logic can
be pointed at "budget remaining + must include current squad minus N
transfers" scenarios if run locally with a squad file - the deployed
weekly job uses it to publish a from-scratch "optimal" reference squad
(useful for GW1, and as a wildcard/benchmark comparison every week after).
"""
import json
from pathlib import Path

import pulp

DATA_DIR = Path(__file__).parent.parent / "docs" / "data"
BUDGET = 100.0
SQUAD_SLOTS = {"GKP": 2, "DEF": 5, "MID": 5, "FWD": 3}
MAX_PER_TEAM = 3

# Legal starting formations: (GKP, DEF, MID, FWD) always sums to 11, GKP=1
VALID_FORMATIONS = [
    (1, d, m, f)
    for d in range(3, 6)
    for m in range(2, 6)
    for f in range(1, 4)
    if d + m + f == 10
]


def load_players():
    data = json.loads((DATA_DIR / "players.json").read_text())
    return data


def optimize_squad(players, objective_key="xP_5gw", budget=BUDGET,
                    must_include=None, must_exclude=None, bench_weight=0.15):
    """
    players: list of player dicts (as in docs/data/players.json)
    objective_key: which forecast field to maximise ('xP_next', 'xP_3gw', 'xP_5gw')
    must_include / must_exclude: sets of player ids to force in/out
    bench_weight: how much bench strength counts toward the objective
                  (keeps the optimizer from picking a 0-cost bench)
    Returns dict with squad, starting_xi, bench, captain, vice_captain, formation, cost.
    """
    must_include = must_include or set()
    must_exclude = must_exclude or set()

    prob = pulp.LpProblem("fpl_squad", pulp.LpMaximize)

    ids = [p["id"] for p in players if p["id"] not in must_exclude]
    pmap = {p["id"]: p for p in players}

    squad_var = pulp.LpVariable.dicts("squad", ids, cat="Binary")
    start_var = pulp.LpVariable.dicts("start", ids, cat="Binary")
    capt_var = pulp.LpVariable.dicts("capt", ids, cat="Binary")

    def xp(pid):
        return pmap[pid].get(objective_key, 0.0) or 0.0

    # Objective: starting XI points + captain doubles + a small weight on
    # the rest of the squad (bench) so the optimizer favours a usable bench
    # rather than the 4 cheapest fillers available.
    prob += (
        pulp.lpSum(start_var[i] * xp(i) for i in ids)
        + pulp.lpSum(capt_var[i] * xp(i) for i in ids)
        + bench_weight * pulp.lpSum((squad_var[i] - start_var[i]) * xp(i) for i in ids)
    )

    # --- squad composition ---
    prob += pulp.lpSum(squad_var[i] for i in ids) == 15
    for pos, count in SQUAD_SLOTS.items():
        prob += pulp.lpSum(squad_var[i] for i in ids if pmap[i]["pos"] == pos) == count

    # --- budget ---
    prob += pulp.lpSum(squad_var[i] * pmap[i]["cost"] for i in ids) <= budget

    # --- max 3 per real club ---
    teams = set(pmap[i]["team_id"] for i in ids)
    for t in teams:
        prob += pulp.lpSum(squad_var[i] for i in ids if pmap[i]["team_id"] == t) <= MAX_PER_TEAM

    # --- starting XI must be a subset of the squad ---
    for i in ids:
        prob += start_var[i] <= squad_var[i]
        prob += capt_var[i] <= start_var[i]
    prob += pulp.lpSum(start_var[i] for i in ids) == 11
    prob += pulp.lpSum(capt_var[i] for i in ids) == 1

    # --- starting XI formation legality (1 GKP, 3-5 DEF, 2-5 MID, 1-3 FWD) ---
    prob += pulp.lpSum(start_var[i] for i in ids if pmap[i]["pos"] == "GKP") == 1
    prob += pulp.lpSum(start_var[i] for i in ids if pmap[i]["pos"] == "DEF") >= 3
    prob += pulp.lpSum(start_var[i] for i in ids if pmap[i]["pos"] == "DEF") <= 5
    prob += pulp.lpSum(start_var[i] for i in ids if pmap[i]["pos"] == "MID") >= 2
    prob += pulp.lpSum(start_var[i] for i in ids if pmap[i]["pos"] == "MID") <= 5
    prob += pulp.lpSum(start_var[i] for i in ids if pmap[i]["pos"] == "FWD") >= 1
    prob += pulp.lpSum(start_var[i] for i in ids if pmap[i]["pos"] == "FWD") <= 3

    # --- forced picks ---
    for i in must_include:
        if i in squad_var:
            prob += squad_var[i] == 1

    prob.solve(pulp.PULP_CBC_CMD(msg=False))

    if pulp.LpStatus[prob.status] != "Optimal":
        raise RuntimeError(f"Optimizer did not find an optimal solution: {pulp.LpStatus[prob.status]}")

    squad_ids = [i for i in ids if squad_var[i].value() == 1]
    start_ids = [i for i in ids if start_var[i].value() == 1]
    capt_id = next(i for i in ids if capt_var[i].value() == 1)
    bench_ids = [i for i in squad_ids if i not in start_ids]

    # vice captain = highest-xP starter that isn't the captain
    vice_id = max((i for i in start_ids if i != capt_id), key=xp)

    pos_counts = {"GKP": 0, "DEF": 0, "MID": 0, "FWD": 0}
    for i in start_ids:
        pos_counts[pmap[i]["pos"]] += 1
    formation = f"{pos_counts['DEF']}-{pos_counts['MID']}-{pos_counts['FWD']}"

    # order bench: GK first (if not starting), then by descending xP
    bench_gk = [i for i in bench_ids if pmap[i]["pos"] == "GKP"]
    bench_outfield = sorted([i for i in bench_ids if pmap[i]["pos"] != "GKP"], key=xp, reverse=True)
    bench_ordered = bench_gk + bench_outfield

    total_cost = sum(pmap[i]["cost"] for i in squad_ids)

    return {
        "objective": objective_key,
        "formation": formation,
        "total_cost": round(total_cost, 1),
        "budget_left": round(budget - total_cost, 1),
        "captain": pmap[capt_id]["name"],
        "captain_id": capt_id,
        "vice_captain": pmap[vice_id]["name"],
        "vice_captain_id": vice_id,
        "starting_xi": [pmap[i] for i in sorted(start_ids, key=lambda i: pmap[i]["pos_id"])],
        "bench": [pmap[i] for i in bench_ordered],
        "squad": [pmap[i] for i in squad_ids],
        "projected_points": round(
            sum(xp(i) for i in start_ids) + xp(capt_id), 2
        ),
    }


def main():
    data = load_players()
    players = data["players"]

    # Exclude injured/suspended/unavailable-for-a-while players from the
    # "optimal" reference build so it's actually usable, not theoretical.
    usable = [p for p in players if p["status"] in ("a", "d")]

    result_5gw = optimize_squad(usable, objective_key="xP_5gw")
    result_next = optimize_squad(usable, objective_key="xP_next")

    out = {
        "generated_at": data["generated_at"],
        "next_event": data["next_event"],
        "recommended_5gw_horizon": result_5gw,
        "recommended_next_gw": result_next,
    }

    (DATA_DIR / "recommended_squad.json").write_text(json.dumps(out, default=lambda o: o))
    print("Wrote", DATA_DIR / "recommended_squad.json")
    print(f"5-GW horizon squad cost: {result_5gw['total_cost']}m, "
          f"formation {result_5gw['formation']}, projected {result_5gw['projected_points']} pts")


if __name__ == "__main__":
    main()
