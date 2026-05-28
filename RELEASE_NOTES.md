# NoorNote 0.9.8

**Bulletproof follower detection** — The "Check for changes" feature and the "Follows you" badge on profiles are now driven by a single NIP-65-aware verification path. False "stopped following you back" notifications are eliminated: if we can't reach a user's actual relays, we say so instead of guessing.

**Repost & quote polish** — Long reposts keep their interaction bar visible under the Show More button. Nested Show More buttons on quoted posts are gone — only the outer note truncates. Quotes of reposts now show the original content instead of raw JSON.

**Generic reposts (kind 16)** — The newer kind 16 repost format is now fully supported across feed, notifications, and rendering.

**Faster timeline stats** — Zap, reaction, and reply counts for timeline notes are batched, making the feed feel snappier.

**Fixes** — Correct zap totals in the timeline, Lightning Address fallback to NIP-05 when lud16/lud06 are missing, accurate file size in upload error toasts.
