# A line of text on a share, and an og:description to go with it

## What is missing

A share link opens on a bare contact sheet: the roll name, the frame count, a
date range, the camera. There is nowhere to say *what it is* — "Iceland, June —
the six I'd print are 04, 07, 11" — so that context goes in the chat message
beside the link and is lost the moment the link is forwarded.

The link preview has the same hole from the other side. `sharePage` injects
`og:title`, `og:url`, `twitter:card`, `twitter:title` and `og:image`, and **no
`og:description` at all**. Slack, iMessage and WhatsApp all render a description
line; here it comes out empty or gets filled with whatever the crawler scrapes.

## The lazy design

One optional field on `Folder`:

```ts
note?: string;   // one paragraph, plain text
```

Written through the `PATCH /api/folders/<id>` route that already exists — the
same one-line whitelist change as `sortOrder` in `roll-sort-order.md`, so if
both ship they are the same edit.

Three places read it:

1. **The share page**, as a paragraph under `EdgeHeader`. `openShare` already
   returns `folder: { name, photoCount }`; add `note`.
2. **`og:description`**, in `sharePage`. The `escapeAttr` helper already exists
   and is already applied to the folder name — reuse it, and truncate to ~200
   characters, which is where every unfurler cuts anyway.
3. **The admin roll view**, so it is editable. The existing `prompt()` dialog
   takes a `value` and is already wired for *Rename*; a second *Note* button
   beside it is the same three lines.

Plain text, not markdown, not HTML. It goes into an OG attribute and into the
DOM; a plain string that `escapeAttr` handles is one fewer injection surface for
a feature whose entire value is one sentence.

## Why folder-level and not per-photo

Per-photo captions are the obvious extension and the wrong first step. They mean
a field on `Photo`, an edit affordance in the lightbox, presence in
`presentPhoto` for both admin and share, and a decision about whether a caption
follows the frame into every roll it is in — which, given a photo is owned by
nobody, it would have to. That is a real design question. "This roll is about X"
is one string on a record that already gets patched, and it covers most of what
the captions were wanted for.

## Cost

One short attribute on the folder item. Nothing.

## Skipped

Per-photo captions and titles (above). Markdown rendering. A custom
`og:image` per share rather than the roll's cover — `/s/<token>/og.webp` already
streams the cover at 2400px and expires with the share, which is the hard part
and it is done.
