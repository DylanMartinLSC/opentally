"""Compare OpenTally's engines on public counting datasets.

    python eval/run_eval.py --dataset fsc147 --engines builtin,owlv2
    python eval/run_eval.py --dataset mixcount --engines builtin,owlv2 --limit 100

Every engine gets the same single sample box (the first exemplar), as in the
app. Datasets live in datasets/ (not committed); see eval/README.md.
"""

from __future__ import annotations

import argparse
import io
import json
import math
import subprocess
import sys
import time
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "backend"))

# FSC-147 classes that match OpenTally's users (stock, pharmacy, building
# materials, small parts). FSC-147 has no pipe or rebar class.
FSC_CATEGORIES = [
    "bottle caps", "bricks", "cans", "cement bags", "coins", "eggs", "nuts",
    "pills", "roof tiles", "toilet paper rolls", "tree logs",
]


# --- datasets ----------------------------------------------------------------

def load_fsc147(categories=FSC_CATEGORIES):
    from PIL import Image

    base = ROOT / "datasets" / "fsc147"
    ann = json.loads((base / "annotation_FSC147_384.json").read_text())
    classes = dict(line.split("\t") for line in (base / "ImageClasses_FSC147.txt").read_text().splitlines() if line)
    for name in sorted(ann):
        cat = classes.get(name, "").strip()
        if cat not in categories:
            continue
        a = ann[name]
        img = Image.open(base / "images_384_VarV2" / name).convert("RGB")
        boxes = []
        for corners in a["box_examples_coordinates"]:
            xs, ys = [p[0] for p in corners], [p[1] for p in corners]
            boxes.append([min(xs), min(ys), max(xs), max(ys)])
        yield {"id": name, "category": cat, "image": img, "exemplar": boxes[0],
               "points": [tuple(p) for p in a["points"]]}


def load_mixcount():
    import pyarrow.parquet as pq
    from PIL import Image

    table = pq.read_table(ROOT / "datasets" / "mixcount" / "test-0000.parquet")
    for row in table.to_pylist():
        img = Image.open(io.BytesIO(row["image"]["bytes"])).convert("RGB")
        objs = row["objects"]
        for ci, cname in enumerate(row["class_names"]):
            boxes = [b for b, c in zip(objs["bbox"], objs["category"]) if c == ci]
            if not boxes:
                continue
            x, y, w, h = boxes[0]
            yield {"id": f'{row["file_name"]}#{ci}', "category": cname, "image": img,
                   "exemplar": [x, y, x + w, y + h],
                   "points": [(bx + bw / 2, by + bh / 2) for bx, by, bw, bh in boxes],
                   "distractors": row["num_classes"] - 1}


# --- engines -----------------------------------------------------------------

class BuiltinEngine:
    name = "builtin"

    def __init__(self):
        self.proc = subprocess.Popen(["node", str(ROOT / "eval" / "builtin_runner.mjs")],
                                     stdin=subprocess.PIPE, stdout=subprocess.PIPE)

    def count(self, img, exemplar):
        x0, y0, x1, y1 = exemplar
        header = {"width": img.width, "height": img.height,
                  "options": {"exemplar": {"x": x0, "y": y0, "w": x1 - x0, "h": y1 - y0}}}
        self.proc.stdin.write(json.dumps(header).encode() + b"\n" + img.convert("RGBA").tobytes())
        self.proc.stdin.flush()
        res = json.loads(self.proc.stdout.readline())
        self.last_ms = res.get("ms", 0.0)
        if "error" in res:
            raise RuntimeError(res["error"])
        return [tuple(p) for p in res["objects"]]

    def close(self):
        self.proc.stdin.close()
        self.proc.wait()


class AIEngine:
    def __init__(self, choice, threshold):
        from sam3_server import load_detector

        notile = choice.endswith("-notile")
        self.det = load_detector(choice.removesuffix("-notile"))
        if notile:
            self.det.tiling = False
        self.name = self.det.name + ("-notile" if notile else "")
        self.threshold = threshold

    def count(self, img, exemplar):
        from sam3_server import run_detector

        return [(o["x"], o["y"]) for o in run_detector(self.det, img, None, [exemplar], self.threshold)]

    def close(self):
        pass


# --- metrics -----------------------------------------------------------------

def match(pred, truth, radius):
    """Greedy nearest matching; returns the number of true positives."""
    pairs = sorted((math.dist(p, t), i, j) for i, p in enumerate(pred) for j, t in enumerate(truth)
                   if abs(p[0] - t[0]) <= radius and abs(p[1] - t[1]) <= radius)
    used_p, used_t, tp = set(), set(), 0
    for d, i, j in pairs:
        if d > radius or i in used_p or j in used_t:
            continue
        used_p.add(i); used_t.add(j); tp += 1
    return tp


def summarise(rows):
    n = len(rows)
    if not n:
        return {}
    errs = [r["pred"] - r["gt"] for r in rows]
    rel = [abs(e) / max(r["gt"], 1) for e, r in zip(errs, rows)]
    tp, np_, nt = (sum(r[k] for r in rows) for k in ("tp", "pred", "gt"))
    prec, rec = tp / max(np_, 1), tp / max(nt, 1)
    return {
        "n": n,
        "MAE": round(sum(map(abs, errs)) / n, 2),
        "bias": round(sum(errs) / n, 2),  # + means overcounting
        "median_rel_err": round(sorted(rel)[n // 2], 3),
        "within_10pct": round(sum(x <= 0.10 for x in rel) / n, 3),
        "exact": round(sum(e == 0 for e in errs) / n, 3),
        "precision": round(prec, 3),
        "recall": round(rec, 3),
        "F1": round(2 * prec * rec / max(prec + rec, 1e-9), 3),
        "sec_per_image": round(sum(r["sec"] for r in rows) / n, 3),
    }


# --- main --------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dataset", choices=["fsc147", "mixcount"], required=True)
    ap.add_argument("--engines", default="builtin,owlv2")
    ap.add_argument("--threshold", type=float, default=0.6, help="AI confidence, as the app's slider")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--tag", default="", help="suffix for the results file, e.g. a threshold sweep")
    args = ap.parse_args()

    engines = []
    for e in args.engines.split(","):
        engines.append(BuiltinEngine() if e == "builtin" else AIEngine(e, args.threshold))

    samples = load_fsc147() if args.dataset == "fsc147" else load_mixcount()
    rows = {e.name: [] for e in engines}
    t_start = time.time()
    for k, s in enumerate(samples):
        if args.limit and k >= args.limit:
            break
        x0, y0, x1, y1 = s["exemplar"]
        radius = max(4.0, 0.5 * min(x1 - x0, y1 - y0))  # a hit lands within half an item of its centre
        for e in engines:
            t0 = time.time()
            pred = e.count(s["image"], s["exemplar"])
            rows[e.name].append({"id": s["id"], "category": s["category"], "gt": len(s["points"]),
                                 "pred": len(pred), "tp": match(pred, s["points"], radius),
                                 "sec": time.time() - t0})
        if (k + 1) % 50 == 0:
            print(f"  {k + 1} samples, {time.time() - t_start:.0f}s", flush=True)
    for e in engines:
        e.close()

    report = {"dataset": args.dataset, "threshold": args.threshold, "engines": {}}
    for name, rs in rows.items():
        by_cat = defaultdict(list)
        for r in rs:
            by_cat[r["category"]].append(r)
        report["engines"][name] = {
            "overall": summarise(rs),
            "by_category": {c: summarise(v) for c, v in sorted(by_cat.items())} if args.dataset == "fsc147" else {},
            "samples": rs,
        }
    out = ROOT / "eval" / "results" / f"{args.dataset}{'-' + args.tag if args.tag else ''}.json"
    out.parent.mkdir(exist_ok=True)
    out.write_text(json.dumps(report, indent=1))
    print_table(report)
    print(f"saved {out.relative_to(ROOT)}")


def print_table(report):
    cols = ["n", "MAE", "bias", "median_rel_err", "within_10pct", "exact", "precision", "recall", "F1", "sec_per_image"]
    print(f"\n{report['dataset']}  (one sample box per image)")
    print("| engine | " + " | ".join(cols) + " |")
    print("|---" * (len(cols) + 1) + "|")
    for name, r in report["engines"].items():
        print(f"| {name} | " + " | ".join(str(r["overall"].get(c, "")) for c in cols) + " |")
    first = next(iter(report["engines"].values()))
    if first["by_category"]:
        names = list(report["engines"])
        print("\n| category | n | " + " | ".join(f"{n} MAE | {n} within 10%" for n in names) + " |")
        print("|---" * (2 + 2 * len(names)) + "|")
        for cat in first["by_category"]:
            cells = []
            for n in names:
                c = report["engines"][n]["by_category"][cat]
                cells += [str(c["MAE"]), f'{c["within_10pct"]:.0%}']
            print(f"| {cat} | {first['by_category'][cat]['n']} | " + " | ".join(cells) + " |")


if __name__ == "__main__":
    main()
