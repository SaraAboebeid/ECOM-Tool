"""How one building's surplus is shared between members short in the same hour.

The peer-to-peer step of the dispatcher, on its own: a surplus of 10 kWh and
three members short 8, 8 and 4 kWh - not enough for everyone, which is the only
case where the rule matters.
"""
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import toolkit  # noqa: F401  - puts ECOMToolkit on sys.path
from ECOMToolkit.analysis.dispatcher import ECOMDispatcher


def share(rule, positions=None):
    flows = {}
    fake = SimpleNamespace(sharing_rule=rule, positions=positions or {})
    fake._update_flow = lambda a, b, t, v: flows.__setitem__((a, b), flows.get((a, b), 0) + v)
    fake._nearest_first = lambda src, cands: ECOMDispatcher._nearest_first(fake, src, cands)
    state = {"surplus": {"Sun": 10.0, "A": 0, "B": 0, "C": 0},
             "deficit": {"Sun": 0, "A": 8.0, "B": 8.0, "C": 4.0}}
    ECOMDispatcher._dispatch_peer_to_peer(fake, 0, state)
    return {b: round(flows.get(("Sun", b), 0.0), 6) for b in "ABC"}, state


def test_order_serves_the_list_in_turn():
    got, _ = share("order")
    assert got == {"A": 8.0, "B": 2.0, "C": 0.0}


def test_proportional_gives_everyone_the_same_share_of_their_need():
    got, state = share("proportional")
    assert got == {"A": 4.0, "B": 4.0, "C": 2.0}          # half of each need
    assert state["surplus"]["Sun"] == pytest.approx(0.0)


def test_nearest_serves_the_closest_first():
    where = {"Sun": (0, 0), "A": (100, 0), "B": (50, 0), "C": (10, 0)}
    got, _ = share("nearest", where)
    assert got == {"A": 0.0, "B": 6.0, "C": 4.0}


def test_nearest_without_positions_falls_back_to_list_order():
    got, _ = share("nearest", {})
    assert got == {"A": 8.0, "B": 2.0, "C": 0.0}


def test_every_rule_moves_the_same_energy():
    for rule in ("order", "proportional", "nearest"):
        got, _ = share(rule, {"Sun": (0, 0), "A": (1, 0), "B": (2, 0), "C": (3, 0)})
        assert sum(got.values()) == pytest.approx(10.0), rule
