"""Count a photo with the local AI model (SAM 3 or OWLv2) from the command line and save an annotated copy.

    python backend/try_sam3.py photo.jpg --text pipe
    python backend/try_sam3.py photo.jpg --box 120 80 190 150
"""

import argparse
import time

from PIL import Image, ImageDraw

from sam3_server import load_detector, run_detector


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("image")
    ap.add_argument("--text", default=None)
    ap.add_argument("--box", nargs=4, type=float, action="append", default=[], metavar=("X0", "Y0", "X1", "Y1"))
    ap.add_argument("--threshold", type=float, default=0.6)
    ap.add_argument("--out", default=None)
    ap.add_argument("--model", default="auto", choices=["auto", "sam3", "owlv2"])
    args = ap.parse_args()
    if not args.text and not args.box:
        ap.error("give --text and/or --box")

    t0 = time.time()
    det = load_detector(args.model)
    print(f"loaded on {det.device} in {time.time() - t0:.1f}s")

    img = Image.open(args.image).convert("RGB")
    t0 = time.time()
    objects = run_detector(det, img, args.text, args.box, args.threshold)
    print(f"count: {len(objects)}  ({time.time() - t0:.2f}s, image {img.width}x{img.height})")

    draw = ImageDraw.Draw(img)
    for b in args.box:
        draw.rectangle(b, outline=(255, 212, 59), width=3)
    for i, o in enumerate(objects, 1):
        r = max(4, o["r"] * 0.35)
        draw.ellipse([o["x"] - r, o["y"] - r, o["x"] + r, o["y"] + r], fill=(47, 128, 237), outline="white", width=2)
        draw.text((o["x"], o["y"]), str(i), fill="white", anchor="mm")
    out = args.out or args.image.rsplit(".", 1)[0] + f"-{det.name}.png"
    img.save(out)
    print(f"saved {out}")


if __name__ == "__main__":
    main()
