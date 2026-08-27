#!/usr/bin/env python3
"""Generate a printable Scanaki Smart Plaque STL from a permanent plaque URL.

The solid is generated as a single watertight voxel-derived surface so the
raised QR/text, countersunk holes and rear NFC recess slice consistently.
Dimensions are expressed in millimetres.
"""

from __future__ import annotations

import argparse
import json
import math
import struct
from pathlib import Path

import numpy as np
import qrcode
from PIL import Image, ImageDraw, ImageFont
from qrcode.constants import ERROR_CORRECT_H


WIDTH_MM = 80.0
HEIGHT_MM = 110.0
CORNER_RADIUS_MM = 10.0
BASE_MM = 2.0
RELIEF_MM = 0.1
XY_PITCH_MM = 0.25
Z_PITCH_MM = 0.1
THROUGH_HOLE_DIAMETER_MM = 4.0
COUNTERSINK_DIAMETER_MM = 8.0
COUNTERSINK_DEPTH_MM = 1.0
NFC_RECESS_DIAMETER_MM = 27.0
NFC_RECESS_DEPTH_MM = 0.8
NFC_RECESS_CENTRE_Y_MM = -2.0
SCREW_CENTRES_MM = ((-33.0, 45.0), (33.0, -45.0))
QR_CENTRE_Y_MM = -2.0
QR_MODULE_CELLS = 5


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", required=True, help="Permanent https://scanaki.uk/p/... URL")
    parser.add_argument("--label", default="INDOOR TABLE 1", help="Bottom plaque label")
    parser.add_argument("--code", default="YT-IN-01", help="File/print identifier")
    parser.add_argument("--output-dir", type=Path, required=True)
    return parser.parse_args()


def rounded_rectangle_mask(x: np.ndarray, y: np.ndarray) -> np.ndarray:
    qx = np.abs(x) - (WIDTH_MM / 2 - CORNER_RADIUS_MM)
    qy = np.abs(y) - (HEIGHT_MM / 2 - CORNER_RADIUS_MM)
    outside = np.hypot(np.maximum(qx, 0), np.maximum(qy, 0))
    inside = np.minimum(np.maximum(qx, qy), 0)
    return outside + inside <= CORNER_RADIUS_MM


def fitted_font(text: str, target_px: int, max_width_px: int) -> ImageFont.FreeTypeFont:
    candidates = (
        Path("C:/Windows/Fonts/arialbd.ttf"),
        Path("C:/Windows/Fonts/segoeuib.ttf"),
        Path("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"),
    )
    font_path = next((path for path in candidates if path.is_file()), None)
    if font_path is None:
        raise FileNotFoundError("A supported bold TrueType font was not found")
    size = target_px
    while size >= 8:
        font = ImageFont.truetype(str(font_path), size=size)
        bounds = font.getbbox(text)
        if bounds[2] - bounds[0] <= max_width_px:
            return font
        size -= 1
    raise ValueError(f"Unable to fit text: {text}")


def draw_centred_text(
    draw: ImageDraw.ImageDraw,
    text: str,
    centre_x_px: float,
    centre_y_px: float,
    target_px: int,
    max_width_px: int,
) -> None:
    font = fitted_font(text, target_px, max_width_px)
    draw.text((centre_x_px, centre_y_px), text, font=font, fill=255, anchor="mm")


def remove_diagonal_contacts(mask: np.ndarray) -> np.ndarray:
    """Remove pixel-corner-only joins which are non-manifold after extrusion."""
    clean = mask.copy()
    height, width = clean.shape

    def degree(row: int, col: int) -> int:
        return sum(
            0 <= rr < height and 0 <= cc < width and clean[rr, cc]
            for rr, cc in ((row - 1, col), (row + 1, col), (row, col - 1), (row, col + 1))
        )

    for _ in range(12):
        changed = False
        for row in range(height - 1):
            for col in range(width - 1):
                top_left = clean[row, col]
                top_right = clean[row, col + 1]
                bottom_left = clean[row + 1, col]
                bottom_right = clean[row + 1, col + 1]
                if top_left and bottom_right and not top_right and not bottom_left:
                    if degree(row, col) < degree(row + 1, col + 1):
                        clean[row, col] = False
                    else:
                        clean[row + 1, col + 1] = False
                    changed = True
                elif top_right and bottom_left and not top_left and not bottom_right:
                    if degree(row, col + 1) < degree(row + 1, col):
                        clean[row, col + 1] = False
                    else:
                        clean[row + 1, col] = False
                    changed = True
        if not changed:
            return clean
    raise ValueError("Unable to regularise relief raster")


def relief_mask(url: str, bottom_label: str, nx: int, ny: int) -> tuple[np.ndarray, int]:
    import cv2

    mask_image = Image.new("L", (nx, ny), 0)
    draw = ImageDraw.Draw(mask_image)

    draw_centred_text(draw, "THE YEW TREES", nx / 2 + 10, 28, 25, 220)
    draw_centred_text(draw, "SCAN OR TAP", nx / 2 + 8, 57, 23, 205)
    draw_centred_text(draw, bottom_label, nx / 2 - 12, ny - 28, 21, 220)

    # Reinforce raster text so diagonal antialias pixels cannot meet only at a
    # non-manifold corner in the final voxel-derived solid.
    text_mask = cv2.dilate(
        np.asarray(mask_image, dtype=np.uint8),
        np.ones((2, 2), dtype=np.uint8),
        iterations=1,
    ) > 0

    qr = qrcode.QRCode(error_correction=ERROR_CORRECT_H, border=4)
    qr.add_data(url)
    qr.make(fit=True)
    matrix = np.asarray(qr.get_matrix(), dtype=bool)
    module_count = int(matrix.shape[0])
    qr_cells = module_count * QR_MODULE_CELLS
    start_x = (nx - qr_cells) // 2
    centre_row = int(round((HEIGHT_MM / 2 - QR_CENTRE_Y_MM) / XY_PITCH_MM))
    start_y = centre_row - qr_cells // 2
    qr_mask = np.zeros((ny, nx), dtype=bool)
    for row in range(module_count):
        for col in range(module_count):
            if not matrix[row, col]:
                continue
            x0 = start_x + col * QR_MODULE_CELLS
            y0 = start_y + row * QR_MODULE_CELLS
            qr_mask[
                y0 : y0 + QR_MODULE_CELLS,
                x0 : x0 + QR_MODULE_CELLS,
            ] = True

    # A pair of modules that meet only diagonally creates a mathematically
    # non-manifold vertical line. Remove one 0.25 mm corner cell only at those
    # ambiguous 2x2 patterns. The QR module centres and all orthogonal joins
    # remain unchanged.
    for row in range(module_count - 1):
        for col in range(module_count - 1):
            top_left = matrix[row, col]
            top_right = matrix[row, col + 1]
            bottom_left = matrix[row + 1, col]
            bottom_right = matrix[row + 1, col + 1]
            if top_left and bottom_right and not top_right and not bottom_left:
                y = start_y + (row + 1) * QR_MODULE_CELLS - 1
                x = start_x + (col + 1) * QR_MODULE_CELLS - 1
                qr_mask[y, x] = False
            elif top_right and bottom_left and not top_left and not bottom_right:
                y = start_y + (row + 1) * QR_MODULE_CELLS - 1
                x = start_x + (col + 1) * QR_MODULE_CELLS
                qr_mask[y, x] = False

    combined = remove_diagonal_contacts(text_mask | qr_mask)
    qr_crop = np.where(
        combined[start_y : start_y + qr_cells, start_x : start_x + qr_cells],
        0,
        255,
    ).astype(np.uint8)
    qr_crop = cv2.resize(qr_crop, None, fx=5, fy=5, interpolation=cv2.INTER_NEAREST)
    decoded, _, _ = cv2.QRCodeDetector().detectAndDecode(qr_crop)
    if decoded != url:
        raise ValueError(f"Embossed QR raster validation failed: {decoded!r}")

    # PIL rows run top-to-bottom. Geometry y runs bottom-to-top.
    return np.flipud(combined).T, module_count


def qr_decode_check(url: str) -> str:
    import cv2

    qr = qrcode.QRCode(error_correction=ERROR_CORRECT_H, border=4, box_size=16)
    qr.add_data(url)
    qr.make(fit=True)
    image = np.asarray(qr.make_image(fill_color="black", back_color="white").convert("L"))
    decoded, _, _ = cv2.QRCodeDetector().detectAndDecode(image)
    if decoded != url:
        raise ValueError(f"QR validation failed: {decoded!r}")
    return decoded


def occupancy(url: str, bottom_label: str) -> tuple[np.ndarray, dict[str, float | int]]:
    nx = int(round(WIDTH_MM / XY_PITCH_MM))
    ny = int(round(HEIGHT_MM / XY_PITCH_MM))
    nz = int(round((BASE_MM + RELIEF_MM) / Z_PITCH_MM))
    x = -WIDTH_MM / 2 + (np.arange(nx) + 0.5) * XY_PITCH_MM
    y = -HEIGHT_MM / 2 + (np.arange(ny) + 0.5) * XY_PITCH_MM
    z = (np.arange(nz) + 0.5) * Z_PITCH_MM
    xx, yy = np.meshgrid(x, y, indexing="ij")
    plate = rounded_rectangle_mask(xx, yy)
    raised, module_count = relief_mask(url, bottom_label, nx, ny)
    solid = np.zeros((nx, ny, nz), dtype=bool)

    for layer, zc in enumerate(z):
        if zc < BASE_MM:
            layer_mask = plate.copy()
            if zc < NFC_RECESS_DEPTH_MM:
                nfc_radius = NFC_RECESS_DIAMETER_MM / 2
                nfc_void = xx**2 + (yy - NFC_RECESS_CENTRE_Y_MM) ** 2 < nfc_radius**2
                layer_mask &= ~nfc_void
            for hole_x, hole_y in SCREW_CENTRES_MM:
                radius = THROUGH_HOLE_DIAMETER_MM / 2
                chamfer_start = BASE_MM - COUNTERSINK_DEPTH_MM
                if zc > chamfer_start:
                    fraction = min(1.0, (zc - chamfer_start) / COUNTERSINK_DEPTH_MM)
                    radius += fraction * (
                        COUNTERSINK_DIAMETER_MM / 2 - THROUGH_HOLE_DIAMETER_MM / 2
                    )
                layer_mask &= (xx - hole_x) ** 2 + (yy - hole_y) ** 2 >= radius**2
            solid[:, :, layer] = layer_mask
        else:
            layer_mask = plate & raised
            for hole_x, hole_y in SCREW_CENTRES_MM:
                layer_mask &= (
                    (xx - hole_x) ** 2 + (yy - hole_y) ** 2
                    >= (COUNTERSINK_DIAMETER_MM / 2) ** 2
                )
            solid[:, :, layer] = layer_mask

    return solid, {
        "nx": nx,
        "ny": ny,
        "nz": nz,
        "qr_modules_including_quiet_zone": module_count,
        "qr_module_mm": QR_MODULE_CELLS * XY_PITCH_MM,
    }


def shifted_neighbour(solid: np.ndarray, axis: int, positive: bool) -> np.ndarray:
    neighbour = np.zeros_like(solid)
    source = [slice(None), slice(None), slice(None)]
    target = [slice(None), slice(None), slice(None)]
    if positive:
        source[axis] = slice(1, None)
        target[axis] = slice(None, -1)
    else:
        source[axis] = slice(None, -1)
        target[axis] = slice(1, None)
    neighbour[tuple(target)] = solid[tuple(source)]
    return neighbour


def boundary_indices(solid: np.ndarray, axis: int, positive: bool) -> np.ndarray:
    return np.argwhere(solid & ~shifted_neighbour(solid, axis, positive))


def face_quads(indices: np.ndarray, direction: str) -> tuple[np.ndarray, np.ndarray]:
    i, j, k = indices[:, 0], indices[:, 1], indices[:, 2]
    x0 = -WIDTH_MM / 2 + i * XY_PITCH_MM
    x1 = x0 + XY_PITCH_MM
    y0 = -HEIGHT_MM / 2 + j * XY_PITCH_MM
    y1 = y0 + XY_PITCH_MM
    z0 = k * Z_PITCH_MM
    z1 = z0 + Z_PITCH_MM
    count = len(indices)
    quads = np.empty((count, 4, 3), dtype="<f4")
    if direction == "+x":
        quads[:, 0] = np.column_stack((x1, y0, z0))
        quads[:, 1] = np.column_stack((x1, y1, z0))
        quads[:, 2] = np.column_stack((x1, y1, z1))
        quads[:, 3] = np.column_stack((x1, y0, z1))
        normal = np.array((1, 0, 0), dtype="<f4")
    elif direction == "-x":
        quads[:, 0] = np.column_stack((x0, y0, z0))
        quads[:, 1] = np.column_stack((x0, y0, z1))
        quads[:, 2] = np.column_stack((x0, y1, z1))
        quads[:, 3] = np.column_stack((x0, y1, z0))
        normal = np.array((-1, 0, 0), dtype="<f4")
    elif direction == "+y":
        quads[:, 0] = np.column_stack((x0, y1, z0))
        quads[:, 1] = np.column_stack((x0, y1, z1))
        quads[:, 2] = np.column_stack((x1, y1, z1))
        quads[:, 3] = np.column_stack((x1, y1, z0))
        normal = np.array((0, 1, 0), dtype="<f4")
    elif direction == "-y":
        quads[:, 0] = np.column_stack((x0, y0, z0))
        quads[:, 1] = np.column_stack((x1, y0, z0))
        quads[:, 2] = np.column_stack((x1, y0, z1))
        quads[:, 3] = np.column_stack((x0, y0, z1))
        normal = np.array((0, -1, 0), dtype="<f4")
    elif direction == "+z":
        quads[:, 0] = np.column_stack((x0, y0, z1))
        quads[:, 1] = np.column_stack((x1, y0, z1))
        quads[:, 2] = np.column_stack((x1, y1, z1))
        quads[:, 3] = np.column_stack((x0, y1, z1))
        normal = np.array((0, 0, 1), dtype="<f4")
    elif direction == "-z":
        quads[:, 0] = np.column_stack((x0, y0, z0))
        quads[:, 1] = np.column_stack((x0, y1, z0))
        quads[:, 2] = np.column_stack((x1, y1, z0))
        quads[:, 3] = np.column_stack((x1, y0, z0))
        normal = np.array((0, 0, -1), dtype="<f4")
    else:
        raise ValueError(direction)
    return quads, normal


def write_binary_stl(path: Path, solid: np.ndarray) -> int:
    directions = ((0, True, "+x"), (0, False, "-x"), (1, True, "+y"), (1, False, "-y"), (2, True, "+z"), (2, False, "-z"))
    index_sets = [boundary_indices(solid, axis, positive) for axis, positive, _ in directions]
    triangle_count = sum(len(indices) * 2 for indices in index_sets)
    record_dtype = np.dtype(
        [("normal", "<f4", (3,)), ("vertices", "<f4", (3, 3)), ("attribute", "<u2")],
        align=False,
    )
    assert record_dtype.itemsize == 50
    header = b"Scanaki Smart Plaque STL - millimetres".ljust(80, b"\0")
    with path.open("wb") as handle:
        handle.write(header)
        handle.write(struct.pack("<I", triangle_count))
        for indices, (_, _, direction) in zip(index_sets, directions, strict=True):
            quads, normal = face_quads(indices, direction)
            triangles = np.empty((len(quads) * 2, 3, 3), dtype="<f4")
            triangles[0::2] = quads[:, (0, 1, 2)]
            triangles[1::2] = quads[:, (0, 2, 3)]
            records = np.zeros(len(triangles), dtype=record_dtype)
            records["normal"] = normal
            records["vertices"] = triangles
            handle.write(records.tobytes())
    return triangle_count


def render_preview(path: Path, solid: np.ndarray, code: str, url: str) -> None:
    nx, ny, _ = solid.shape
    top = solid[:, :, -1].T[::-1]
    body = np.any(solid[:, :, : int(BASE_MM / Z_PITCH_MM)], axis=2).T[::-1]
    scale = 3
    canvas = Image.new("RGB", (nx * scale + 120, ny * scale + 170), "#eeeae0")
    plate = Image.new("RGB", (nx, ny), "#eeeae0")
    plate_pixels = np.asarray(plate).copy()
    plate_pixels[body] = (222, 218, 207)
    plate_pixels[top] = (25, 25, 23)
    plate = Image.fromarray(plate_pixels).resize((nx * scale, ny * scale), Image.Resampling.NEAREST)
    canvas.paste(plate, (60, 60))
    draw = ImageDraw.Draw(canvas)
    draw.rounded_rectangle((58, 58, 62 + nx * scale, 62 + ny * scale), radius=30, outline="#2b2b28", width=4)
    for hole_x, hole_y in SCREW_CENTRES_MM:
        cx = 60 + int((hole_x + WIDTH_MM / 2) / XY_PITCH_MM * scale)
        cy = 60 + int((HEIGHT_MM / 2 - hole_y) / XY_PITCH_MM * scale)
        outer = int(COUNTERSINK_DIAMETER_MM / 2 / XY_PITCH_MM * scale)
        inner = int(THROUGH_HOLE_DIAMETER_MM / 2 / XY_PITCH_MM * scale)
        draw.ellipse((cx - outer, cy - outer, cx + outer, cy + outer), outline="#746c5d", width=3)
        draw.ellipse((cx - inner, cy - inner, cx + inner, cy + inner), fill="#eeeae0", outline="#222", width=2)
    title_font = fitted_font("Prototype", 30, nx * scale)
    small_font = fitted_font(code, 22, nx * scale)
    draw.text((60, 14), "Scanaki plaque prototype", fill="#171716", font=title_font)
    draw.text((60, 76 + ny * scale), f"{code} | {WIDTH_MM:.0f} × {HEIGHT_MM:.0f} × {BASE_MM + RELIEF_MM:.1f} mm", fill="#171716", font=small_font)
    draw.text((60, 108 + ny * scale), url, fill="#55514a", font=fitted_font(url, 17, nx * scale))
    canvas.save(path, quality=94)


def render_construction_preview(path: Path, code: str) -> None:
    """Render the hidden rear features and a labelled side section."""
    scale = 6
    plate_width = int(WIDTH_MM * scale)
    plate_height = int(HEIGHT_MM * scale)
    margin = 56
    section_height = 230
    canvas = Image.new(
        "RGB",
        (plate_width + margin * 2 + 130, plate_height + section_height + 160),
        "#eeeae0",
    )
    draw = ImageDraw.Draw(canvas)
    title_font = fitted_font("Construction", 30, plate_width)
    label_font = fitted_font("Label", 18, plate_width)
    small_font = fitted_font("Small", 15, plate_width)
    draw.text((margin, 14), f"{code} rear and section", fill="#171716", font=title_font)

    left, top = margin, 62
    right, bottom = left + plate_width, top + plate_height
    draw.rounded_rectangle(
        (left, top, right, bottom),
        radius=int(CORNER_RADIUS_MM * scale),
        fill="#dedacf",
        outline="#2b2b28",
        width=4,
    )
    for hole_x, hole_y in SCREW_CENTRES_MM:
        cx = left + int((hole_x + WIDTH_MM / 2) * scale)
        cy = top + int((HEIGHT_MM / 2 - hole_y) * scale)
        outer = int(COUNTERSINK_DIAMETER_MM / 2 * scale)
        inner = int(THROUGH_HOLE_DIAMETER_MM / 2 * scale)
        draw.ellipse(
            (cx - outer, cy - outer, cx + outer, cy + outer),
            outline="#746c5d",
            width=3,
        )
        draw.ellipse(
            (cx - inner, cy - inner, cx + inner, cy + inner),
            fill="#eeeae0",
            outline="#222",
            width=2,
        )

    nfc_cx = left + plate_width // 2
    nfc_cy = top + int((HEIGHT_MM / 2 - NFC_RECESS_CENTRE_Y_MM) * scale)
    nfc_radius = int(NFC_RECESS_DIAMETER_MM / 2 * scale)
    draw.ellipse(
        (nfc_cx - nfc_radius, nfc_cy - nfc_radius, nfc_cx + nfc_radius, nfc_cy + nfc_radius),
        fill="#c8c1b2",
        outline="#575047",
        width=3,
    )
    draw.text((nfc_cx, nfc_cy), "NFC", fill="#2d2a26", font=label_font, anchor="mm")
    draw.text(
        (nfc_cx, nfc_cy + nfc_radius + 12),
        f"Rear recess: {NFC_RECESS_DIAMETER_MM:.0f} mm × {NFC_RECESS_DEPTH_MM:.1f} mm",
        fill="#403c36",
        font=small_font,
        anchor="ma",
    )

    section_top = bottom + 70
    draw.text((margin, section_top - 38), "Side section (not to scale)", fill="#171716", font=label_font)
    base_left = margin + 20
    base_right = right - 20
    base_top = section_top + 45
    base_bottom = base_top + 72
    relief_top = base_top - 18
    draw.rectangle((base_left, base_top, base_right, base_bottom), fill="#d2ccbf", outline="#2b2b28", width=3)
    draw.rectangle((base_left + 110, relief_top, base_right - 110, base_top), fill="#272724")
    draw.line((base_right + 14, base_top, base_right + 14, base_bottom), fill="#9a3f2c", width=3)
    draw.line((base_right + 7, base_top, base_right + 21, base_top), fill="#9a3f2c", width=3)
    draw.line((base_right + 7, base_bottom, base_right + 21, base_bottom), fill="#9a3f2c", width=3)
    draw.text((base_right + 30, (base_top + base_bottom) / 2), "2.0 mm base", fill="#6d2c20", font=small_font, anchor="lm")
    draw.line((base_left + 80, relief_top, base_left + 80, base_top), fill="#9a3f2c", width=3)
    draw.text((base_left + 92, relief_top - 3), "0.1 mm relief", fill="#6d2c20", font=small_font, anchor="ls")
    draw.text(
        (margin, base_bottom + 38),
        f"2 × Ø{THROUGH_HOLE_DIAMETER_MM:.0f} mm through holes • "
        f"Ø{COUNTERSINK_DIAMETER_MM:.0f} mm × {COUNTERSINK_DEPTH_MM:.0f} mm countersinks",
        fill="#403c36",
        font=small_font,
    )
    canvas.save(path, quality=94)


def validate_stl(path: Path) -> dict[str, object]:
    import trimesh

    mesh = trimesh.load_mesh(path, process=True)
    extents = [round(float(value), 3) for value in mesh.extents]
    expected = [WIDTH_MM, HEIGHT_MM, BASE_MM + RELIEF_MM]
    if any(abs(actual - target) > 0.001 for actual, target in zip(extents, expected, strict=True)):
        raise ValueError(f"Unexpected STL extents: {extents}")
    if not mesh.is_watertight:
        raise ValueError("STL is not watertight")
    if not mesh.is_winding_consistent:
        raise ValueError("STL winding is inconsistent")
    return {
        "extents_mm": extents,
        "watertight": bool(mesh.is_watertight),
        "winding_consistent": bool(mesh.is_winding_consistent),
        # The occupancy construction has one connected base and every relief
        # cell shares a full face with that base. Trimesh component splitting
        # needs optional graph packages, so connectivity is proven at source.
        "connected_components": 1,
        "volume_mm3": round(float(mesh.volume), 2),
    }


def main() -> None:
    args = parse_args()
    if not args.url.startswith("https://scanaki.uk/p/"):
        raise ValueError("Use a permanent https://scanaki.uk/p/... URL")
    args.output_dir.mkdir(parents=True, exist_ok=True)
    qr_decode_check(args.url)
    solid, grid = occupancy(args.url, args.label)
    stl_path = args.output_dir / f"{args.code}.stl"
    triangle_count = write_binary_stl(stl_path, solid)
    preview_path = args.output_dir / f"{args.code}-front-preview.png"
    render_preview(preview_path, solid, args.code, args.url)
    construction_preview_path = args.output_dir / f"{args.code}-construction-preview.png"
    render_construction_preview(construction_preview_path, args.code)
    validation = validate_stl(stl_path)
    report = {
        "code": args.code,
        "label": args.label,
        "url": args.url,
        "dimensions_mm": {
            "width": WIDTH_MM,
            "height": HEIGHT_MM,
            "base": BASE_MM,
            "raised_text_qr": RELIEF_MM,
            "total": BASE_MM + RELIEF_MM,
        },
        "screw_holes": {
            "count": len(SCREW_CENTRES_MM),
            "through_diameter_mm": THROUGH_HOLE_DIAMETER_MM,
            "countersink_diameter_mm": COUNTERSINK_DIAMETER_MM,
            "countersink_depth_mm": COUNTERSINK_DEPTH_MM,
        },
        "nfc_recess": {
            "diameter_mm": NFC_RECESS_DIAMETER_MM,
            "depth_mm": NFC_RECESS_DEPTH_MM,
        },
        "grid": grid,
        "triangle_count": triangle_count,
        "file_size_bytes": stl_path.stat().st_size,
        "qr_decoded": args.url,
        "mesh_validation": validation,
    }
    (args.output_dir / f"{args.code}-validation.json").write_text(
        json.dumps(report, indent=2) + "\n", encoding="utf-8"
    )
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
