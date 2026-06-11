# Storage-primary vs legacy bulk import (Phase 6.1/6.2)

*Last run: 2026-06-11T09:48:03.990Z*

Legacy = `bulk_import_cells` (WorkbookLoader per-cell API). Storage-primary = `bulk_install_workbook` (map swap; formulas park lazily). Build = JS-side wire construction; call = RPC wall-clock (deserialize + engine).

| Tier | total cells | legacy build (ms) | legacy call (ms) | sp build (ms) | sp call (ms) | call speedup | crossSheetParsed |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 500k | 500000 | 0.00 | 4835 | 45.4 | 323 | 15.0× | 0 |
| Mega (1M) | 1000000 | 0.00 | 8652 | 67.9 | 771 | 11.2× | 0 |

Probe cells (must match across paths — bench throws on mismatch):

- 500k: A1="94" B1="" C1="" D1="50431" A100="27" B100="127" C100="" D100=""
- Mega (1M): A1="71" B1="92" C1="" D1="" A100="94" B100="" C100="38" D100=""
