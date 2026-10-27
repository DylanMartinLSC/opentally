"""Optional local SAM 3 backend for OpenTally.

Runs on your own machine (127.0.0.1 only). The browser app sends a photo plus
one or more exemplar boxes and/or a short text phrase ("pipe", "pill") and gets
back one point per detected instance. No templates, no cloud.

    python backend/sam3_server.py            # http://127.0.0.1:8770

Models (OPENTALLY_MODEL=auto|sam3|owlv2, default auto):
  sam3   best quality; needs access to the gated `facebook/sam3` weights.
  owlv2  ungated open-vocabulary detector (Apache-2.0); weaker on dense or tiny items.
  auto   SAM 3 if it loads, otherwise OWLv2.
"""

from __future__ import annotations

import io
import json
import math
import os
from typing import Protocol

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from PIL import Image

MODEL_ID = os.environ.get("OPENTALLY_SAM3_MODEL", "facebook/sam3")
OWLV2_ID = os.environ.get("OPENTALLY_OWLV2_MODEL", "google/owlv2-base-patch16-ensemble")


class Detector(Protocol):
    name: str
    device: str

    def predict(self, image: Image.Image, text: str | None, boxes: list[list[float]], threshold: float) -> list[dict]:
        """Return [{"box": [x0, y0, x1, y1], "score": float, "area": float | None}]."""


# --- post-processing (pure, unit-tested) -------------------------------------

def iou(a: list[float], b: list[float]) -> float:
    ix = max(0.0, min(a[2], b[2]) - max(a[0], b[0]))
    iy = max(0.0, min(a[3], b[3]) - max(a[1], b[1]))
    inter = ix * iy
    union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return inter / union if union > 0 else 0.0


def box_area(b: list[float]) -> float:
    return max(0.0, b[2] - b[0]) * max(0.0, b[3] - b[1])


def postprocess(dets: list[dict], exemplars: list[list[float]], min_score: float, iou_thresh: float = 0.5,
                size_ratio: float = 4.0) -> list[dict]:
    """Score filter, NMS, and (with exemplars) drop detections far from the example size,
    which stops a whole bundle being returned as one instance."""
    dets = sorted((d for d in dets if d["score"] >= min_score), key=lambda d: -d["score"])
    kept: list[dict] = []
    for d in dets:
        if all(iou(d["box"], k["box"]) < iou_thresh for k in kept):
            kept.append(d)
    if exemplars:
        areas = sorted(box_area(b) for b in exemplars)
        ref = areas[len(areas) // 2]
        if ref > 0:
            kept = [d for d in kept if ref / size_ratio <= box_area(d["box"]) <= ref * size_ratio]
    out = []
    for d in kept:
        x0, y0, x1, y1 = d["box"]
        area = d.get("area")
        r = math.sqrt(area / math.pi) if area else min(x1 - x0, y1 - y0) / 2
        out.append({"x": (x0 + x1) / 2, "y": (y0 + y1) / 2, "r": r, "score": round(float(d["score"]), 4),
                    "box": [x0, y0, x1, y1]})
    return out


def run_detector(det, image, text, boxes, threshold) -> list[dict]:
    """predict + postprocess with the detector's own NMS and size settings."""
    dets = det.predict(image, text, boxes, threshold)
    return postprocess(dets, boxes, threshold, iou_thresh=getattr(det, "nms_iou", 0.5),
                       size_ratio=getattr(det, "size_ratio", 4.0))


# --- tiling for dense photos -------------------------------------------------

def plan_tiles(width, height, boxes, input_px, min_item_px=40, max_tiles=4):
    """Tile rectangles (x0, y0, x1, y1) so a sampled item spans at least
    `min_item_px` at the model's input size. One tile when items are big enough.
    Tiles overlap so every item lies whole in at least one of them."""
    item = min(min(b[2] - b[0], b[3] - b[1]) for b in boxes)
    side = max(width, height)
    k = 1
    if item > 0:
        k = min(max_tiles, math.ceil(min_item_px * side / (input_px * item)))
    if k <= 1:
        return [(0, 0, width, height)]
    step = side / k
    pad = 1.5 * max(max(b[2] - b[0], b[3] - b[1]) for b in boxes)
    out = []
    for j in range(math.ceil(height / step)):
        for i in range(math.ceil(width / step)):
            out.append((max(0, round(i * step - pad)), max(0, round(j * step - pad)),
                        min(width, round((i + 1) * step + pad)), min(height, round((j + 1) * step + pad))))
    return out


# --- SAM 3 via Hugging Face transformers -------------------------------------

class Sam3TransformersDetector:
    name = "sam3"
    # Tiling dense photos (pasting the sampled item beside each tile, since a
    # box prompt only works in its own image) lowered recall on FSC-147, so
    # SAM 3 runs on the whole photo.

    def __init__(self, model_id: str = MODEL_ID):
        import torch
        from transformers import Sam3Model, Sam3Processor  # needs a SAM 3-capable transformers

        self._torch = torch
        self.device = "cuda" if torch.cuda.is_available() else "cpu"
        self.processor = Sam3Processor.from_pretrained(model_id)
        self.model = Sam3Model.from_pretrained(model_id).to(self.device).eval()

    def predict(self, image, text, boxes, threshold):
        kwargs = {"images": image, "return_tensors": "pt"}
        if text:
            kwargs["text"] = text
        if boxes:
            kwargs["input_boxes"] = [boxes]
            kwargs["input_boxes_labels"] = [[1] * len(boxes)]
        inputs = self.processor(**kwargs).to(self.device)
        with self._torch.no_grad():
            outputs = self.model(**inputs)
        res = self.processor.post_process_instance_segmentation(
            outputs, threshold=threshold, mask_threshold=0.5,
            target_sizes=inputs.get("original_sizes").tolist(),
        )[0]
        dets = []
        for box, score, mask in zip(res["boxes"], res["scores"], res["masks"]):
            dets.append({"box": [float(v) for v in box], "score": float(score), "area": float(mask.sum())})
        return dets


# --- OWLv2 (ungated fallback) ------------------------------------------------

def box_iou_matrix(boxes, box):
    """IoU of each row of `boxes` (N, 4 xyxy tensor) with one xyxy box."""
    import torch

    b = torch.tensor(box, dtype=boxes.dtype, device=boxes.device)
    lt = torch.maximum(boxes[:, :2], b[:2])
    rb = torch.minimum(boxes[:, 2:], b[2:])
    inter = (rb - lt).clamp(min=0).prod(dim=1)
    area = (boxes[:, 2:] - boxes[:, :2]).prod(dim=1)
    return inter / (area + (b[2] - b[0]) * (b[3] - b[1]) - inter)


class Owlv2Detector:
    """Text prompts use OWLv2's open-vocabulary head. Box prompts follow the
    OWL-ViT one-shot recipe: take the model's own prediction that best matches
    the drawn box, and score every prediction by cosine similarity of class
    embeddings (the head's own logits saturate, so they can't separate)."""

    name = "owlv2"
    TEXT_FLOOR = 0.1  # best text match must reach this raw score, or nothing is there
    # Cosine similarity mapped so the app's 0-1 confidence lands on the useful
    # band. The default 0.6 (cos 0.88) beat 0.4 on both FSC-147 and MixCount;
    # higher separates look-alike kinds but misses items (eval/README.md).
    COS_LO, COS_SPAN = 0.7, 0.3
    # OWLv2 emits several overlapping boxes per item; round items in contact
    # still have box IoU near 0, so a strict NMS is safe.
    nms_iou = 0.3
    size_ratio = 2.5
    # OWLv2 sees a 960 px square and predicts one box per 16 px patch, so items
    # a couple of patches wide get missed (recall fell to 48% on FSC-147 photos
    # with 200+ items). When the sample box says items are that small, the
    # photo is split into overlapping tiles instead.
    INPUT_PX = 960
    MIN_ITEM_PX = 40
    MAX_TILES = 4  # per side
    tiling = True

    def __init__(self, model_id: str = OWLV2_ID):
        import torch
        from transformers import Owlv2ForObjectDetection, Owlv2Processor

        self._torch = torch
        self.device = "cuda" if torch.cuda.is_available() else "cpu"
        self.processor = Owlv2Processor.from_pretrained(model_id, backend="torchvision")  # 8x faster, same pixels
        self.model = Owlv2ForObjectDetection.from_pretrained(model_id).to(self.device).eval()

    def _xyxy(self, pred, side):
        """(N, 4) cxcywh in [0, 1] of the padded square -> pixels.
        OWLv2 pads to a square at the bottom/right, so the scale is the longest side."""
        torch = self._torch
        return torch.cat([pred[:, :2] - pred[:, 2:] / 2, pred[:, :2] + pred[:, 2:] / 2], dim=1) * side

    def _embed(self, image):
        """Predicted boxes (pixels) and unit class embeddings for one image."""
        pixel_values = self.processor(images=image, return_tensors="pt")["pixel_values"].to(self.device)
        feature_map, _ = self.model.image_embedder(pixel_values)
        b, h, w, d = feature_map.shape
        feats = feature_map.reshape(b, h * w, d)
        xyxy = self._xyxy(self.model.box_predictor(feats, feature_map)[0], max(image.size))
        _, class_embeds = self.model.class_predictor(feats)
        return xyxy, self._torch.nn.functional.normalize(class_embeds[0], dim=-1)

    def tiles(self, width, height, boxes):
        """Tile rectangles (x0, y0, x1, y1). One tile unless the sample box is small."""
        if not self.tiling:
            return [(0, 0, width, height)]
        return plan_tiles(width, height, boxes, self.INPUT_PX, self.MIN_ITEM_PX, self.MAX_TILES)

    def predict(self, image, text, boxes, threshold):
        torch = self._torch
        with torch.no_grad():
            if boxes:  # the box is the stronger signal; text is ignored
                all_xyxy, all_emb = [], []
                for x0, y0, x1, y1 in self.tiles(image.width, image.height, boxes):
                    xyxy, emb = self._embed(image.crop((x0, y0, x1, y1)))
                    # Drop boxes cut by an inner tile edge; a neighbouring tile has them whole.
                    m = 2
                    keep = torch.ones(xyxy.shape[0], dtype=torch.bool, device=self.device)
                    if x0 > 0: keep &= xyxy[:, 0] > m
                    if y0 > 0: keep &= xyxy[:, 1] > m
                    if x1 < image.width: keep &= xyxy[:, 2] < (x1 - x0) - m
                    if y1 < image.height: keep &= xyxy[:, 3] < (y1 - y0) - m
                    offset = torch.tensor([x0, y0, x0, y0], dtype=xyxy.dtype, device=self.device)
                    all_xyxy.append(xyxy[keep] + offset)
                    all_emb.append(emb[keep])
                xyxy, emb = torch.cat(all_xyxy), torch.cat(all_emb)
                cos = torch.full((xyxy.shape[0],), -1.0, device=self.device)
                for box in boxes:
                    idx = int(box_iou_matrix(xyxy, box).argmax())
                    cos = torch.maximum(cos, emb @ emb[idx])
                scores = ((cos - self.COS_LO) / self.COS_SPAN).clamp(0, 1)
            else:
                inputs = self.processor(text=[[text]], images=image, return_tensors="pt").to(self.device)
                out = self.model(**inputs)
                xyxy = self._xyxy(out.pred_boxes[0], max(image.width, image.height))
                s = out.logits[0, :, 0].sigmoid()
                # Relative to the best match, so one threshold suits any photo.
                scores = s / s.max() if s.max() >= self.TEXT_FLOOR else torch.zeros_like(s)

        keep = scores >= threshold
        xyxy, scores = xyxy[keep].clamp(min=0), scores[keep]
        return [{"box": [float(v) for v in bx], "score": float(min(sc, 1.0)), "area": None}
                for bx, sc in zip(xyxy.tolist(), scores.tolist())]


def load_detector(choice: str | None = None):
    choice = (choice or os.environ.get("OPENTALLY_MODEL", "auto")).lower()
    if choice == "sam3":
        return Sam3TransformersDetector()
    if choice == "owlv2":
        return Owlv2Detector()
    try:
        return Sam3TransformersDetector()
    except Exception as e:  # gated, not downloaded, or no SAM 3 support
        print(f"SAM 3 unavailable ({type(e).__name__}); falling back to OWLv2")
        return Owlv2Detector()


# --- app ---------------------------------------------------------------------

def create_app(detector_factory=load_detector) -> FastAPI:
    app = FastAPI(title="OpenTally SAM 3 backend")
    app.add_middleware(
        CORSMiddleware,
        allow_origin_regex=r"^(https?://(127\.0\.0\.1|localhost)(:\d+)?|null)$",
        allow_methods=["GET", "POST"],
        allow_headers=["*"],
    )
    state: dict = {"detector": None, "error": None}

    def get_detector() -> Detector:
        if state["detector"] is None and state["error"] is None:
            try:
                state["detector"] = detector_factory()
            except ImportError as e:
                state["error"] = (f"SAM 3 is not available in this Python environment ({e}). "
                                  "Upgrade transformers to a release with SAM 3 support.")
            except Exception as e:  # weights missing, gated access, out of memory...
                state["error"] = f"Could not load SAM 3: {e}"
        if state["detector"] is None:
            raise HTTPException(503, state["error"])
        return state["detector"]

    @app.get("/health")
    def health():
        try:
            d = get_detector()
            return {"ready": True, "model": d.name, "device": d.device}
        except HTTPException as e:
            return {"ready": False, "error": e.detail}

    @app.post("/count")
    async def count(image: UploadFile = File(...), boxes: str = Form("[]"), text: str = Form(""),
                    threshold: float = Form(0.6)):
        try:
            exemplars = [[float(v) for v in b] for b in json.loads(boxes)]
            if any(len(b) != 4 for b in exemplars):
                raise ValueError
        except (ValueError, TypeError):
            raise HTTPException(422, "boxes must be a JSON list of [x0, y0, x1, y1]")
        text = text.strip()
        if not exemplars and not text:
            raise HTTPException(422, "Give at least one example box or a text prompt")
        try:
            img = Image.open(io.BytesIO(await image.read())).convert("RGB")
        except Exception:
            raise HTTPException(422, "Could not read image")
        det = get_detector()
        objects = run_detector(det, img, text or None, exemplars, threshold)
        return {"count": len(objects), "objects": objects, "model": det.name}

    return app


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(create_app(), host="127.0.0.1", port=int(os.environ.get("PORT", 8770)))
