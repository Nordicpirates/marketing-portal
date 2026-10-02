# The routes that sit ahead of the staff password

Almost everything in `server.ts` is behind the staff password. Ahead of it sit `/health`,
`/login`, `/qr/hit`, and every path under `/lp/`, matched before the password gate on purpose.

## The gift offer page: `/lp/aboard`

`/lp/aboard` is the gift offer page for people arriving from a retargeting ad. They have
no login and never will, so nothing under `/lp/`, `/lp` and `/lp/` themselves included,
is ever sent to `/login`.

A trailing slash is accepted on every `/lp/` path: an ad platform or a person will
eventually add one. The slash is trimmed before matching, which is why `/lp/` is checked
as `/lp`.

## The emailer's two routes

`/lp/aboard/signups` and `/lp/aboard/signups/mark-sent` are server to server only. They
carry their own shared secret in `x-lp-admin-secret` and answer 403 without it, so they sit
here rather than behind the staff password, which would only ever redirect a script to a
login page. They are not in the ASSETS map either, so nothing about them is reachable from
the public gift page. The contract is in `docs/GIFT-EMAIL.md`.

## Anything else under `/lp/`

An unknown `/lp/` path, and a bare `/lp` or `/lp/`, answers 404 rather than falling
through, so it never bounces a logged-out visitor to the staff login screen. The request
is passed to `handleAsset` so the hero video can be served in byte ranges.

## The QR scan counter: `/qr/hit`

`POST /qr/hit` is how the QR edge on qr.nordicpirates.com reports a scan. It is server to
server, behind its own `x-qr-hit-secret`, and answers 403 without it, so it sits here for
the same reason as the emailer's routes: behind the staff password it would only ever
redirect the edge to a login page. The staff page that shows the counts, `/qr`, and its
`/api/qr` stay behind the password. The contract is in `docs/QR-LINKS.md`.
