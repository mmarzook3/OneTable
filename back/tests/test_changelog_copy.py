import sys
from pathlib import Path

_BACK_ROOT = Path(__file__).resolve().parent.parent
if str(_BACK_ROOT) not in sys.path:
    sys.path.insert(0, str(_BACK_ROOT))

from app.main import _staff_changelog_copy


def test_staff_changelog_removes_retired_positioning() -> None:
    result = _staff_changelog_copy(
        "Open-source release; open source deployment under AGPLv3 with source code access."
    )
    lowered = result.lower()
    assert "open source" not in lowered
    assert "open-source" not in lowered
    assert "agpl" not in lowered
    assert "source code" not in lowered
    assert "platform" in lowered
    assert "product licence" in lowered
    assert "product repository" in lowered
