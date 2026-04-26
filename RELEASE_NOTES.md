# NoorNote v0.8.8

## Articles

- Images inside long-form articles now open the lightbox and swipe through the article gallery, just like images in regular notes.
- Article preview cards in the timeline now display the banner image correctly for both wide landscape and tall portrait images — no more broken or mis-aligned thumbnails.
- Replies to articles render with proper context: the linked-to article shows up correctly, and quote-posts of an article are no longer mistaken for true replies.

## Git on Nostr

- NoorNote now displays NIP-34 Git events (Patches, Pull Requests, Issues, Status updates, Repository announcements) as compact cards inline anywhere a note appears. Each card has a one-tap link to `gitworkshop.dev` for the full thread.

## Login

- The QR-code login (NostrConnect) now uses two reliable relays after dropping a third one that went offline. Logging in with Amber and other remote signers should be more dependable.
