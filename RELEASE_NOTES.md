# NoorNote v0.8.3

Marketplace, wallet and security release on top of 0.8.2.

## Highlights

- **Marketplace listings everywhere.** Kind 30402 product listings now render as proper product cards when quoted, reposted, or inline-referenced — not just inside the marketplace.
- **Repost, quote and reviews on listings.** Repost or quote a listing directly from the product detail page. Quoted reposts of a listing appear as a live review stream under the product.
- **Wallet transaction history.** Paginated transaction list with infinite scroll (20 per page) in the wallet addon. Incoming zaps show the sender's profile picture, name and zap message.
- **XSS hardening.** Untrusted Nostr data is HTML-escaped in the media carousel, article previews and reposts.

## Fixes

- Clicking a listing card opens the Single Note View again
- Download link on Capacitor Android works again
- Wallet balance under the logo no longer stays empty on Web after restart
- Parallel NWC requests no longer step on each other

## Under the hood

- Kind 16 (Generic Repost) added to the NIP-18 entry in the README
- Small border-radius SCSS tokens removed

