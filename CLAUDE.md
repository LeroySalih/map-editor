# Map & Mission Editor — project rules

Browser editor for A3 colour tabletop maps and missions for a gothic-futuristic miniatures game (club use).

## Design decisions
- **Original IP only.** Gothic-futuristic look, but no Games Workshop names, symbols, logos or faction art.
- **Sheet:** A3 landscape, 420 × 297 mm. All units are millimetres (float). SVG space, Y down.
- **Style:** flat, stylised vector. Palette is in `src/render.ts` (`PALETTE`). Terrain is polygons/splines, never raster.
- **Terrain:** hill, wood, desert, sea (closed areas); river, road (open lines). Add new types in `src/model.ts` (`CLOSED`, `TERRAIN_LABEL`) and `src/render.ts`.
- **Generation:** seeded (`src/rng.ts`); same seed gives same map. Output stays hand-editable.
- **Files:** versioned JSON (`MapDoc.version`). Changing the shape needs a version bump and a migration in `validate`.
- **Export:** SVG (A3 mm size) and 300 dpi PNG. PDF with bleed/crop marks is planned.

## Stack
Plain TypeScript + Vite, no framework. `npm run dev`, `npm test`, `npm run build`.

## Git
Commit directly to `main` and push `main`. Run `npm test` and `npm run build` first.
