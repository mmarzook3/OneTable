from pathlib import Path

from PIL import Image

from app.seeds.ensure_landing_demo import DEMO_PRODUCTS


def test_every_landing_demo_product_has_optimised_image() -> None:
    asset_dir = Path(__file__).resolve().parent.parent / "app" / "seeds" / "assets" / "demo-menu"
    filenames = [row[4] for row in DEMO_PRODUCTS]
    assert len(filenames) == 10
    assert len(set(filenames)) == len(filenames)

    for filename in filenames:
        path = asset_dir / filename
        assert path.is_file(), filename
        assert path.stat().st_size < 300_000, filename
        with Image.open(path) as image:
            assert image.format == "JPEG", filename
            assert image.size == (900, 900), filename
            assert image.mode == "RGB", filename
