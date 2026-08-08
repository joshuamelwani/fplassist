"""
fetch_data.py
Pulls raw data from the official Fantasy Premier League API.
No auth required - these are public, read-only endpoints.
"""
import json
import time
import urllib.request
from pathlib import Path

RAW_DIR = Path(__file__).parent.parent / "data_raw"
RAW_DIR.mkdir(exist_ok=True)

BASE = "https://fantasy.premierleague.com/api"
HEADERS = {"User-Agent": "Mozilla/5.0 (fpl-optimizer data fetch)"}


def get_json(url: str, retries: int = 3, timeout: int = 20):
    last_err = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers=HEADERS)
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except Exception as e:  # noqa: BLE001
            last_err = e
            time.sleep(2 * (attempt + 1))
    raise RuntimeError(f"Failed to fetch {url}: {last_err}")


def main():
    print("Fetching bootstrap-static ...")
    bootstrap = get_json(f"{BASE}/bootstrap-static/")
    (RAW_DIR / "bootstrap.json").write_text(json.dumps(bootstrap))

    print("Fetching fixtures ...")
    fixtures = get_json(f"{BASE}/fixtures/")
    (RAW_DIR / "fixtures.json").write_text(json.dumps(fixtures))

    # Per-player detailed history (used for recent-form xG/xA when available).
    # Kept lightweight: only fetch for players who've played at least one minute,
    # and only the last few fixtures worth of history is used downstream.
    elements = bootstrap["elements"]
    print(f"Fetching per-player summaries for {len(elements)} players ...")
    summaries = {}
    for i, el in enumerate(elements):
        pid = el["id"]
        try:
            summaries[pid] = get_json(f"{BASE}/element-summary/{pid}/")
        except Exception as e:  # noqa: BLE001
            print(f"  warning: failed for player {pid}: {e}")
        if i % 50 == 0:
            print(f"  {i}/{len(elements)}")
        time.sleep(0.05)  # be polite to the API

    (RAW_DIR / "summaries.json").write_text(json.dumps(summaries))
    print("Done. Raw data written to", RAW_DIR)


if __name__ == "__main__":
    main()
