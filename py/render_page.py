#!/usr/bin/env python3
"""Render one reMarkable v6 .rm page to PNG for vision transcription.

usage: render_page.py <in.rm> <out.png> [max_long_edge_px]
stdout: JSON {"strokes": int, "typed_text": str, "width": int, "height": int}

Chain: rmc (rm → svg, plus typed-text markdown) → cairosvg (svg → png on white).
Long edge is capped (default 1568px) so the API never has to downscale the image.
"""
import json
import re
import subprocess
import sys
import tempfile
from pathlib import Path

import cairosvg


def main():
    src, dst = Path(sys.argv[1]), Path(sys.argv[2])
    max_edge = int(sys.argv[3]) if len(sys.argv) > 3 else 1568

    with tempfile.TemporaryDirectory() as td:
        svg_path = Path(td) / "page.svg"
        subprocess.run(["rmc", "-t", "svg", "-o", str(svg_path), str(src)],
                       check=True, capture_output=True, timeout=120)
        svg = svg_path.read_text(encoding="utf-8")

        typed = subprocess.run(["rmc", "-t", "markdown", str(src)],
                               capture_output=True, text=True, timeout=120).stdout
    # rmc appends an empty "# Highlights" section; keep only real typed text.
    typed = re.split(r"^# Highlights\s*$", typed, flags=re.M)[0].strip()

    strokes = len(re.findall(r"<(polyline|path)\b", svg))

    m = re.search(r'viewBox="[-\d.]+ [-\d.]+ ([\d.]+) ([\d.]+)"', svg)
    vw, vh = (float(m.group(1)), float(m.group(2))) if m else (3.0, 4.0)
    if vh >= vw:
        h = max_edge
        w = max(1, round(max_edge * vw / vh))
    else:
        w = max_edge
        h = max(1, round(max_edge * vh / vw))

    # A page with only typed text (Type Folio) has no strokes but still needs transcribing.
    if strokes or typed:
        dst.parent.mkdir(parents=True, exist_ok=True)
        cairosvg.svg2png(bytestring=svg.encode("utf-8"), write_to=str(dst),
                         output_width=w, output_height=h, background_color="white")

    print(json.dumps({"strokes": strokes, "typed_text": typed, "width": w, "height": h}))


if __name__ == "__main__":
    main()
