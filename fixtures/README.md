# Test fixtures

Layout is `fixtures/<Notebook>/<NN>.rm`, one reMarkable v6 page per file, read by the `fixture` source adapter.

| File | Source (ricklupton/rmc `tests/rm/`) | What it exercises |
|---|---|---|
| `Daily/01.rm` | `abcd.strokes.rm` | handwriting strokes |
| `Daily/02.rm` | `text_and_strokes.rm` | strokes plus typed text |
| `Daily/03.rm` | `Normal_AB.rm` | typed text only (no strokes) |
| `Calls/01.rm` | `Lines_v2.rm` | a fuller page of strokes |

These are not Matt's notes. They come from [rmc](https://github.com/ricklupton/rmc), MIT License,
Copyright (c) 2023 Rick Lupton.
