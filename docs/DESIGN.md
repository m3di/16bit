# Design system

Reference screens are in `design/mockups/`. They are the agreed direction: light, thin, and quiet. Match them. Where a screen has not been designed, apply the rules below and flag it for the maintainer.

## Principles

1. **Quiet.** Hairline borders, generous white space, no boxes around blocks unless the block is a card.
2. **Thin.** Two font weights only. Nothing bold.
3. **Dense but calm.** Desktop first. Rows are 32 to 38px high.
4. **Always designed.** Every block and screen has loading, empty, error, and no-permission states.
5. **Two surfaces.** Presentation has no schema or filter chrome. Settings is a separate area.
6. **Brand in small doses.** Pixel avatars, the 16-colour palette, and the size squares carry the 16-bit feel. Everything else is plain.

## Tokens

Define these as CSS variables on a theme class and map them into the Tailwind theme. Components use the variables, never raw hex values.

| Token | Light | Dark |
|---|---|---|
| `--bg` | `#FFFFFF` | `#0F1115` |
| `--surface` | `#FAFAFB` | `#161920` |
| `--line` | `#ECEEF1` | `#252A33` |
| `--line2` | `#D9DCE3` | `#343A46` |
| `--ink` | `#111318` | `#ECEEF1` |
| `--ink2` | `#4B5261` | `#B4BAC6` |
| `--ink3` | `#6B7280` | `#8E95A3` |
| `--empty` | `#E1E4EA` | `#2A2F3A` |
| `--accent` | `#3B4CCA` | `#8E9BFF` |
| `--success` | `#15803D` | `#4ADE80` |
| `--warning` | `#D97706` | `#FBBF24` |
| `--danger` | `#B42318` | `#F97066` |
| `--selected` | `#EEF0F4` | `#1D2129` |

### The 16-colour palette

Used for hub and folder colours, select options, and avatars. Each colour needs a tint and an ink shade for chips; derive and check them for contrast when building the tokens.

`#3B4CCA` indigo, `#2563EB` blue, `#0891B2` cyan, `#0F766E` teal, `#15803D` green, `#65A30D` lime, `#CA8A04` yellow, `#D97706` amber, `#EA580C` orange, `#DC2626` red, `#BE185D` pink, `#C026D3` magenta, `#6D28D9` violet, `#4B5261` slate, `#111318` ink, `#9CA3AF` grey.

### Type

| Use | Font | Size | Weight |
|---|---|---|---|
| Body | Inter | 13px | 400 |
| Emphasis, selected, section titles | Inter | 13px | 500 |
| Secondary | Inter | 12px | 400 |
| Captions | Inter | 11px | 400 |
| Page title | Space Grotesk | 24px | 500 |
| Item or card title | Space Grotesk | 18px | 500 |
| Numbers in number blocks | Space Grotesk | 26px | 500 |
| IDs, versions, raw values | JetBrains Mono | 12px | 400 |

Line height 1.45 for interface text and 1.6 for long text.

### Shape and space

- Spacing on a 4px grid.
- Radius 5px for controls and 6px for cards.
- Borders 1px in `--line`; `--line2` for inputs and outlined buttons.
- No shadows on the presentation surface.

### Icons

Material Symbols, outlined, light weight, 18px. The mockups use coloured squares in place of icons; replace those with icons only where an icon adds meaning.

## Accessibility

- Body text contrast at least 4.5 to 1, including 11px captions.
- Status is never colour alone: a dot always has a text label.
- Real elements: `button`, `a`, `input` with `label`, `select`. Icon-only buttons have an `aria-label`.
- Everything is reachable and usable by keyboard.

## Components for M0

| Component | Notes |
|---|---|
| Button | Primary (accent fill), outline, quiet. Heights 28 and 32px. |
| Input, Select | 32px, `--line2` border |
| StatusDot | 6px dot plus label |
| Avatar | 5 by 5 pixel sprite generated deterministically from the principal ID, in a palette tint |
| SizeMeter | Four 6px squares: under 10 items, under 100, under 1,000, and 1,000 or more |
| HubCard | Colour square, name, status line, size meter, count, last active |
| Table | Hairline rows, 36 to 38px, no outer box |
| ItemPanel | Side panel with fields, version, and history |
| StateBlock | Loading skeleton, empty, error, no permission |
| AppShell | Top bar on the main dashboard; light sidebar with folders inside a hub |

## Responsiveness

Layouts are built from flex and grid with wrapping, never fixed widths. At phone width the sidebar stacks above the content, toolbars wrap, and wide tables scroll inside their own box.

## Mockups

`design/mockups/` holds the source of the reference screens: main dashboard (light and dark), project home, my work and backlog, task, workspace settings, and hub settings. They were made in a design canvas and depend on its runtime, so they do not open as standalone pages. Read them for structure, spacing, and colour values.
