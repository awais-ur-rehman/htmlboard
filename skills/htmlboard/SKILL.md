---
name: htmlboard
description: Design UI in plain HTML files and show them side by side on an infinite, live-reloading canvas with the htmlboard CLI. Use when the user asks for mockups, screens, design variants or explorations, components, flyers or any visual proposal, or mentions htmlboard, artboards or designs.json.
---

# HtmlBoard

HtmlBoard serves a folder of HTML files as artboards on a zoomable canvas, like a Figma page. Every design is one ordinary HTML file that says its own name and size, so you design by writing HTML and CSS, and the user sees the result update live while you work.

## Start the canvas

Run it in the background, pointed at the designs folder (it is created if missing):

```sh
npx htmlboard designs --open
```

- It prints the URL (default `http://localhost:3000`; if the port is busy it takes the next free one). Give the URL to the user.
- `-p <port>` picks the port. `--init` adds sample designs; skip it unless the user wants a starter.
- If the artboards link to files above the designs folder (`../css/theme.css`), serve from the project root: `npx htmlboard design --root .`
- An empty folder gets the samples automatically, so write your first artboard before starting the server.
- If a server is already running for this folder, reuse it. `GET /api/health` answers `{"status":"ok","dir":…}`.

## Write an artboard

One design per file, with its facts in the `<head>`, linking the shared stylesheet and components (see below):

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Checkout · one page</title>                         <!-- its name on the canvas -->
  <meta name="description" content="Address and payment on one screen">
  <meta name="htmlboard" content="width=390, height=844">   <!-- its size -->
  <link rel="stylesheet" href="../styles.css">              <!-- shared tokens and classes -->
  <script type="module" src="../components.js"></script>    <!-- shared components -->
  <style>
    .screen { height: 844px; /* only what this design needs */ }
  </style>
</head>
<body>
  <main class="screen">…</main>
</body>
</html>
```

- Always give the `width`: it is the frame's viewport, and the page's CSS needs it. Give the `height` for fixed sizes (a phone screen, a flyer: the frame cuts at it); leave it out for pages that should grow with their content.
- Design at the real size of the target: phone 390×844, tablet 768×1024, desktop 1280×800 (or 1440×900), and the exact size for print or social formats (e.g. 1080×1350).
- Use real content in the user's language, not lorem ipsum.
- Relative links to CSS, images, scripts and fonts work (`assets/logo.svg`; `../css/theme.css` with `--root`).
- No build step: plain HTML, CSS and browser JavaScript (ES modules and CDN scripts work).

## Shared styles

Put what the designs share in one stylesheet instead of repeating it in every file: it keeps the designs consistent and spares writing the same CSS again.

- The designs folder has a `styles.css` at its top (sample projects start with one). Before writing a design, see what the designs already share: `npx htmlboard catalog <designs folder>` prints it in a few lines, read from the files (each stylesheet's variables and classes, the scripts, the components with their attributes and an example). Use what fits (`var(--accent)`, `.btn`, `<tx-item>`) and add what's missing; open a file only for what the list doesn't say.
- If there is none and the project already has a stylesheet or design tokens, link those. Otherwise create `styles.css` with your first design: colors, type and spacing as custom properties, the base styles, and the components you'll repeat.
- Link it with a relative path: `styles.css` from the top of the folder, `../styles.css` from a section folder.
- A design's own `<style>` holds only what is specific to it. When a second design needs the same thing, move it to `styles.css`.
- Split it when it grows (`forms.css`, `charts.css`) and link the extra files where they are used.
- Editing `styles.css` restyles every design that links it, which is the point for a product's screens. For one-off explorations that should keep their look (a different style, logo options), style them in their own file instead.

More tags, all optional:

- `category=…` in the `htmlboard` tag files the design under the explorer's filters: `mobile`, `tablet`, `desktop`, `components` or your own word. Usually not needed: it comes from words in the path, then from the size when it is a screen's.
- `<meta name="htmlboard:variant" content="?theme=dark · dark">` shows the same file again with that query string, named "<title> · dark". Use it for states the page builds from its URL (themes, empty or error states, data). Add one tag per variant; they follow the file.
- `<meta name="htmlboard:label" content="light">` adds a label to the name of the file's own frame ("Checkout · light"), to tell it from its variants.
- `<meta name="htmlboard" content="skip">` leaves a file out (partials, templates, a page that isn't a design).

## Components

Markup that designs repeat (a sidebar, a tab bar, a list row, a card with content) goes in a component, so a design writes one tag instead of the block: `<tx-item icon="☕" name="Blue Bottle" amount="-$6.75"></tx-item>`.

- `components/tx-item.html`, at the top of the designs folder, is `<tx-item>`: the file name is the tag, with a hyphen and no number prefix. Designs load `components.js` once (above). If the folder has no `components.js`, run `npx htmlboard components <designs folder>`.
- The catalog (above) lists them, with their attributes, an example and the designs that use them. Use them; don't copy their markup into designs.
- Make one when a second design repeats a block (or a design repeats it three times). Not for what a `styles.css` class already does (`<button class="btn btn-primary">` is short), nor in one-off explorations.

A component file is a piece of HTML (no `<!DOCTYPE>`, `<html>`, `<head>` or `<body>`):

```html
<!-- <tx-item icon="💼" name="Invoice #1042" meta="Yesterday" amount="+$3,450.00" positive></tx-item> -->
<div class="icon">{{icon}}</div>
<div class="what"><b>{{name}}</b> <span class="muted">{{meta}}</span></div>
<div class="amount">{{amount}}</div>

<style>
  & { display: flex; align-items: center; gap: 14px; }   /* & is the element itself */
  .icon { width: 40px; height: 40px; border-radius: 12px; background: var(--surface-2); }
  &[positive] .amount { color: var(--emerald); }
</style>
```

- First line: a comment with an example of use, with real values, every attribute and its variants side by side. The catalog shows it, and it is the component's preview on the canvas.
- `{{name}}` is the element's `name="…"` attribute, as text. Content goes in slots: `<slot></slot>` takes the element's children, `<slot name="actions"></slot>` its children with `slot="actions"`, and what a slot holds shows when nothing fills it.
- No logic in the markup: variants are attributes styled in CSS (`&[positive]`), and a list is several elements.
- Its `<style>` only reaches inside the element, which is a block box unless `&` says otherwise. `styles.css` applies inside too: build with its classes (`card`, `btn`, `muted`) and name the component's own parts with names it doesn't use. A design's own `<style>` comes after and can restyle one element, but its selectors reach inside components too, so keep them specific.
- `<script>` runs for each element once it is built, with `this` as the element. Use it sparingly, a few lines for what markup and CSS can't do, like marking the current link (`<app-sidebar active="Customers">`) or a toggle. No fetching, data or frameworks.
- Relative links in a component start from its file (`../01-screens/02-customers.html`).
- Close the tag: `<tx-item …></tx-item>`, never `<tx-item />`. A component can't be a table's row or cell itself (the browser moves it out of the `<table>`), but it works inside a cell: `<td><org-cell …></org-cell></td>`. Where it sits (fixed, margins, the grid around it) belongs to the design.
- Editing a component changes every design that uses it, like `styles.css`.

## Group and order

- **A folder is a section** (a row on the canvas), named after the folder. Put related designs in a folder: `designs/03-checkout/`.
- **Number prefixes set the order** of files and folders: `01-one-page.html`, `02-steps.html`. They don't show in names or links, so you can renumber freely. Files at the top of the designs folder form a first row without a title.
- New files and folders show up on the canvas by themselves; you don't register them anywhere.

**`designs.json`** is optional. When a project has one (in the designs folder), it curates: sections with titles (accents, capitals, an order across folders), and values that win over the files'. Designs it doesn't list still show after the ones it lists, in their folder's section, unless it says `"unlisted": "hide"`. If the project's designs.json groups designs by hand, add a new design to the right section there:

```json
{
  "sections": [
    { "title": "Checkout · mobile", "designs": ["03-checkout/01-one-page.html", "03-checkout/02-steps.html"] },
    { "title": "Launch flyers", "folder": "04-flyers" }
  ]
}
```

An entry is a file name (its variants follow it), or `{ "file", "title", "width", "height", "category", "description" }` to override the file. `"folder"` brings a whole folder. Components aren't on the canvas unless designs.json says `"components": "show"` (or lists `components/<tag>.html`): each shows alone, from its first-line example, 480 wide unless its file has `<meta name="htmlboard" content="width=…">`. `npx htmlboard migrate <folder>` moves an old designs.json's sizes, names and variants into the files (`--write` to apply; without it, it only shows the plan).

## Live reload

- Saving an artboard's HTML reloads just that frame; the user's view stays put. A new name or size in its `<head>` updates in place.
- Saving a file artboards use (a stylesheet, a component, a script, an image, data) reloads the artboards that loaded it.
- Adding, removing or moving artboards, or saving `designs.json`, rebuilds the canvas.

## Working with the user

- Put variants in separate files next to each other (`01-hero-a.html`, `02-hero-b.html`) instead of overwriting the current design, so they can be compared on the canvas. Keep the current one as the reference until the user picks.
- Say which files you created or changed and what to look at; the user is watching the canvas, not the code. Link straight to an artboard with `http://localhost:3000/#<id>`: the id is the file's path without prefixes and `.html`, other symbols turned into `-` (`03-checkout/02-steps.html` → `checkout-steps`; a variant adds its query: `checkout-steps-theme-dark`).
- If you can browse or take screenshots, open the artboard directly (`http://localhost:3000/<file>`) to check it at its real size before reporting back. Fix overflow, clipped text and broken images first.
