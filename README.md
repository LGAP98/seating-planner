# Seating Planner

A browser-based seating planner for weddings, dinners, conferences, and any event where guests need to be arranged at tables. Runs entirely in your browser with no server required — data is autosaved to localStorage.

## Features

- **Guest management** — paste a list of names to add guests in bulk; rename or remove them at any time
- **Groups** — organise guests into colour-coded groups (family, colleagues, friends, …) with multi-group support
- **Relationships** — define constraints between guests: *must sit together*, *must NOT sit together*, or *knows each other*
- **Drag-and-drop seating** — drag guests onto seats, or click-to-place as an alternative
- **Configurable tables** — add tables with custom names and seat counts; drag tables around the room to arrange the layout
- **Plan scoring** — a live quality score evaluates your plan against the defined relationships
- **Auto-optimiser** — click *Suggest better plan* to let the app rearrange guests and improve the score
- **Zoom & pan** — zoom into individual tables with scroll or the +/− controls
- **Undo** — one-level undo (Ctrl/Cmd+Z) for quick corrections
- **Import / Export** — save and load plans as JSON files; export the layout as a PNG image or a plain-text summary

## Getting started

No build step or dependencies required — just open `index.html` in any modern browser.

## Workflow

1. **Add guests** — paste names (one per line) into the sidebar and click *Add guests*
2. **Create groups** and assign guests to them for visual organisation
3. **Define relationships** — select two guests and set whether they must / must not sit together
4. **Add tables** — click *+ Add table*, set the name and number of seats
5. **Seat guests** — drag guests from the unseated pool onto table seats, or use click-to-place
6. **Optimise** — use *Suggest better plan* to automatically improve the arrangement
7. **Export** — save your plan as JSON, export a PNG image, or grab a text summary

## Tech stack

Plain HTML, CSS, and vanilla JavaScript — no frameworks, no build tools, no server.

## License

[MIT](LICENSE)
