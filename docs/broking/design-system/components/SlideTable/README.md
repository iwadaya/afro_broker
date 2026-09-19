# SlideTable

The manual-entry modal body for a sliding-scale commission (Loss Ratio % → Commission %, 10 rows pre-filled, + Add Row, ✕ per row, Provisional Commission % above) and for stepped loss participation (up to 5 corridors: Min LR %, Max LR %, Re Share %).

**Consumer provides:** `kind` (`sliding` | `corridors`), `rows`, `onSave(rows)`.

- Save keeps only complete rows; sliding needs at least 2, corridors need max > min per row.
- The pane shows the result as "✓ 3 corridor(s)" or "10 row(s)" beside the warn button that opened it.
