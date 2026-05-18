# NoorNote v0.9.3 — Privacy Hardening + Repost/Quote Fixes

## Client tag modification

- **"via NoorNote" with no suffix.** When you enable the optional client tag, it now ships as plain `NoorNote` — the previous platform suffix (`m/d`, `l/w` etc.) is gone. Less fingerprinting, same opt-in.

## Reposts & Quotes

- **Reposts show the original note's age.** A repost of a 5-year-old note no longer reads "7m ago" — the timestamp now reflects when the post was actually written.
- **Legacy quote-reposts render correctly.** Older quote-style notes (from clients pre-NIP-18) now appear on the author's profile and in single-note view with the right "X quoted this note" header, instead of being miscategorized as replies.

## Media

- **GIFs upload as animations.** Animated GIFs are no longer flattened to a still JPEG during the upload-compression step.

## Layout

- **Profile timeline header sits flush on desktop.** The small gap above the sticky header on desktop is gone; the mobile spacing is unchanged.
