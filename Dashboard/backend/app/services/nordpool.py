"""Nord Pool day-ahead prices, in pure Python.

The Grasshopper component uses System.Net.WebClient, which is .NET only and
unavailable to a plain CPython backend, so the request is reimplemented on
urllib here.

Two corrections against that version:

1. Timestamps come from each entry's own deliveryStart, not its position in the
   list. The original built them as "{date} {index:02d}:00", which misaligns on
   the DST days that have 23 or 25 hours, and again whenever an hour is missing.

2. A failed day is recorded rather than skipped with a printed warning. Silently
   dropping days leaves a shorter series that still looks valid.

Prices are returned in SEK/kWh (the API quotes currency per MWh).
"""
from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from datetime import date, timedelta
from pathlib import Path
from typing import Optional

BASE_URL = "https://dataportal-api.nordpoolgroup.com/api/DayAheadPrices"
TIMEOUT_SECONDS = 30
_CACHE_VERSION = 1


class NordPoolUnavailable(RuntimeError):
    """Prices could not be fetched and are not cached."""


@dataclass
class PriceSeries:
    timestamps: list[str] = field(default_factory=list)
    prices: list[float] = field(default_factory=list)   # SEK/kWh
    missing_days: list[str] = field(default_factory=list)

    def __len__(self) -> int:
        return len(self.prices)

    @property
    def average(self) -> float:
        return sum(self.prices) / len(self.prices) if self.prices else 0.0

    @property
    def minimum(self) -> float:
        return min(self.prices) if self.prices else 0.0

    @property
    def maximum(self) -> float:
        return max(self.prices) if self.prices else 0.0


class NordPoolClient:
    def __init__(self, cache_dir: Path, allow_network: bool = True):
        self.cache_dir = Path(cache_dir)
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self.allow_network = allow_network
        self.stats = {"cache_hits": 0, "network_calls": 0}

    # ---------------------------------------------------------------- public

    def fetch_range(
        self,
        area: str,
        start: str,
        end: str,
        currency: str = "SEK",
    ) -> PriceSeries:
        first, last = date.fromisoformat(start), date.fromisoformat(end)
        if last < first:
            raise ValueError(f"end date {end} is before start date {start}")

        series = PriceSeries()
        day = first
        while day <= last:
            try:
                stamps, prices = self._fetch_day(area, day, currency)
                series.timestamps.extend(stamps)
                series.prices.extend(prices)
            except NordPoolUnavailable:
                series.missing_days.append(day.isoformat())
            day += timedelta(days=1)

        if not series.prices:
            raise NordPoolUnavailable(
                f"No Nord Pool prices for {area} between {start} and {end}. "
                f"{len(series.missing_days)} day(s) failed."
            )
        return series

    # ---------------------------------------------------------------- internal

    def _cache_path(self, area: str, day: date, currency: str) -> Path:
        return self.cache_dir / f"v{_CACHE_VERSION}_{area}_{currency}_{day.isoformat()}.json"

    def _fetch_day(
        self, area: str, day: date, currency: str
    ) -> tuple[list[str], list[float]]:
        path = self._cache_path(area, day, currency)
        if path.is_file():
            payload = json.loads(path.read_text(encoding="utf-8"))
            self.stats["cache_hits"] += 1
            return payload["timestamps"], payload["prices"]

        if not self.allow_network:
            raise NordPoolUnavailable(
                f"No cached prices for {area} on {day} and network access is disabled."
            )

        data = self._request(area, day, currency)
        stamps, prices = self._parse(data, area, day)
        path.write_text(
            json.dumps({"timestamps": stamps, "prices": prices}), encoding="utf-8"
        )
        self.stats["network_calls"] += 1
        return stamps, prices

    def _request(self, area: str, day: date, currency: str) -> dict:
        query = urllib.parse.urlencode({
            "date": day.isoformat(),
            "market": "DayAhead",
            "deliveryArea": area,
            "currency": currency,
        })
        try:
            with urllib.request.urlopen(f"{BASE_URL}?{query}", timeout=TIMEOUT_SECONDS) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except (urllib.error.URLError, TimeoutError, ValueError) as err:
            raise NordPoolUnavailable(f"{area} {day}: {err}") from err

    @staticmethod
    def _parse(data: dict, area: str, day: date) -> tuple[list[str], list[float]]:
        entries = data.get("multiAreaEntries") or []
        if not entries:
            raise NordPoolUnavailable(f"{area} {day}: response contained no entries")

        stamps: list[str] = []
        prices: list[float] = []
        for index, entry in enumerate(entries):
            per_area = entry.get("entryPerArea") or {}
            raw = per_area.get(area)
            if raw is None:
                continue
            # Prefer the API's own timestamp; the index is only a fallback and
            # is wrong on 23- and 25-hour DST days.
            stamp = entry.get("deliveryStart") or f"{day.isoformat()} {index:02d}:00"
            stamps.append(str(stamp))
            prices.append(float(raw) / 1000.0)   # currency/MWh -> currency/kWh

        if not prices:
            raise NordPoolUnavailable(f"{area} {day}: no prices for this delivery area")
        return stamps, prices


def resolve_price_values(
    spec,
    client: Optional[NordPoolClient] = None,
) -> Optional[list[float]]:
    """Fetch the raw series for a PriceSpec, or None when it needs no fetching."""
    if not spec.is_nordpool:
        return None
    if client is None:
        raise NordPoolUnavailable(
            "PriceSpec requests Nord Pool prices but no NordPoolClient was supplied."
        )
    return client.fetch_range(
        area=spec.nordpool_area,
        start=spec.nordpool_start,
        end=spec.nordpool_end,
    ).prices
