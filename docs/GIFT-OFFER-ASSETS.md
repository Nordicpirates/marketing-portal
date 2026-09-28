# The gift offer's files: what is served, and how

`handleAsset` in `lib/lp-aboard.ts` serves the files the public gift page pulls. The
public paths and how they map onto these upstream paths are in
`docs/GIFT-OFFER-WORKER.md`.

## An explicit map, never a directory walk

`ASSETS` lists every file the public page is allowed to pull. It is an explicit map, not a
directory walk, so a stray file in `public/` can never become publicly readable. A path
not in the map gets null from `handleAsset`, which `server.ts` answers with 404.

## The media is served from this repo

The media is served from this repo, not hotlinked from the mockup share space.
share.gate1.dev is where designs get reviewed; a live page that people are being paid to
visit cannot have its hero video disappear when a mockup is tidied up.

## Caching

Markup and code stay on `no-cache` because they change. The media is immutable once
committed, so it gets a real cache lifetime (`public, max-age=604800`, one week) instead of
being re-sent on every visit.

## The five languages

`LANGUAGE_ASSETS` is the five languages the page sells in (en, de, it, fr, es). It is the
same list as `LANGUAGES` in `public/lp-aboard-i18n.js`: a language the page can switch to
and cannot fetch the copy for would be a blank page in that language.

## Headers on every file

- `X-Robots-Tag: noindex, nofollow`: belt and braces with the noindex meta tag in the
  HTML. This page is for people who clicked an ad, not for search engines.
- `Accept-Ranges: bytes`: the hero video needs this. Safari asks for a byte range before
  it will play anything, and a server that answers 200-with-everything gets no video.

## Range requests

- A `Range` header that does not match `bytes=<start>-<end>` is malformed. RFC 7233 says
  ignore the header and send the whole thing, so the whole file is served, with a log line.
- Suffix form: `bytes=-500` is the LAST 500 bytes, not the first 500. Getting this
  backwards hands the player the start of the file when it asked for the end, which for an
  mp4 is where the moov atom lives on a non-faststart file. A suffix longer than the file
  just means the whole file. A missing, non-numeric or zero suffix is unsatisfiable.
- `bytes=0-99999999` on a small file is legal: the end is clamped to the file, not
  refused.
- A start past the end of the file, a start after the end, or an empty file is
  unsatisfiable: 416 with `Content-Range: bytes */<size>`, and a log line.
- A satisfiable range is answered 206 with `Content-Range` and `Content-Length`.
