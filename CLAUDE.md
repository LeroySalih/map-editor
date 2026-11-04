# Map & Mission Editor — project rules

Browser editor for A3 colour tabletop maps and missions for a gothic-futuristic miniatures game (club use).

## Design decisions
- **Original IP only.** Gothic-futuristic look, but no Games Workshop names, symbols, logos or faction art.
- **Sheet:** A3 landscape, 420 × 297 mm. All units are millimetres (float). SVG space, Y down.
- **Style:** flat, stylised vector. Palette is in `src/render.ts` (`PALETTE`). Terrain is polygons/splines, never raster.
- **Terrain:** hill, wood, desert, sea (closed areas); river, road (open lines); wall (multi-click polyline with straight segments, like a road); bridge, port (straight two-click pieces, `STRAIGHT` in `src/model.ts`; port: land end first, sea end second). Add new types in `src/model.ts` (`CLOSED`, `TERRAIN_LABEL`) and `src/render.ts`.
- **Generation:** seeded (`src/rng.ts`); same seed gives same map. Output stays hand-editable.
- **Hex grid:** 2 cm (20 mm) across flats, flat-top, anchored at the inner border corner. `GRID_MM` in `src/model.ts`; toggled by `MapDoc.grid`.
- **Files:** versioned JSON (`MapDoc.version`, currently 2; v1 migrates in `validate`). Changing the shape needs a version bump and a migration in `validate`.
- **Export:** SVG (A3 mm size) and 300 dpi PNG. PDF with bleed/crop marks is planned.

## Sign in with DINO (`src/sso.ts`, tested in `src/sso.test.ts`)
Same process as Kerf Sabre (its `docs/AUTH-PLANNER-004.md`): browser-only Authorization Code + PKCE (S256) against planner-004, public client, no secret.
- Endpoints come from the issuer: `<issuer>/oauth/{authorize,token,revoke,userinfo}`. Build-time config: `VITE_DINO_ISSUER` (default `https://dino.mr-salih.org`), `VITE_DINO_CLIENT_ID` (default `map-editor`). Scope `profile`.
- The access token (~15 min JWT) is in memory only; the rotating refresh token is in sessionStorage (`map-editor.sso.refresh`), so closing the tab signs out. The page renews a minute before expiry.
- The person's display name is shown in the top bar and kept in memory only; never stored, never logged, never an email (a name containing `@` is dropped). The map itself stays in this browser's localStorage and is not tied to the account yet.
- **DINO must have the client registered** (planner-004: first-party, public, `token_format: jwt`, audience `kerf-sabre`, `allowed_scopes: profile`, `allowed_roles` as wanted) with the **exact redirect URIs**: this page's own address (`<origin>/`), e.g. `http://localhost:5173/` for `npm run dev` and the production URL. A one-character difference is refused.
- Not done: nothing verifies tokens (there is no server), so sign-in is identity for display only. Saving maps to an account needs a server that checks the JWT against `<issuer>/oauth/jwks` (see Kerf Sabre's `server/kerf_server/sso.py`).

## Stack
Plain TypeScript + Vite, no framework. `npm run dev`, `npm test`, `npm run build`.

## Git
Commit directly to `main` and push `main`. Run `npm test` and `npm run build` first.
