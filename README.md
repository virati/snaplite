# snaplite

<!-- ai-generated -->
A small local photo editor in the spirit of Snapseed. It is a static page with
no dependencies, no build step and no server: open `index.html` in a browser.
<!-- /ai-generated -->

```sh
firefox /home/virati/mob/projects/tools/snaplite/index.html
firefox "/home/virati/mob/projects/tools/snaplite/index.html?demo"   # loads a synthetic test image
```

## Use

<!-- ai-generated -->
Open an image by dropping it on the window, pasting from the clipboard,
clicking Open, or pressing Ctrl+O. Opening a new image resets all edits.

- **Crop & rotate**: quarter turns, horizontal flip, straighten (the frame
  shrinks to hide the tilted corners), and a crop box with optional fixed
  aspect ratio. Press Crop to show the box, Done to apply it.
- **Basics**: brightness, contrast, saturation, ambience, highlights, shadows,
  warmth, tint, fade, vignette. Double-click a slider row to reset it.
- **Details**: structure (local contrast, negative values smooth) and
  sharpening.
- **Curves**: RGB master plus per-channel curves over a histogram. Click to add
  a point, drag to move, double-click or right-click to remove.
- **Lens blur**: radial or linear (tilt-shift) focus region. Drag on the image
  to place the focus point once the blur amount is above zero.
- **Grain**: amount and size.
- **Filters**: nostalgia presets with a strength slider. Each one also adds a
  little of its own vignette and grain.
- **Looks**: save the current edit under a name and apply it to other images.
  Looks hold every setting except crop and rotation, and live in the browser's
  `localStorage`, so they are tied to this browser profile and this file path.
- **Export**: JPEG, PNG or WebP at the full resolution of the crop, saved to the
  browser's download folder as `<name>-edit.<ext>`.

Shortcuts: Ctrl+O open, Ctrl+S export, Ctrl+Z / Ctrl+Shift+Z undo and redo,
hold `\` (or the Compare button) to see the original.
<!-- /ai-generated -->

## Layout

<!-- ai-generated -->
- `engine.js` is the pixel pipeline. It has no DOM access, so it can also be
  loaded in node with `require`.
- `app.js` is the UI: controls, curves editor, focus overlay, open and export.

Rotation, straightening and cropping are done first, with a canvas transform;
the pixel pipeline then runs on the result. Edits run live on a preview capped
at 1600 px on the long edge, and the same steps run again at full resolution on
export. Blur radius, grain size, sharpening radius and vignette are all
proportional to the image size, so the export matches the preview. The grain pattern itself is regenerated at export size, so individual
specks will not line up with the preview.
<!-- /ai-generated -->
