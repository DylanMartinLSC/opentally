"""Backend tests with a stand-in detector (no model weights needed).

    python -m unittest discover backend
"""

import io
import json
import unittest

from fastapi.testclient import TestClient
from PIL import Image

from sam3_server import create_app, iou, postprocess


def png_bytes(w=64, h=48):
    buf = io.BytesIO()
    Image.new("RGB", (w, h), "white").save(buf, format="PNG")
    return buf.getvalue()


class FakeDetector:
    name = "fake"
    device = "cpu"

    def __init__(self):
        self.calls = []

    def predict(self, image, text, boxes, threshold):
        self.calls.append((image.size, text, boxes, threshold))
        return [
            {"box": [0, 0, 10, 10], "score": 0.9, "area": None},
            {"box": [1, 1, 11, 11], "score": 0.8, "area": None},  # duplicate of the first
            {"box": [20, 0, 30, 10], "score": 0.7, "area": 78.5},
            {"box": [40, 0, 50, 10], "score": 0.1, "area": None},  # below threshold
        ]


class PostprocessTests(unittest.TestCase):
    def test_iou(self):
        self.assertAlmostEqual(iou([0, 0, 10, 10], [0, 0, 10, 10]), 1.0)
        self.assertEqual(iou([0, 0, 10, 10], [20, 20, 30, 30]), 0.0)

    def test_nms_and_score(self):
        out = postprocess(FakeDetector().predict(Image.new("RGB", (1, 1)), None, [], 0), [], 0.4)
        self.assertEqual([(o["x"], o["y"]) for o in out], [(5, 5), (25, 5)])
        self.assertAlmostEqual(out[1]["r"], 5.0, places=2)  # from mask area

    def test_exemplar_size_filter(self):
        dets = [{"box": [0, 0, 10, 10], "score": 0.9}, {"box": [0, 0, 100, 100], "score": 0.95}]
        out = postprocess(dets, [[50, 50, 61, 61]], 0.4)
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0]["box"], [0, 0, 10, 10])


class AppTests(unittest.TestCase):
    def setUp(self):
        self.fake = FakeDetector()
        self.client = TestClient(create_app(lambda: self.fake))

    def test_health(self):
        self.assertEqual(self.client.get("/health").json(), {"ready": True, "model": "fake", "device": "cpu"})

    def test_count_with_box(self):
        r = self.client.post("/count", files={"image": ("a.png", png_bytes())},
                             data={"boxes": json.dumps([[0, 0, 10, 10]]), "threshold": "0.5"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["count"], 2)
        self.assertEqual(self.fake.calls[0], ((64, 48), None, [[0.0, 0.0, 10.0, 10.0]], 0.5))

    def test_count_with_text(self):
        r = self.client.post("/count", files={"image": ("a.png", png_bytes())}, data={"text": " pipe "})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(self.fake.calls[0][1], "pipe")

    def test_requires_prompt(self):
        r = self.client.post("/count", files={"image": ("a.png", png_bytes())})
        self.assertEqual(r.status_code, 422)

    def test_bad_boxes(self):
        r = self.client.post("/count", files={"image": ("a.png", png_bytes())}, data={"boxes": "[[1,2]]"})
        self.assertEqual(r.status_code, 422)

    def test_cors_allows_local_app(self):
        r = self.client.get("/health", headers={"Origin": "http://127.0.0.1:8080"})
        self.assertEqual(r.headers.get("access-control-allow-origin"), "http://127.0.0.1:8080")
        r = self.client.get("/health", headers={"Origin": "https://evil.example"})
        self.assertIsNone(r.headers.get("access-control-allow-origin"))


class MissingModelTests(unittest.TestCase):
    def test_missing_model_is_reported_not_crashed(self):
        def factory():
            raise ImportError("cannot import name 'Sam3Model'")

        client = TestClient(create_app(factory))
        h = client.get("/health").json()
        self.assertFalse(h["ready"])
        self.assertIn("Upgrade transformers", h["error"])
        r = client.post("/count", files={"image": ("a.png", png_bytes())}, data={"text": "pill"})
        self.assertEqual(r.status_code, 503)


if __name__ == "__main__":
    unittest.main()


class ModelSelectionTests(unittest.TestCase):
    def setUp(self):
        import sam3_server
        self.mod = sam3_server
        self.saved = (sam3_server.Sam3TransformersDetector, sam3_server.Owlv2Detector)

        class Owl:
            name = "owlv2"

        sam3_server.Owlv2Detector = Owl

    def tearDown(self):
        self.mod.Sam3TransformersDetector, self.mod.Owlv2Detector = self.saved

    def test_auto_falls_back_to_owlv2_when_sam3_is_gated(self):
        def gated():
            raise OSError("You are trying to access a gated repo")

        self.mod.Sam3TransformersDetector = gated
        self.assertEqual(self.mod.load_detector("auto").name, "owlv2")

    def test_auto_prefers_sam3(self):
        class Sam:
            name = "sam3"

        self.mod.Sam3TransformersDetector = Sam
        self.assertEqual(self.mod.load_detector("auto").name, "sam3")

    def test_explicit_choice_does_not_fall_back(self):
        def gated():
            raise OSError("gated")

        self.mod.Sam3TransformersDetector = gated
        with self.assertRaises(OSError):
            self.mod.load_detector("sam3")
        self.assertEqual(self.mod.load_detector("owlv2").name, "owlv2")


class DetectorSettingsTests(unittest.TestCase):
    def test_detector_nms_setting_is_used(self):
        from sam3_server import run_detector

        class TwoBoxes:  # partly overlapping boxes, IoU 1/3
            def predict(self, image, text, boxes, threshold):
                return [{"box": [0, 0, 10, 10], "score": 0.9}, {"box": [5, 0, 15, 10], "score": 0.8}]

        class Strict(TwoBoxes):
            nms_iou = 0.3

        self.assertEqual(len(run_detector(TwoBoxes(), None, "x", [], 0.4)), 2)  # default NMS keeps both
        self.assertEqual(len(run_detector(Strict(), None, "x", [], 0.4)), 1)


class TilingTests(unittest.TestCase):
    """Tile planning only; no model weights needed."""

    def det(self):
        from sam3_server import Owlv2Detector
        return Owlv2Detector.__new__(Owlv2Detector)  # skip model loading

    def test_large_items_use_one_tile(self):
        self.assertEqual(self.det().tiles(1000, 800, [[0, 0, 80, 80]]), [(0, 0, 1000, 800)])

    def test_small_items_are_tiled_and_tiles_cover_the_image(self):
        tiles = self.det().tiles(1000, 800, [[10, 10, 20, 20]])  # 10 px items -> ~10 px at 960 input
        self.assertGreater(len(tiles), 1)
        self.assertLessEqual(len(tiles), 16)
        for x in range(0, 1000, 50):
            for y in range(0, 800, 50):
                self.assertTrue(any(a <= x < c and b <= y < d for a, b, c, d in tiles), (x, y))

    def test_every_item_fits_whole_in_some_tile(self):
        tiles = self.det().tiles(1000, 800, [[10, 10, 22, 22]])
        for cx in range(6, 994, 37):
            for cy in range(6, 794, 41):
                item = (cx - 6, cy - 6, cx + 6, cy + 6)
                self.assertTrue(any(a <= item[0] and b <= item[1] and item[2] <= c and item[3] <= d
                                    for a, b, c, d in tiles), item)

    def test_tiling_can_be_turned_off(self):
        d = self.det()
        d.tiling = False
        self.assertEqual(len(d.tiles(1000, 800, [[10, 10, 20, 20]])), 1)

