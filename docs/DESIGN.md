# Design system

Reference screens are in `design/mockups/`. They are the agreed direction: light, thin, and quiet. Match them. Where a screen has not been designed, apply the rules below and flag it for the maintainer.

## Principles

1. **Quiet.** Hairline borders, generous white space, no boxes around blocks unless the block is a card.
2. **Thin.** Two font weights only, 400 and 500. Nothing heavier: bold in rich text is shown at 500.
3. **Dense but calm.** Desktop first. Rows are 32 to 38px high.
4. **Always designed.** Every block and screen has loading, empty, error, and no-permission states. Anything opened by ID also has a not-found state for a 404.
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
| `--line3` | `#838995` | `#666D7C` |
| `--ink` | `#111318` | `#ECEEF1` |
| `--ink2` | `#4B5261` | `#B4BAC6` |
| `--ink3` | `#676D7B` | `#8E95A3` |
| `--empty` | `#E1E4EA` | `#2A2F3A` |
| `--accent` | `#3B4CCA` | `#8E9BFF` |
| `--on-accent` | `#FFFFFF` | `#0F1115` |
| `--success` | `#157E3C` | `#4ADE80` |
| `--warning` | `#A55A05` | `#FBBF24` |
| `--danger` | `#B42318` | `#F97066` |
| `--selected` | `#EEF0F4` | `#1D2129` |

`--line3` is the border of inputs and selects (at least 3:1 on `--bg`, `--surface`, and `--selected`). `--on-accent` is text on an accent fill.

The values live in `apps/web/src/styles/tokens.css`, and `tokens.test.ts` checks them: text tokens at least 4.5:1 on `--bg`, `--surface`, and `--selected`; status colours, the focus ring, `--line3`, and every palette base colour at least 3:1 on `--bg`. Change this table and `tokens.css` together.

### The 16-colour palette

Used for hub and folder colours, select options, and avatars. Each colour has a base value, a tint for chip backgrounds, and an ink shade for chip text, in both themes. The ink is at least 4.5:1 on its tint and on the page, and the base is at least 3:1 on the page.

| Colour | Light | Light tint | Light ink | Dark | Dark tint | Dark ink |
|---|---|---|---|---|---|---|
| indigo | `#3B4CCA` | `#E4E6F8` | `#3B4CCA` | `#8E9BFF` | `#282D44` | `#8E9BFF` |
| blue | `#2563EB` | `#E0E9FC` | `#235EDF` | `#60A5FA` | `#1F2F43` | `#60A5FA` |
| cyan | `#0891B2` | `#DCF0F4` | `#06738D` | `#22D3EE` | `#133840` | `#22D3EE` |
| teal | `#0F766E` | `#DDECEB` | `#0F746C` | `#2DD4BF` | `#153837` | `#2DD4BF` |
| green | `#15803D` | `#DEEDE4` | `#147739` | `#4ADE80` | `#1B3A2A` | `#4ADE80` |
| lime | `#65A30D` | `#E9F2DD` | `#4A7709` | `#A3E635` | `#2D3C1B` | `#A3E635` |
| yellow | `#A16207` | `#F2E9DC` | `#8C5F03` | `#FACC15` | `#3E3615` | `#FACC15` |
| amber | `#D97706` | `#FAECDC` | `#A15804` | `#FBBF24` | `#3E3418` | `#FBBF24` |
| orange | `#EA580C` | `#FCE8DD` | `#B44409` | `#FB923C` | `#3E2B1D` | `#FB923C` |
| red | `#DC2626` | `#FAE1E1` | `#C62222` | `#F87171` | `#3E2427` | `#F87171` |
| pink | `#BE185D` | `#F6DFE8` | `#BE185D` | `#F472B6` | `#3D2435` | `#F472B6` |
| magenta | `#C026D3` | `#F6E1F9` | `#AB22BC` | `#E879F9` | `#3A2643` | `#E879F9` |
| violet | `#6D28D9` | `#EBE1FA` | `#6D28D9` | `#A78BFA` | `#2D2943` | `#A78BFA` |
| slate | `#4B5261` | `#E6E7E9` | `#4B5261` | `#A3ABBA` | `#2D3036` | `#A3ABBA` |
| ink | `#111318` | `#DEDEDF` | `#111318` | `#ECEEF1` | `#3B3D41` | `#ECEEF1` |
| grey | `#7C8390` | `#EDEEF0` | `#676B73` | `#6B7280` | `#21242A` | `#878D98` |

### Type

| Use | Font | Size | Weight |
|---|---|---|---|
| Body | Inter | 13px | 400 |
| Emphasis, selected, section titles | Inter | 13px | 500 |
| Hub names, brand | Inter | 14px | 500 |
| Secondary | Inter | 12px | 400 |
| Captions | Inter | 11px | 400 |
| Page title | Space Grotesk | 24px | 500 |
| Item or card title | Space Grotesk | 18px | 500 |
| Numbers in number blocks | Space Grotesk | 26px | 500 |
| IDs, versions, raw values | JetBrains Mono | 12px | 400 |

Line height 1.45 for interface text and 1.6 for long text. Rich text (descriptions, comments) is long text: 13px body at weight 400 in `--ink2`, line height 1.6. Headings inside a document are h3 (14px) and h4 (13px) at 500, because the item title owns h1 and h2.

### Links

Links are `--ink` text with a 1px `--line2` bottom border instead of an underline, and the border darkens to `--line3` on hover. This applies to relations (a linked item is shown as its mono ID and its title as a link), URL values, and links inside rich text. A relation the reader cannot see is never a link and never shows its title. External links open in a new tab with `rel="noopener noreferrer"` and say so to screen readers.

### Shape and space

- Spacing on a 4px grid.
- Radius 5px for controls and 6px for cards.
- Borders 1px. Cards and dividers use the `--line` hairline, outlined buttons `--line2`, and inputs and selects `--line3`.
- No shadows on the presentation surface.

### Icons

Material Symbols, outlined, light weight, 18px. The package is added with the first component that needs an icon. The mockups use coloured squares in place of icons; replace those with icons only where an icon adds meaning.

Until the first real icon lands, these glyphs are inline pixel SVGs in `currentColor`, not Material Symbols: "more" on RowActionsMenu (three 2px squares), "close" on BaseDialog (a thin X), the moon and sun on ThemeSwitch (`ThemeGlyph`, a 12 by 12 pixel grid), and the gear on the dashboard hub card's settings link (an 8 by 8 gear around a square hole, `crispEdges`). The Material Symbols package arrives with the first component that needs any other icon.

### Theme switch

One 28px quiet icon button in the brand bar (AppShell, AuthLayout, SettingsLayout, the kit). It shows where a click goes: a moon in light mode and a sun in dark mode, `--ink3` turning `--ink` on hover, and it is named "Switch to dark theme" or "Switch to light theme" (no `aria-pressed`: the name changes instead). A click saves the opposite of the theme shown under `16bit.theme`. With nothing saved the app follows the system theme; the first click makes the choice explicit, and there is no way back to "follow the system" from the interface (issue 241).

## Accessibility

- Body text contrast at least 4.5 to 1, including 11px captions.
- Status is never colour alone: a dot always has a text label.
- Real elements: `button`, `a`, `input` with `label`, `select`. Icon-only buttons have an `aria-label`.
- Everything is reachable and usable by keyboard.
- A toolbar is one tab stop. Arrow keys move between its controls and wrap, Home and End jump to the ends, and toggles use `aria-pressed`.
- Loading values inside cells and fields are not live regions; only the block or page that is loading announces it.

## Components for M0

| Component | Notes |
|---|---|
| Button | Primary (accent fill), outline, quiet. Heights 28 and 32px. |
| Input, Select | 32px, `--line3` border |
| StatusDot | 6px dot plus label |
| Avatar | 5 by 5 pixel sprite generated deterministically from the principal ID, in a palette tint |
| SizeMeter | Four 6px squares. 0 items fills none, 1 to 9 fills one, under 100 two, under 1,000 three, and 1,000 or more four |
| HubCard | Colour square, name, status line, size meter, count, last active. No-access variant (the reader sees the hub's name but has no grant): colour square, name, and "No access" beside a dashed `--line3` square; no count, no size meter, never a link. The props are a union, so a card with access must pass `count` and a no-access card cannot pass `count` or `to`. On the dashboard, a card the reader may manage carries a 28px quiet icon link at its top right, outside the card's own link: the pixel gear, `aria-label` "Settings for Engineering", leading to the hub's General settings. It shows only when the hub page's "Hub settings" link would. |
| Table | Hairline rows, 36 to 38px, no outer box. A sortable column's header is a button with a visible cue at rest: two hairline chevrons (up and down) after the label, in `--ink3` like the label. In a right-aligned column (numbers) the cue goes before the label instead, so the label lines up with the values' right edge. The sorted column shows one chevron for its direction, centred, and its label and chevron are `--ink` at weight 500. The header has `aria-sort`, and the caption says that header buttons sort. The cue keeps its width, so labels do not move when the sort changes. Columns that cannot be sorted show no cue. A click on a row selects it; for rows that hold their own controls, see the static mode under M2. |
| ItemPanel | Side panel with fields, version, and history. At desktop width (`lg`) it sits beside the table with a hairline on its left, adds nothing to the row's height, and scrolls on its own in a sticky box no taller than the viewport or the row, so a long item never scrolls the page and the table stays in view; focus moving to a lower field scrolls the panel. At phone width it stacks under the table with a hairline on top, as tall as its content, and the page scrolls to it. Escape or the close button closes it. |
| StateBlock | Loading skeleton, empty, error, no permission, not found (see below) |
| AppShell | Top bar on the main dashboard; light sidebar with folders inside a hub. In the sidebar the hub's root folder shows just the hub's name and its own count (the hub's total less its folders'), and every other folder is nested under it along a `--line` hairline guide. Screen readers hear the root as the hub's own items ("Product, items in the hub itself, 300 items"). |

## Components for M1

Editable values (CheckboxField, RichTextEditor) have a load-failure `error` state separate from the save-error message. In that state no input is rendered, so a value that failed to load cannot be overwritten by saving a blank one.

| Component | Notes |
|---|---|
| ValueState | Inline loading, empty, error, and no-access states for one value. Every value component uses it. |
| CheckboxField | Native checkbox with label, hint, and error. Read-only with a stated reason when the reader cannot edit. |
| ChipList | Multi-select values as palette chips, in value order. Optional remove buttons and a "+N" limit. Deleted options show as a dashed "Deleted option" chip. Wraps by default; `inline` (table cells) keeps one line: long labels are cut with an ellipsis and the full label as the title, and the "+N" count never shrinks. |
| UrlLink | Web and mail addresses as a hairline-underlined link without the scheme, opening in a new tab. Other schemes are shown as text, never linked. |
| ActorChip | PixelAvatar and name. Agents carry an "Agent" label. Unknown variant (a principal whose name cannot be resolved, such as an agent or a removed member missing from the member list): PixelAvatar and the first 8 characters of the ID in JetBrains Mono 12px `--ink3`, with "name not available" for screen readers. Never an invented name. |
| RelationChip | Linked item as mono ID and hairline-underlined title, as in the task mockup. A target the reader cannot see shows "No access", never its title or a link. |
| RichTextView, RichTextEditor | Rich text for a small closed node set: paragraph, headings (h3, h4), bulleted and numbered lists, code block, line break; bold (shown at weight 500), italic, inline code, and http, https, or mailto links. Long text at 13px with 1.6 line height. The editor uses Tiptap and is imported directly, not from the `ui` barrel, so it stays out of the main bundle. |
| StateBlock not found | A 404, separate from `empty` (the thing exists and has nothing in it) and from `no-permission` (a 403). Hidden things answer 404 like missing ones (`docs/ROLES.md`), so the text never says the thing does not exist: "This hub is not available", "It may not exist, or it may not be shared with you." No retry; offer a way back. The square is an outline in `--line3`; no permission uses a dashed outline, empty a `--line2` fill, error a `--danger` fill. |
| FormNotice | A message about a whole form or action, not one field (fields show their own error under the input). `error`: `--danger` text and filled square, `role="alert"`. `info`: `--ink2` text and outlined square, `role="status"`, for news that is not a failure or a refusal, such as "Changes are saved as you type." A refused sign-in is a refusal and uses `error`. 12px, no box and no border. An optional action, such as a quiet Dismiss button, sits on the right and wraps below at narrow widths, outside the live region. |
| AuthLayout, SignInForm | Pages outside a workspace: brand bar and a narrow column, no card. The form has empty, submitting, error, and no-permission states and never says which credential was wrong. |

## Components for M2

Settings components, from `HubSettings.dc.html` and `WorkspaceSettings.dc.html`. Every one takes a `state`. Loading and error never render an input, so a value that failed to load cannot be saved over. No permission shows the value read-only with the reason in text. Anything opened by ID (a settings page for a hub, a dialog for a folder) also has `not-found`, worded as in M1: "This hub is not available", never "does not exist". Where a state does not apply, the table says why.

| Component | Notes |
|---|---|
| SettingsLayout | Brand bar with the breadcrumb trail in `--ink3` and a hairline-underlined way back, then a 180px section nav beside the content (max 1280px, 28px padding, 40px gap). The current section has the `--selected` fill, `--ink` at 500, and `aria-current="page"`; others are `--ink2`; Danger zone is `--danger`. Page title Space Grotesk 24, with a `leading` slot (the hub's colour square) and an `actions` slot (a primary button, or "All changes saved"). At phone width the nav stacks above the content. States: loading and error keep the nav; no-permission and not-found drop it, since its links would lead nowhere, and keep the way back. In not-found, pass a generic title and a trail without the hub's name: a hidden hub answers 404 like a missing one (D45), so its name must not appear. There is no empty page. |
| SettingsSection | A `section` named by its h2 (13px, 500), an `actions` slot on the right, an optional `--ink3` 12px note under the content, 12px gap. Any `StateBlock` state replaces the content and hides the actions. |
| TabList | WAI-ARIA tabs, automatic activation: one tab stop, arrow keys move and select and wrap, Home and End jump. Tabs are 32px text buttons; the selected tab has the `--selected` fill, `--ink` at 500, like the nav. A hairline under the list. Only the selected panel renders; it is focusable and named by its tab. The panel's content owns its states. |
| BaseDialog | Native modal `<dialog>`: the page behind is inert, focus stays inside, Escape, the Close button, and a click that starts and ends on the backdrop close it, unless it is `persistent`. Focus returns to the opener when it still exists and nothing else has taken focus. 440px (or 640px) at most, `--line2` border, radius 6px, no shadow; the backdrop is `--bg` at 80%. Title Space Grotesk 18 names the dialog; the description is read with it. The first `autofocus` control takes focus. Any `StateBlock` state replaces the body, including not-found for a dialog opened by ID. |
| ConfirmDialog | A BaseDialog with a message, Cancel, and an action named for what it does ("Delete hub", never "OK"). Destructive by default: an outline button with `--danger` text. With `requireText`, the action stays disabled until the exact name is typed (case counts, surrounding spaces do not) and the name field takes focus; without it Cancel takes focus. `busy` disables both buttons and makes the dialog refuse to close (Escape, Close, backdrop), so the reader sees how the action ends; `error` shows a FormNotice and keeps the dialog open. `state` (loading, error, no-permission, not-found) shows a StateBlock instead of the form, for a confirm that first loads what it is about, such as a hub's item count (D52). Empty does not apply: a confirm that affects nothing still asks. |
| RowActionsMenu | A 28px quiet icon button (three pixel squares, `aria-label` "Actions for Tomas") with `aria-haspopup="menu"`. Enter, Space, or Down open it on the first item, Up on the last. Up and Down move and wrap, Home and End jump, Escape closes back to the button, Tab closes and moves on. The menu sits in the top layer (popover), so table scroll boxes never clip it. Destructive items are `--danger`. A disabled item stays focusable with `aria-disabled` and its reason read as its description. States: loading disables the button; error opens to one entry saying the actions could not load; no-permission, or no actions, renders nothing, because a row should not offer actions that are always refused. |
| PalettePicker | The 16 colours as native radios in a labelled `radiogroup`: one tab stop, arrow keys choose, each read by name. Swatches 22px (16px `sm`), radius 3px, 6px apart. The chosen swatch has a 2px `--ink` outline 2px out and a 6px `--bg` square inside, so selection is not colour alone; focus shows the `--accent` ring. `allowNone` adds "No colour" (dashed `--line3`) first. Empty is nothing chosen. No permission shows the colour and its name. |
| ToggleSwitch | `button role="switch"` with `aria-checked`; Space and Enter flip it. 32 by 18px track, 14px knob. Off is `--line3` (3:1 on the page) with a `--bg` knob on the left; on is `--accent` with an `--on-accent` knob on the right. Label and description beside it, or `labelHidden` for a table cell. A boolean is never empty, so there is no empty state. |
| AttributeTypePicker | A `fieldset` of native radios with a legend: each type is a hairline row with its name and a one-line hint (described by it), in a wrapping grid. The chosen row has the `--selected` fill and a `--line3` border. `locked` shows the type as text with the reason, because a type is fixed once the attribute exists (D51). Empty is nothing chosen, with an optional error ("Choose a type."). |
| DataTable, static rows | `mode="static"` for settings lists whose rows hold their own controls (role selects, Revoke buttons, row menus): members, invites, folders, attributes, access, agent keys. A click never selects a row: no `aria-selected`, no pointer, no hover fill. As in the settings mockups, cells sit flush with the section heading with 12px after each, the header is 11px `--ink3` and 32px high, and rows are 38px. One column names each row (`rowHeader`, a `th scope="row"`). Cells are cut with an ellipsis at 320px unless their column is `wrap`: cells with controls (a cut would clip their focus ring) and text that must be read whole, such as a reason or a list of folders. A row-menu column is `shrink` with a `labelHidden` header ("Actions" for screen readers). `minWidth` sets where the table starts scrolling in its own box, so the page never scrolls sideways at 390px. Rows that the reader cannot change show the value as text with the reason beside it and no menu. Loading, empty, error, and no permission belong to the SettingsSection around the table, which replaces it. |
| OptionsEditor | Select options as an ordered list. Each row: a colour swatch that opens a small PalettePicker under the row (a disclosure, `aria-expanded`), the name field, how many items use it, and a RowActionsMenu (Move up, Move down, Remove option). Blank and duplicate names (case-insensitive) show under the field. Add option appends a row with the next palette colour and focuses its name. Removing an option that items use asks first with the count (D51); afterwards focus moves to the row that took its place. Empty says that items can only pick from the list. No permission shows the options as palette chips. |

## Components for M3

| Component | Notes |
|---|---|
| DataTable, virtual rows | `mode="virtual"` for folders too large to render whole (D61), with `@tanstack/vue-virtual`. Clicks select rows and headers sort as in select mode. The table scrolls inside its own box (`height`, 480px by default) under a sticky 36px header. Every row is 38px, borders included, and one line: cells are cut with an ellipsis, `wrap` does not apply, and the layout is fixed so columns do not jump while scrolling (give narrow columns a `width`). `rowCount` sizes the scrollbar. Only the rows in view are rendered, plus 2 above and below, so fewer than 100 rows are in the DOM and a scroll frame stays under D61's 50 ms (issue 218: with 8, the rows out of view were most of each frame's work). Rows come from `rowAt`, the only way to supply virtual rows; `rows` stays required in every mode, so pass `[]`. A row not loaded yet (`rowAt` returns nothing) is a placeholder: an `--empty` bar per cell, "Loading" for screen readers, `aria-busy`, not a live region and not selectable. The `windows` event gives the rows rendered and the offsets of the 200-row windows that hold them, whenever those offsets change; the screen loads the ones it lacks and keeps the last event, so after dropping its rows (a new sort, or a read after a change that may reorder them, D61) it reads those windows again without asking the table. `isInView(index)` on the component says whether a row is in the visible part of the box, so a screen can scroll the selected row to its new place (`scrollToIndex`) only when the reader was looking at it. Keyboard: the selected row (or the first in view) is the one tab stop; Up and Down move the selection and stop at the ends, Page Up and Page Down move by the rows that fit in the box less one, so the row moved from stays in view, Home and End jump. Focus follows, the row scrolls into view below the header, and a row that is not loaded yet is selected when it arrives. The active row (the last one clicked, focused, or moved to) stays rendered at its place when the wheel or the scrollbar takes it out of view, so it keeps focus and the next arrow key moves on from it; it is left out of the `windows` event. With `indexOf` (the row an item is at), the active row follows its item by ID, so a row added or removed above it (D61) does not move focus to another item; loaded rows are keyed by item ID for the same reason. The `select` event says whether a row was chosen by pointer or by keyboard: a screen with an ItemPanel beside the table opens it with `keepFocus` for the keyboard, so focus stays on the row and the arrow keys go on through the rows, and without it for a click, so the reader lands on the panel. Keys pressed in a control inside a row stay with the control. The table has `aria-rowcount` (rows plus the header) and each row `aria-rowindex`, and the caption says that arrow keys move the selection. Loading, empty, error, and no permission belong to the block around the table. |

## Screens without a mockup

The sign-in page and the rich text toolbar have no mockup. They follow the general rules, and the maintainer has accepted that:

- **Sign-in.** A brand bar with the theme switch, then one narrow column (340px at most) with the page title in Space Grotesk 24px, the form, and a hairline-separated footer. No card, no shadow, no illustration.
- **Rich text toolbar.** A quiet row of text buttons at 12px, 28px high, with no border. The active toggle uses the `--selected` fill and `--ink`. It wraps at narrow widths.

The settings mockups have no tabs, dialogs, menus, type picker, or options editor. Those M2 components follow the general rules and the settings nav (above); the maintainer accepted them on #114, along with the outline danger confirm, the pixel glyphs (Icons), and a `--bg` 80% backdrop with no scrim token. Two places differ from the hub settings mockup on purpose: the toggle's off track is `--line3`, not `--line2`, because `--line2` is under 3:1 on the page; and the palette swatches use the token values (yellow `#A16207`, grey `#7C8390`), not the mockup's older ones.

## Responsiveness

Layouts are built from flex and grid with wrapping, never fixed widths. At phone width the sidebar stacks above the content, toolbars wrap, and wide tables scroll inside their own box.

## Charts (M4)

| Component | Notes |
|---|---|
| BurndownChart | The `chart` block's burndown from `Main.dc.html`, hand-written SVG with no chart library. Points left are the sprint's total minus the points done by each item's "Done on" date (D82), stepping over weekdays by default or calendar days (D81). Each step is the start of a day; work done on a weekend counts on the next weekday, and on a weekend "today" is drawn at the Friday. Today's point is the points left now, in a filled `--accent` dot with an `--ink` label box and `--bg` text ("Today: 18 points left"), flipped left near the right edge. Earlier days are `--bg` dots on a 1.5px `--accent` line (dots dropped past 31 days); the ideal line is 1px dashed `--ink3` from the total to 0 at the sprint's end; three hairline `--line` grid lines with `--ink3` 11px labels (total, half, 0); day labels for the first day, the last day and today, dropped where two would overlap. A legend (Actual, Ideal) sits above it on the right. Colours are token utilities on SVG fill and stroke, so the theme switches without a rebuild (D39). The SVG is as many units wide as its box is pixels, so text stays 11px. It is `aria-hidden`; a visually hidden table (Day, Points left, Ideal, with today and the end of the sprint marked) replaces it for screen readers. Before the sprint it draws the ideal line only. A sprint with no points, and the loading, error, no-permission, invalid and unresolved states, belong to the block around it. Rendering four charts (one a 366-day year) and 20 updates on a production build at 6x CPU throttling caused no long task (issue 259). |

## Mockups

`design/mockups/` holds the source of the reference screens: main dashboard (light and dark), project home, my work and backlog, task, workspace settings, and hub settings. They were made in a design canvas and depend on its runtime, so they do not open as standalone pages. Read them for structure, spacing, and colour values.
