"""Per-image latency of each engine, measured one engine at a time with nothing
else on the GPU (the accuracy runs share the GPU, so their timings run high).

    python eval/latency.py --engines builtin,owlv2,sam3

Uses the same fixed sample for every engine: 60 FSC-147 photos (384 px tall)
and 40 MixCount scenes (1024 x 1024). Writes eval/results/latency.json.
"""

import argparse
import json
import random
import statistics
import time

from run_eval import ROOT, AIEngine, BuiltinEngine, load_fsc147, load_mixcount


def sample(gen, n, seed=7):
    items = list(gen)
    random.Random(seed).shuffle(items)
    return items[:n]


def pct(xs, p):
    xs = sorted(xs)
    return xs[min(len(xs) - 1, int(round(p * (len(xs) - 1))))]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--engines", default="builtin,owlv2,sam3")
    args = ap.parse_args()

    # One sample per MixCount scene (the first kind), so each image is timed once.
    mix = {}
    for s in load_mixcount():
        mix.setdefault(s["id"].split("#")[0], s)
    sets = {"FSC-147 (384 px)": sample(load_fsc147(), 60), "MixCount (1024 px)": sample(mix.values(), 40)}

    out = {"gpu": None, "engines": {}}
    try:
        import torch
        out["gpu"] = torch.cuda.get_device_name(0) if torch.cuda.is_available() else "cpu"
    except ImportError:
        pass

    for name in args.engines.split(","):
        t0 = time.time()
        eng = BuiltinEngine() if name == "builtin" else AIEngine(name, 0.6)
        load_s = time.time() - t0
        res = {"load_s": round(load_s, 1), "sets": {}}
        for label, items in sets.items():
            for s in items[:3]:  # warm-up
                eng.count(s["image"], s["exemplar"])
            times = []
            for s in items:
                if name == "builtin":
                    eng.count(s["image"], s["exemplar"])
                    times.append(eng.last_ms / 1000)  # engine compute, as in the browser
                else:
                    t = time.perf_counter()
                    eng.count(s["image"], s["exemplar"])
                    times.append(time.perf_counter() - t)
            res["sets"][label] = {"n": len(times), "median_s": round(statistics.median(times), 4),
                                  "p90_s": round(pct(times, 0.9), 4), "mean_s": round(statistics.mean(times), 4)}
            print(f"{name:8s} {label:20s} median {res['sets'][label]['median_s']:.3f}s  p90 {res['sets'][label]['p90_s']:.3f}s", flush=True)
        eng.close()
        out["engines"][eng.name if name != "builtin" else "builtin"] = res
        del eng
        try:
            import torch
            torch.cuda.empty_cache()
        except ImportError:
            pass

    (ROOT / "eval" / "results" / "latency.json").write_text(json.dumps(out, indent=1))
    print("saved eval/results/latency.json")


if __name__ == "__main__":
    main()
