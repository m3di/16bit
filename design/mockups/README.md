# Mockups

Reference screens from the design phase. They show the agreed direction for layout, spacing, type, and colour.

These files are the source of artboards from a design canvas and load a runtime (`support.js`) that is not included, so they do not open as standalone pages. Read the markup and inline styles for structure and values. Do not ship or import them.

| File | Screen |
|---|---|
| `Home.dc.html` | Main dashboard: workspaces and hubs (light). Uses CSS variables for theming. |
| `HomeDark.dc.html` | The same dashboard in the dark theme |
| `Main.dc.html` | A hub's home: sprint numbers, burndown chart, current work, team, release progress |
| `Work.dc.html` | Personal board grouped by stage, and the ranked backlog |
| `Task.dc.html` | A single item: stages, description, details, history, comments |
| `WorkspaceSettings.dc.html` | Workspace settings: role matrix and members |
| `HubSettings.dc.html` | Hub settings: general, access, folders, attributes |

All data in the mockups is invented sample data.

In M0 only `Home.dc.html` and `HomeDark.dc.html` are built in full. The hub view in M0 is a plain table and item panel styled to match these screens.
