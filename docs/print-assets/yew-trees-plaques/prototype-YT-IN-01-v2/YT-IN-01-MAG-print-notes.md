# YT-IN-01 magnetic prototype print notes

This revised prototype is for **The Yew Trees - Table 1**.

- Permanent Scanaki URL: `https://scanaki.uk/p/lzq3ovWCgJ1IYUnD`
- Finished size: **80 x 110 x 3.6 mm**
- Base thickness: **3.5 mm**
- Raised QR and text: **0.1 mm**
- Rear NFC recess: **30 mm diameter x 0.3 mm deep**
- Rear magnet pockets: **4 x 6 mm diameter x 3 mm deep**
- Material remaining behind each magnet: **0.5 mm**
- Front text: `THE YEW TREES`, `SCAN or TAP`, `TABLE 1`

## Why the base is now 3.5 mm

A 3 mm-deep magnet pocket cannot be contained in the previous 2 mm base. This model uses a 3.5 mm base so every magnet sits flush in a 3 mm rear pocket while retaining a 0.5 mm printed front skin. If the plaque must remain 2 mm thick, use magnets no thicker than approximately 1.5 mm or allow the magnets to project from the rear.

## Recommended prototype print

1. Import the STL at 100% scale and keep millimetres as the unit.
2. Print flat with the **text/QR against a clean smooth build plate** and the magnet/NFC recesses facing upward. A brim is recommended. This orientation keeps the rear pockets open and avoids bridging across the 30 mm NFC recess.
3. Use a **0.10 mm first layer and layer height**. The 0.1 mm relief is one printed layer.
4. Use a 0.4 mm or smaller nozzle, at least three walls, and 15-20% infill.
5. For a two-colour face, print the first 0.1 mm relief layer in the QR/text colour, then change to the plaque colour. Confirm the slicer's preview before printing.
6. Dry-fit the four magnets before applying adhesive. Check and mark every magnet's polarity so all four face the intended direction.
7. Fit the 30 mm x 0.3 mm NFC sticker into the central rear recess and program it with the permanent Scanaki URL.
8. Test physical QR scanning and NFC tapping on both Android and iPhone before approving the remaining plaques.

## Digital validation completed

- The embossed QR raster decoded to the exact permanent URL.
- The STL dimensions are 80 x 110 x 3.6 mm.
- The mesh is watertight, consistently wound, and one connected solid.

The QR construction follows the square-module STL approach used by the MIT-licensed qrcode2stl project, while the Scanaki generator adds the custom plaque, text, NFC recess and magnet pockets.
