# NoorNote 1.9.15

**Feed engine**

- Reworked initial feed query shape: cursor-based pagination with oversampled request limits and post-filter page slicing, replacing the previous time-windowed first page.
- Background feed refresh window extended to 10s for slow relay responses.

**Pagination reliability**

- Scroll pagination now re-validates the load trigger after every page, eliminating stalls on pages shorter than the viewport; bounded terminal latch for exhausted cursors.

**Interface**

- Visual-hidden page headings; inactive tab color aligned to the interactive palette token.
