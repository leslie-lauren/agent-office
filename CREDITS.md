# Credits & asset licenses

Every visual asset in Agent Office is accounted for here, with its source and
license. The project ships **no third-party binary assets** — there are no
image, sprite-sheet, font, or sound files bundled in. This keeps the project
local-only (nothing downloaded) and license-clean.

## Visual assets

| Asset | What it is | Source | License |
|-------|------------|--------|---------|
| Pixel characters (head, body, arms, legs, walk/typing/idle/cheer/alert animations) | Drawn at runtime in `public/office.js` with canvas rectangles | **Original work**, created for this project | **CC0 1.0** (public domain dedication) |
| Office room (wood-plank floor, wall, baseboard, teal area rug) | Drawn at runtime in `public/office.js` | **Original work** | **CC0 1.0** |
| Desks, chairs, monitors, keyboards | Drawn at runtime in `public/office.js` | **Original work** | **CC0 1.0** |
| Potted plants | Drawn at runtime in `public/office.js` | **Original work** | **CC0 1.0** |
| Color palette (body colors, room colors) | Hand-picked hex values in `public/characters.js` | **Original** | **CC0 1.0** |

### What "drawn at runtime" means
There are no `.png`/`.aseprite`/sprite-sheet files. The art is produced by code
(filled rectangles on an HTML canvas). It is original to this project and is
hereby dedicated to the public domain under **CC0 1.0**
(<https://creativecommons.org/publicdomain/zero/1.0/>) — you may reuse, modify,
or redistribute it without attribution.

## Fonts
No font files are bundled. The UI uses your operating system's built-in
monospace fonts via the CSS stack
`ui-monospace, "SF Mono", Menlo, Consolas, monospace`. No web fonts are
downloaded.

## Sounds
None.

## Code dependencies (for completeness — not visual assets)
| Package | Purpose | License |
|---------|---------|---------|
| `express` | HTTP collector + static file server | MIT |
| `ws` | WebSocket live updates | MIT |

(Verify any installed version's license with `npm info <pkg> license`.)

---

## If you ever want to use downloaded sprite art instead

You can swap the code-drawn art for real sprite sheets and stay license-clean
by choosing **CC0** or **MIT** packs. Good sources:

- **Kenney.nl** — large, genuinely CC0 game-asset packs (e.g. "Tiny Town",
  "Tiny Dungeon", "Roguelike/RPG"). <https://kenney.nl/assets>
- **OpenGameArt.org** — filter by **CC0** specifically (the site also hosts
  CC-BY and GPL art, which carry attribution/share conditions — avoid those if
  you want zero strings).

To integrate:
1. Create `public/assets/` and place the sprite sheet(s) there.
2. Load them in `public/office.js` with an `Image()` and `ctx.drawImage(...)`
   in place of the rectangle-drawing helpers.
3. **Add a row to the table above** for each file: name, the exact pack/author,
   the download URL, and the license — that's the rule for this project.

Downloading those packs is the only step that touches the network; the running
app itself stays fully local.
