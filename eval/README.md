# Engine evaluation

`run_eval.py` scores OpenTally's engines on public counting datasets. Every
engine gets the same single sample box per image (the dataset's first
exemplar), which is what the app's Sample tool provides.

## Data (not committed)

Put the datasets in `datasets/` (git-ignored):

**FSC-147** (Ranjan et al., CVPR 2021): real photos, 3 exemplar boxes and a dot per object.
The images have no stated licence, so use them for local evaluation only.

```
datasets/fsc147/FSC147_384_V2.zip   # from the Google Drive link in github.com/cvlab-stonybrook/LearningToCountEverything; unzip in place
datasets/fsc147/annotation_FSC147_384.json, Train_Test_Val_FSC_147.json, ImageClasses_FSC147.txt   # from that repo's data/ folder
```

Only the classes that match OpenTally's users are scored (`FSC_CATEGORIES` in `run_eval.py`).

**MixCount** (Dumery et al., arXiv:2605.18063, CC BY 4.0): synthetic scenes
with 2–4 object kinds each and a box per object. Each kind in each scene is one
sample, so this also measures whether a sample box counts only its own kind.

```
datasets/mixcount/test-0000.parquet   # huggingface.co/datasets/CorentinDumery/MixCount, refs/convert/parquet, default/test/0000.parquet
```

## Run

```bash
pip install -r eval/requirements.txt
python eval/run_eval.py --dataset fsc147   --engines builtin,owlv2
python eval/run_eval.py --dataset mixcount --engines builtin,owlv2
```

Add `sam3` to `--engines` once you have access to the SAM 3 weights, and
`python eval/latency.py` times each engine. The built-in engine needs Node 20+.

## Metrics

- **MAE**: mean absolute count error. **bias**: mean signed error (+ = overcounting).
- **within 10%**: share of images counted within 10% of the truth, which is a practical bar for stock counts.
- **precision / recall / F1**: from greedy matching of marks to true positions,
  where a hit must land within half the sample box's shorter side.

Results are written to `eval/results/<dataset>.json`, with per-image rows.

## Results (October 2026, RTX 3090)

One sample box per photo; AI engines at the app's default confidence of 0.6.

| Engine | FSC-147 within 10% | FSC-147 median error | MixCount precision | Median latency, 384 px / 1024 px |
|---|---|---|---|---|
| Built-in | 19% | 34% | 13% | 28 ms / 207 ms |
| OWLv2 (tiled) | 43% | 14% | 45% | 124 ms / 134 ms |
| SAM 3 | 55% | 8% | 46% | 518 ms / 524 ms |

- SAM 3 is the most accurate up to about 100 items per photo (within 10% on 61–82% of photos), then falls off: 16% within 10% at 100–199 items and 0% at 200+, where it finds 7% of items. Tiling SAM 3 (pasting the sample beside each tile) lowered recall, so it isn't used. For very crowded photos, tiled OWLv2 is the better engine (52% within 10% at 200+).
- OWLv2 had the same density problem; tiling dense photos raised its recall at 200+ items from 48% to 73% and cut mean error by 38% (measured at confidence 0.4).
- On MixCount, every engine also counts look-alike kinds (precision under 50%). Raising Confidence trades recall for precision: 0.75 removes most of OWLv2's overcount but misses items on single-kind photos.
- The built-in engine is the fastest and needs no GPU, but it can't tell kinds apart and is the least accurate everywhere except tree logs.

Raw results: `eval/results/*.json` (`fsc147.json`, `mixcount.json`, `*-sam3-*.json`, `latency.json`, threshold sweeps and the tiling comparison).
