# Design system

Reference screens are in `design/mockups/`. They are the agreed direction: light, thin, and quiet. Match them. Where a screen has not been designed, apply the rules below and flag it for the maintainer.

## Principles

1. **Quiet.** Hairline borders, generous white space, no boxes around blocks unless the block is a card.
2. **Thin.** Two font weights only, 400 and 500. Nothing heavier: bold in rich text is shown at 500.
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
| HubCard | Colour square, name, status line, size meter, count, last active |
| Table | Hairline rows, 36 to 38px, no outer box |
| ItemPanel | Side panel with fields, version, and history |
| StateBlock | Loading skeleton, empty, error, no permission |
| AppShell | Top bar on the main dashboard; light sidebar with folders inside a hub |

## Components for M1

Editable values (CheckboxField, RichTextEditor) have a load-failure `error` state separate from the save-error message. In that state no input is rendered, so a value that failed to load cannot be overwritten by saving a blank one.

| Component | Notes |
|---|---|
| ValueState | Inline loading, empty, error, and no-access states for one value. Every value component uses it. |
| CheckboxField | Native checkbox with label, hint, and error. Read-only with a stated reason when the reader cannot edit. |
| ChipList | Multi-select values as palette chips, in value order. Optional remove buttons and a "+N" limit. Deleted options show as a dashed "Deleted option" chip. |
| UrlLink | Web and mail addresses as a hairline-underlined link without the scheme, opening in a new tab. Other schemes are shown as text, never linked. |
| ActorChip | PixelAvatar and name. Agents carry an "Agent" label. |
| RelationChip | Linked item as mono ID and hairline-underlined title, as in the task mockup. A target the reader cannot see shows "No access", never its title or a link. |
| RichTextView, RichTextEditor | Rich text for a small closed node set: paragraph, headings (h3, h4), bulleted and numbered lists, code block, line break; bold (shown at weight 500), italic, inline code, and http, https, or mailto links. Long text at 13px with 1.6 line height. The editor uses Tiptap and is imported directly, not from the `ui` barrel, so it stays out of the main bundle. |
| AuthLayout, SignInForm | Pages outside a workspace: brand bar and a narrow column, no card. The form has empty, submitting, error, and no-permission states and never says which credential was wrong. |

## Screens without a mockup

The sign-in page and the rich text toolbar have no mockup. They follow the general rules, and the maintainer has accepted that:

- **Sign-in.** A brand bar with the theme switch, then one narrow column (340px at most) with the page title in Space Grotesk 24px, the form, and a hairline-separated footer. No card, no shadow, no illustration.
- **Rich text toolbar.** A quiet row of text buttons at 12px, 28px high, with no border. The active toggle uses the `--selected` fill and `--ink`. It wraps at narrow widths.

## Responsiveness

Layouts are built from flex and grid with wrapping, never fixed widths. At phone width the sidebar stacks above the content, toolbars wrap, and wide tables scroll inside their own box.

## Mockups

`design/mockups/` holds the source of the reference screens: main dashboard (light and dark), project home, my work and backlog, task, workspace settings, and hub settings. They were made in a design canvas and depend on its runtime, so they do not open as standalone pages. Read them for structure, spacing, and colour values.
