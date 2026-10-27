# OpenTally — Specification

OpenTally is a free, open-source, fully offline alternative to commercial
photo-counting apps. It targets the same people: construction and steel yards
(rebar, pipes, tubes), lumber and timber (log ends, boards), warehouses and
inventory (cans, bottles, boxes), pharmacy (pills, tablets), and labs (cells,
colonies, seeds).

Guiding principles: **no account, no cloud, no subscription, no tracking.**
Photos never leave the device.

Each requirement below lists the tests that cover it (`test/*.test.js`).

## 1. Automatic detection (engine: `src/core/`)

| ID | Requirement | Tests |
|----|-------------|-------|
| D1 | Count separated dark objects on a light background. | `detect: counts separated dark disks` |
| D2 | Auto-detect polarity: light objects on a dark background also work without settings changes. | `detect: auto polarity handles light-on-dark` |
| D3 | Split touching / tightly packed round objects (pipe bundles, log stacks) into individual counts. | `detect: splits touching pairs`, `detect: splits hex-packed bundle` |
| D4 | Splitting can be turned off (one count per blob). | `detect: splitting off counts blobs` |
| D5 | Ignore specks below a minimum size and blobs above a maximum size. | `detect: min area filters specks`, `detect: max area excludes giant blobs` |
| D6 | Restrict counting to a user-drawn polygon region of interest. | `detect: ROI restricts count` |
| D7 | Colour mode: count only objects close to a picked colour. | `detect: color mode picks one colour` |
| D8 | Robust to moderate sensor noise. | `detect: robust to noise` |
| D9 | Report object centres accurately (within 2 px at native scale). | `detect: centres are accurate` |
| D10 | Large photos are processed at reduced resolution for speed; results are in original pixel coordinates. | `detect: downscales large images` |
| D11 | Non-round objects (board ends) are not over-split. | `detect: rectangles not over-split` |
| D12 | Empty images return zero without error. | `detect: empty image` |
| D13 | Manual threshold override and sensitivity adjustment. | `detect: manual threshold` |
| D14 | **Exemplar box replaces templates:** a box drawn around one item sets the expected size, so smaller clutter is ignored. | `detect: exemplar box sets size` |
| D15 | The exemplar box sets polarity (dark vs light items in the same photo). | `detect: exemplar box picks polarity` |
| D16 | In colour mode, the exemplar box supplies the colour. | `detect: exemplar box picks colour` |
| D17 | A region counts items by centre; items cut by the region edge aren't counted as slivers. | `detect: ROI counts by centre, not slivers` |

## 2. Counting session (`src/core/session.js`)

| ID | Requirement | Tests |
|----|-------------|-------|
| S1 | Multiple named, coloured categories with per-category and total counts. | `session: categories and counts` |
| S2 | Add a marker manually; remove the nearest marker within a radius. | `session: add and remove` |
| S3 | Re-running detection replaces only auto markers in that category; manual edits survive. | `session: auto markers keep manual` |
| S4 | Unlimited undo / redo of every edit. | `session: undo redo` |
| S5 | Save / load project as JSON. | `session: json roundtrip` |
| S6 | Deleting a category removes its markers; the last category cannot be deleted. | `session: delete category` |

## 3. Export (`src/core/export.js`)

| ID | Requirement | Tests |
|----|-------------|-------|
| E1 | CSV of every marker (id, category, x, y, source). | `export: markers csv` |
| E2 | CSV summary (category, count) with total row. | `export: summary csv` |
| E3 | Proper CSV escaping of commas, quotes and newlines. | `export: csv escaping` |
| E4 | Annotated PNG of the photo with numbered markers (UI). | manual |

## 4. Optional local AI engine (`backend/`)

Commercial counters rely on hundreds of pre-built templates. Open
promptable-segmentation models make those unnecessary: SAM 3 segments every
instance of a concept from an example box or a short phrase. OWLv2 is the
ungated fallback.

| ID | Requirement | Tests |
|----|-------------|-------|
| M1 | Backend runs locally only (127.0.0.1) and allows CORS only from local origins. | `test_cors_allows_local_app` |
| M2 | Accepts exemplar boxes and/or a text phrase; needs at least one. | `test_count_with_box`, `test_count_with_text`, `test_requires_prompt` |
| M3 | Removes duplicate detections (NMS), applies the confidence threshold, and drops detections far from the exemplar size. | `PostprocessTests` |
| M4 | A missing model or package is reported clearly, never a crash. | `test_missing_model_is_reported_not_crashed` |
| M5 | Browser client scales boxes and results between the photo and the uploaded copy; explains an unreachable backend. | `sam: *` in `test/sam-client.test.js` |
| M6 | `auto` uses SAM 3 when it loads and falls back to the ungated OWLv2 otherwise; an explicit choice never falls back. | `ModelSelectionTests` |
| M7 | Each model's own duplicate-removal and size settings are applied (OWLv2 emits overlapping boxes). | `DetectorSettingsTests` |
| M8 | OWLv2 splits a photo into overlapping tiles when the sample box shows small items, and every item fits whole in some tile. | `TilingTests` |

## 5. App (`index.html`, `src/app.js`)

- Open a photo by file picker, drag-and-drop, clipboard paste, or phone camera; or load a built-in example with its known answers.
- Presets: Pipes & tubes, Logs, Rebar, Pills & tablets, Cells & colonies, Board ends, Generic.
- Tools: Sample box, Add, Remove, Region (polygon), Pan. Mouse-wheel / pinch zoom.
- Primary flow: drag a box around one item; everything similar is counted. Tap to add a missed item, right-click to remove.
- Keyboard: `S` sample box, `A` add, `R` remove, `G` region, `Space` pan, `Enter` count,
  `Ctrl+Z` / `Ctrl+Y` undo / redo, `0` fit to screen.
- Big live total; per-category tallies.
- Export CSV, summary CSV, annotated PNG; save/open project file.
- Runs entirely in the browser with no network requests after loading.
  `npm start` serves it locally; no dependencies.
