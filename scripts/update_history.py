#!/usr/bin/env python3
"""Append the latest DTE service-area outage observation to site history."""

from __future__ import annotations

import json
import os
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


SOURCE_URL = "https://outage.dteenergy.com/situations.json"
ROOT = Path(__file__).resolve().parents[1]
HISTORY_PATH = ROOT / "site" / "data" / "history.json"
RETENTION_DAYS = int(os.environ.get("DTE_HISTORY_RETENTION_DAYS", "400"))


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def parse_timestamp(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(timezone.utc)


def fetch_summary() -> dict:
    request = Request(
        SOURCE_URL,
        headers={
            "Accept": "application/json, text/plain, */*",
            "User-Agent": "DTEBeHurry/1.0 (+https://github.com/Ocelot-29A/DTEBeHurry)",
        },
    )
    try:
        with urlopen(request, timeout=25) as response:
            return json.loads(response.read().decode("utf-8"))
    except (HTTPError, URLError, TimeoutError, json.JSONDecodeError) as error:
        raise RuntimeError(f"Unable to fetch DTE outage summary: {error}") from error


def validate_and_transform(summary: dict) -> dict:
    required = {
        "lastUpdated",
        "totalCustomers",
        "customersAffected",
        "customersWithPower",
        "percentageWithPower",
    }
    missing = required - summary.keys()
    if missing:
        raise ValueError(f"DTE response is missing fields: {', '.join(sorted(missing))}")

    source_updated = parse_timestamp(str(summary["lastUpdated"]))
    total = int(summary["totalCustomers"])
    affected = int(summary["customersAffected"])
    with_power = int(summary["customersWithPower"])
    percentage_with_power = float(summary["percentageWithPower"])

    if total <= 0 or not 0 <= affected <= total or not 0 <= with_power <= total:
        raise ValueError("DTE response contains invalid customer totals")
    if not 0 <= percentage_with_power <= 100:
        raise ValueError("DTE response contains an invalid percentageWithPower")

    # Customer counts preserve more precision than the already-rounded with-power percentage.
    interrupted_percentage = round((affected / total) * 100, 4)
    return {
        "timestamp": source_updated.isoformat().replace("+00:00", "Z"),
        "value": interrupted_percentage,
        "customersAffected": affected,
        "customersWithPower": with_power,
        "totalCustomers": total,
        "percentageWithPower": percentage_with_power,
    }


def load_history() -> dict:
    if not HISTORY_PATH.exists():
        return {
            "schemaVersion": 1,
            "metric": "Power Interrupted",
            "source": SOURCE_URL,
            "generatedAt": None,
            "points": [],
        }
    with HISTORY_PATH.open("r", encoding="utf-8") as file:
        history = json.load(file)
    if not isinstance(history.get("points"), list):
        raise ValueError("history.json points must be an array")
    return history


def update_history(history: dict, observation: dict) -> tuple[dict, bool]:
    previous_points = history["points"]
    by_timestamp = {
        str(point["timestamp"]): point
        for point in history["points"]
        if isinstance(point, dict) and point.get("timestamp")
    }
    changed = by_timestamp.get(observation["timestamp"]) != observation
    by_timestamp[observation["timestamp"]] = observation

    cutoff = utc_now() - timedelta(days=RETENTION_DAYS)
    retained = [
        point
        for point in by_timestamp.values()
        if parse_timestamp(str(point["timestamp"])) >= cutoff
    ]
    retained.sort(key=lambda point: parse_timestamp(str(point["timestamp"])))
    changed = changed or retained != previous_points

    history.update(
        {
            "schemaVersion": 1,
            "metric": "Power Interrupted",
            "source": SOURCE_URL,
            "generatedAt": (
                utc_now().isoformat().replace("+00:00", "Z")
                if changed
                else history.get("generatedAt")
            ),
            "retentionDays": RETENTION_DAYS,
            "points": retained,
        }
    )
    return history, changed


def main() -> int:
    try:
        observation = validate_and_transform(fetch_summary())
        history, changed = update_history(load_history(), observation)
        HISTORY_PATH.parent.mkdir(parents=True, exist_ok=True)
        HISTORY_PATH.write_text(
            json.dumps(history, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        action = "appended" if changed else "already present"
        print(
            f"Observation {action}: {observation['timestamp']} — "
            f"{observation['value']:.2f}% interrupted"
        )
        return 0
    except (RuntimeError, ValueError, OSError) as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
