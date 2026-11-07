# Dispatch Dashboard

Live dispatch board for SHIFT operations (routes, drivers, trucks, timesheets, GPS, pre-trips).

**Live site:** https://darwillship.github.io/Dispatch-Dashboard/  
**Version:** v4.10.5

## What it does
- Kanban-style board for brainstorm / ready / assigned routes
- Driver cards with drag-and-drop assignment
- Truck board, GPS tracking, timesheets, pre-trip inspections
- Backed by Supabase (project `hqhfstosclasgwgxubip`)

## Tech
- Plain HTML/CSS/JS (GitHub Pages)
- Supabase JS client (CDN)
- Service worker for offline support
- Multiple feature modules (`*-features.js`, `trucks-board.js`, etc.)

## Local development
1. Clone the repo
2. Serve the folder with any static server (e.g. `npx serve .` or VS Code Live Server)
3. The Supabase publishable key is already in `index.html` (RLS protects data)

## Database
SQL migration-style files previously lived in the root. They should be applied via the Supabase dashboard or CLI. Prefer keeping future schema changes under `supabase/migrations/`.

## Notes
- Internal operational tool for Darwill
- Publishable Supabase key is client-side by design — ensure RLS policies are strict on all tables
- Large assets (logos) can be optimized further

## License
MIT — see LICENSE
