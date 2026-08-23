from __future__ import annotations

import re
import sys
from pathlib import Path

_ROOT = Path(__file__).resolve().parent.parent
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from app.seeds.seed_yue_tree_pilot import PILOT_PRODUCTS  # noqa: E402


def test_yue_tree_pilot_menu_does_not_promote_alcohol() -> None:
    menu_text = " ".join(
        str(value or "")
        for product in PILOT_PRODUCTS
        for value in product
    ).casefold()
    promoted_terms = ("alcohol", "lager", "beer", "wine", "cider", "ale", "spirits")

    for term in promoted_terms:
        assert re.search(rf"\b{re.escape(term)}\b", menu_text) is None

    assert any(product[0] == "Traditional Sausage Roll" for product in PILOT_PRODUCTS)
