# Clearbox: UI Design Spec

- **Status:** Ready for implementation (derived from the approved mockup v4)
- **Date:** 2026-10-15
- **Owner:** ShinyQ
- **Revision:** rev 2.3 reconciliation (2026-10-16): copy and behavior from implementation layer 5 (model banner, Scan now toasts, Clean up and keeps wording, Undo and keeps, account card status text). See contracts 12.6. Rev 2.4 (2026-10-16): Scan history rule and window-aware progress copy (5.1, 5.3, 5.5, 5.6, 5.8). See contracts 12.7.
- **Approved mockup:** [`docs/design/clearbox-ui-v4.html`](../../design/clearbox-ui-v4.html)
- **Companions:** [`2026-10-15-clearbox-design.md`](2026-10-15-clearbox-design.md) (narrative design, section 11 Review UI, section 7 security) and [`2026-10-15-clearbox-contracts.md`](2026-10-15-clearbox-contracts.md) (REST API in section 7, SPA layout in section 1.1, dependencies in section 2). When this spec and the contracts disagree on an API shape, the contracts win; every place where the UI needs something the contracts do not yet provide is listed in section 9.3 with the interim behavior.

This document is the single source of truth for how the Clearbox single-page app looks and behaves. A developer should be able to build every screen from it without making a design decision. All UI copy in this document is final English copy (sentence case). Numbers in copy examples are synthetic.

**Global rules that apply everywhere below**

1. No em dashes in any UI string, code comment, or doc. Use a comma, colon, period, parentheses, or "to". En dashes are allowed only in numeric ranges (for example "86–94%").
2. No colored left or top edge stripes on rows, cards, panels, banners, toasts, or alerts. Emphasis uses a soft background tint, font weight, or an icon.
3. Selection is a soft tint (`surface-selected`, `#F3F4FF`). Keyboard focus is a visible 2px ring (`focus`, `#4F46E5`).
4. Email content (subjects, senders, snippets) is rendered as React text nodes only. HTML email bodies are never fetched or rendered. `dangerouslySetInnerHTML` is banned in the SPA.
5. The Clean up threshold tau is always read from the API (`QueueSummary.tauDelete`, `CleanupPreview.threshold`, `MeResponse.tauDelete`). It is never hardcoded. The current value (0.86) appears in this document only as an example.
6. Confidence is always shown as a percentage plus a band word. Color is never the only cue. Verdicts are always an icon plus a word.

---

## 1. Principles and quality bar

### 1.1 Principles (from PRODUCT.md)

- **The AI prepares, the human confirms.** The owner never faces an unsorted list. Review opens on a summary that already says what will happen, with one primary action: Clean up.
- **Trust through evidence.** Every sender group shows a confidence percentage, a band word, and up to three concrete reasons. Uncertainty is shown (Likely, Unsure, Check), never hidden.
- **Safe by default.** Nothing is irreversible. "Trash" is a recoverable move, every Trash and Archive has Undo for 24 hours (a Keep changes nothing in the mailbox, so there is nothing to undo), and anything below the threshold stays for the owner.
- **Bulk over one-by-one.** The unit of work is the sender group. One keystroke clears a whole group; one Clean up clears every confident group.
- **Every decision teaches.** Approvals, overrides and undos feed the learning loop, and the UI says so ("Clearbox will remember", "decisions learned from you").

### 1.2 Quality bar

The bar is Linear, Superhuman and the Vercel dashboard: the category standard, executed at full craft. Concretely:

| Attribute | Requirement |
|---|---|
| Density | 13px base text, 56px sender rows, nothing larger than 17px except stat values (20px). |
| Calm | Light neutral surfaces, one accent (indigo `#4F46E5`) used sparingly, semantic colors only for verdicts, confidence and status. |
| Speed | Every owner action gives visible feedback within 100 ms (optimistic row removal, button loading state). No full-page spinners after first load. |
| Keyboard | Every triage action has a single-key shortcut; shortcuts are visible as `Kbd` hints next to the actions they trigger. |
| Precision | Pixel values in this spec are exact. Alignment uses the grid templates given; numbers use tabular figures. |
| Honesty | Counts in confirm bars and toasts are exact server counts, never estimates. Estimates are labelled "about". |
| Restraint | No decorative illustrations, no gradients except the Clearbox spark glyph, no KPI card walls, no modals for the main flow. |

---

## 2. Design tokens

All values come from the CSS custom properties and classes of the approved mockup unless a row says "fixed for contrast" (section 7.2 has the measurements). Token names below are the Tailwind v4 theme names; the CSS variable is `--color-<name>` for colors.

### 2.1 Color tokens (light, v1)

#### Surfaces and lines

| Token | Hex | Mockup source | Usage |
|---|---|---|---|
| `canvas` | `#FBFBFC` | `--bg` | App background behind the main area. |
| `surface` | `#FFFFFF` | `--panel` | Cards, panels, list container, inputs, secondary buttons, active nav item. |
| `surface-raised` | `#FCFCFD` | `.lh`, `.detail` background | List header row, detail panel background, table header row. |
| `surface-sunk` | `#F4F5F7` | `--sunk` | Sidebar background, reason icon box, Protected tag, chip remove button, skeleton base. |
| `surface-hover` | `#F8F8FA` | `.row:hover` | Row and menu item hover. |
| `surface-selected` | `#F3F4FF` | `.row.active` | Active (open) row and selected rows. The only selection cue besides the checkbox. |
| `track` | `#F4F5F7` | `.meter` background | Confidence meter track and progress track on light surfaces. |
| `skeleton-highlight` | `#ECEDF1` | `.sk` gradient middle | Skeleton shimmer highlight. |
| `line` | `#E8E9ED` | `--line` | Card and panel borders, list header bottom border, tab bar bottom border, secondary button border. Decorative only. |
| `line-subtle` | `#F0F1F4` | `--line2` | Row separators inside lists and tables. |
| `line-control` | `#868A95` | fixed for contrast (mockup `#C9CBD3`, `#D3D5DC`, `#E8E9ED`) | Boundaries that identify a control: checkbox border, toggle off track, text input border. Meets 3:1. |
| `tick` | `#7C808C` | fixed for contrast (mockup `#B5B8C2`) | The tau tick on confidence meters. |
| `neutral-fill` | `#D9DBE3` | `.av`, split bar third segment | "Left for you" split segment, owner avatar, unknown sender avatar. |

#### Ink (text and icons)

| Token | Hex | Mockup source | Usage |
|---|---|---|---|
| `ink` | `#16171B` | `--ink` | Primary text, headings, sender names, counts, active tab underline, checked checkbox, toggle on track. |
| `ink-2` | `#4A4D57` | `--ink2` | Secondary text: body copy in cards, nav items, table cells, legends, reason text. |
| `ink-3` | `#686C77` | fixed for contrast (mockup `#7C808C`) | Tertiary text: meta, timestamps, snippets, column headers, inactive tabs, Kbd text, placeholders. |
| `on-primary` | `#FFFFFF` | `.btn.primary` | Text on primary button. |
| `primary` | `#16171B` | `.btn.primary` | Primary button background (the Clean up button). |
| `primary-hover` | `#2A2C33` | new | Primary button hover. |
| `inverse` | `#16171B` | `.bar`, `.toast` | Confirm bar, progress bar container, toast background. |
| `on-inverse` | `#FFFFFF` | `.bar`, `.toast` | Main text on inverse surfaces. |
| `on-inverse-2` | `#C9CAD1` | `.bar .btn.ghost` | Ghost button text on inverse. |
| `on-inverse-3` | `#A9ABB5` | `.bar .muted` | Secondary text on inverse. |
| `inverse-track` | `#33353D` | running bar track | Progress track on inverse. |
| `inverse-line` | `#4A4C55` | Kbd border on bar | Kbd border on inverse. |

#### Accent

| Token | Hex | Mockup source | Usage |
|---|---|---|---|
| `accent` | `#4F46E5` | `--accent` | Links, focus ring, current-week chart bar, budget meter fill, spark glyph. Never a button fill. |
| `accent-hover` | `#4338CA` | new | Link hover. |
| `accent-soft` | `#EEF0FF` | `--accent-soft` | "New suggestions ready" pill background. |
| `accent-bar` | `#7F86EB` | fixed for contrast (mockup `#DADCF8`) | Past-week chart bars. |
| `focus` | `#4F46E5` | fixed (mockup halo `#C7CBFF`) | 2px focus outline everywhere except on inverse surfaces (there: `on-inverse`). |
| `spark-from` / `spark-to` | `#8B85FF` / `#4F46E5` | `.spark` | The Clearbox AI spark glyph gradient (SVG gradient, not CSS). |

#### Verdict colors (separate from confidence colors)

| Token | Hex | Usage |
|---|---|---|
| `trash` | `#D93636` | Danger button fill, split bar Trash segment, legend swatch. |
| `trash-hover` | `#C42B2B` | Danger button hover. |
| `trash-soft` | `#FDEEEE` | Trash tag background, error banner background. |
| `trash-ink` | `#B42323` | Trash tag text and icon, error banner text, field error text. |
| `archive` | `#2F6FDB` | Split bar Archive segment, legend swatch, "catching up" status dot, account backlog meter. |
| `archive-soft` | `#ECF2FD` | Archive tag background, info banner background. |
| `archive-ink` | `#1F58B8` | Archive tag text and icon, info banner text. |
| `keep` | `#1F9D55` | Keep legend swatch (Keep tab only). |
| `keep-soft` | `#EAF7EF` | Keep tag background, success banner background. |
| `keep-ink` | `#167A41` | Keep tag text and icon. |
| `check` | `#B76E00` | Check (unsure) swatch. |
| `check-soft` | `#FFF5E0` | Check tag background, warning banner background. |
| `check-ink` | `#8F5600` | Check tag text and icon. |
| `check-line` | `#F4DDB0` | Warning banner border. |
| `check-ink-strong` | `#6E4300` | Warning banner text. |
| Protected | `surface-sunk` + `ink-2` | Protected tag (guardrail applied). Neutral by design. |

Banner variants reuse verdict soft colors: warning = `check-soft` / `check-line` / `check-ink-strong`; error = `trash-soft` / `#F5C9C9` border / `trash-ink`; info = `archive-soft` / `#C9DAF7` border / `archive-ink`; success = `keep-soft` / `#C3E8D1` border / `keep-ink`. Banner borders are 1px all around (never an edge stripe).

#### Confidence bands (owner-binding fill colors, separate text colors for contrast)

| Band | Range (tau from API) | Fill token and hex (meter, swatch) | Text token and hex (band word) | Membership |
|---|---|---|---|---|
| Very sure | `confidence >= 0.95` and `>= tau` | `band-very-sure` `#1F9D55` | `band-very-sure-ink` `#167A41` | In Clean up (for Trash and Archive groups) |
| Sure | `tau <= confidence < 0.95` | `band-sure` `#6CC08B` | `band-sure-ink` `#2F7A4D` | In Clean up (for Trash and Archive groups) |
| Likely | `0.70 <= confidence < tau` | `band-likely` `#E0A030` | `band-likely-ink` `#8F5600` | Left for you |
| Unsure | `confidence < 0.70`, or verdict is Check | `band-unsure` `#E5762E` | `band-unsure-ink` `#B4501A` | Left for you |

The mockup colored band words with the fill colors; those fail 4.5:1 (section 7.2), so band words use the `-ink` variants. Fills keep the exact owner hexes.

#### Status colors (account dots)

| Token | Hex | Meaning | Non-color cue shown next to it |
|---|---|---|---|
| `status-ok` | `#1F9D55` | Up to date | Accessible name "up to date"; Accounts page text "up to date" |
| `status-sync` | `#2F6FDB` | Catching up | Visible percentage or "Sorting" text |
| `status-warn` | `#B76E00` | Needs reconnect (fixed for contrast; mockup `#E0A030`) | Visible "Reconnect" link |
| `status-error` | `#D93636` | Setup error (config_error) | Visible "Fix setup" link |
| `status-off` | `#868A95` | Paused by owner | Visible "Paused" text |

#### Provider tiles and sender avatars

| Token | Hex | Usage |
|---|---|---|
| `provider-gmail` | `#D93025` | Gmail tile on Accounts (fixed for contrast; mockup `#EA4335`). |
| `provider-outlook` | `#0F6CBD` | Outlook tile on Accounts. |
| `provider-off` | `#6B6F7A` | Tile of a paused, needs-reauth or config-error account (fixed; mockup `#9AA0A6`). |
| `avatar-0` .. `avatar-11` | `#B42323`, `#B4501A`, `#8F5600`, `#167A41`, `#0F766E`, `#0E7490`, `#1F58B8`, `#4F46E5`, `#7C3AED`, `#A21CAF`, `#BE185D`, `#475569` | Deterministic sender monogram backgrounds (section 4, SenderAvatar). All pass 4.5:1 with white text. |

### 2.2 Typography

- **Sans stack:** `-apple-system, BlinkMacSystemFont, "Segoe UI", "Inter", system-ui, sans-serif`. No web fonts are loaded (CSP `font-src 'self'` and privacy); "Inter" is used only if installed locally.
- **Mono stack (Kbd only):** `ui-monospace, "SF Mono", Menlo, Consolas, monospace`.
- **Numbers:** `font-variant-numeric: tabular-nums` on the app root (set on `body`). Counts, percentages and times align in columns.
- **Smoothing:** `-webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale`.
- Weights such as 560 render exactly on variable system fonts (SF Pro) and round to the nearest available weight elsewhere (Segoe UI renders 600). That is accepted.

| Token (`text-*`) | Size | Line height | Default weight | Letter spacing | Usage |
|---|---|---|---|---|---|
| `micro` | 10.5px (0.65625rem) | 16px | 400 | 0 | Kbd. |
| `caption` | 11px (0.6875rem) | 14px | 560 | 0 | Band word under the percentage. |
| `meta` | 11.5px (0.71875rem) | 16px | 400 | 0 | Column headers, nav counts, sidebar section header, legend, hints, labels (`.label` uses 560). |
| `small` | 12px (0.75rem) | 17px | 400 | 0 | Snippet line, secondary lines, account item meta, confidence percentage (580 to 560). |
| `body` | 12.5px (0.78125rem) | 18px | 400 | 0 | Default control and table text, buttons (560), nav items, reasons, banners, toasts. |
| `base` | 13px (0.8125rem) | 19px (1.45) | 400 | 0 | App base size (`body`), large button text. |
| `title-sm` | 14px (0.875rem) | 20px | 620 | -0.01em | Brand name (650), detail panel sender name. |
| `title` | 15px (0.9375rem) | 21px | 620 | -0.01em | Empty state title, panel section titles. |
| `title-lg` | 15.5px (0.96875rem) | 22px | 650 | -0.01em | Summary card headline. |
| `h1` | 17px (1.0625rem) | 24px | 650 | -0.015em | Page title. |
| `stat` | 20px (1.25rem) | 26px | 650 | -0.02em | Insights stat values. |

| Weight token (`font-*`) | Value | Usage |
|---|---|---|
| `normal` | 400 | Body text. |
| `medium` | 500 | Table column headers. |
| `emphasis` | 560 | Buttons, active nav, active tab, tab counts, row counts, labels, sender names (mockup 580 normalized to 560), band words, percentage. |
| `semibold` | 620 | Panel titles (mockup 600), detail sender (620), bold lead-in text inside banners, confirm bar and toasts (mockup 600). |
| `heading` | 650 | `h1`, brand, stat values, summary headline (mockup 640, normalized to 650). |
| `heavy` | 700 | Monogram letters, provider tile letters. |

### 2.3 Spacing

Tailwind v4 default `--spacing: 0.25rem` (4px) is kept; fractional steps of 0.25 are used for the mockup's odd values. Every spacing value used in the spec maps to one of these:

| px | Tailwind step | Typical use |
|---|---|---|
| 2 | `0.5` | Split bar gap, tab gap, nav list gap, band text row gap. |
| 4 | `1` | Legend swatch offset, small icon gaps. |
| 5 | `1.25` | Tag icon gap, account item vertical padding. |
| 6 | `1.5` | Button group gap, chip gap, nav item vertical padding. |
| 7 | `1.75` | Button vertical padding (md), legend top margin, reasons gap. |
| 8 | `2` | Nav item horizontal padding, list header vertical padding, generic small gap. |
| 9 | `2.25` | Nav icon gap, monogram right margin, reason icon gap. |
| 10 | `2.5` | Row vertical padding, sidebar horizontal padding, column gap in rows, header gap. |
| 12 | `3` | Detail panel inner gap, button horizontal padding (md), verdict card padding. |
| 14 | `3.5` | Row horizontal padding, sidebar top padding, page header bottom margin, grid gap. |
| 16 | `4` | Panel padding, summary gap, summary bottom margin, detail panel padding. |
| 18 | `4.5` | Main top padding, summary horizontal padding. |
| 22 | `5.5` | Main horizontal and bottom padding. |
| 24 | `6` | Toast offset from viewport bottom. |
| 26 | `6.5` | Empty state panel padding. |
| 32 | `8` | Page empty state vertical padding. |
| 48 | `12` | Setup page top padding. |

### 2.4 Radii

| Token (`rounded-*`) | Value | Usage (mockup value in brackets when normalized) |
|---|---|---|
| `xs` | 4px | Checkbox, meter track and fill (3px), legend swatch (2px stays 2px via `rounded-[2px]`), skeleton (5px), Kbd (5px). |
| `sm` | 6px | Tag, small monogram (22px), reason icon box (5px), menu items. |
| `md` | 8px | Button md, input, select, nav item (7px), large monogram (30px), brand mark (7px). |
| `lg` | 10px | Button lg (9px), verdict card, email preview list, banner, toast, scale cells (9px), provider tile (9px). |
| `xl` | 12px | Panels, summary card, work area (list plus detail), confirm bar. |
| `full` | 9999px | Chips, toggle, status dots, owner avatar. |

Normalization of 1px differences (7 to 8, 9 to 10, 5 to 4 or 6) is deliberate to keep five radius tokens.

### 2.5 Shadows

| Token (`shadow-*`) | Value | Usage |
|---|---|---|
| `card` | `0 1px 2px rgba(16,17,22,.04), 0 4px 14px rgba(16,17,22,.06)` | Summary card. |
| `nav` | `0 1px 2px rgba(16,17,22,.06)` | Active sidebar nav item. |
| `button-primary` | `0 1px 2px rgba(0,0,0,.2), inset 0 1px 0 rgba(255,255,255,.08)` | Primary button. |
| `bar` | `0 12px 30px -10px rgba(16,17,22,.45)` | Confirm and progress bar. |
| `toast` | `0 10px 28px -8px rgba(16,17,22,.4)` | Toasts. |
| `overlay` | `0 2px 6px rgba(16,17,22,.05), 0 24px 60px -24px rgba(16,17,22,.25)` | Menus, select popovers, slide-over detail panel, shortcut dialog, mobile drawer. |

Panels and lists use a 1px `line` border and no shadow (except the summary card).

### 2.6 Z-index layers

Defined as plain CSS variables in `:root` (z-index is not a Tailwind theme namespace) and used as `z-(--z-toast)`.

| Variable | Value | Layer |
|---|---|---|
| `--z-base` | 0 | Page content. |
| `--z-sticky` | 10 | Sticky list header row and tab bar inside the scroll container. |
| `--z-confirm` | 20 | Confirm bar and progress bar (sticky at the bottom of the work area). |
| `--z-slideover` | 30 | Detail slide-over (1024 to 1279px) and detail sheet (below 1024px). |
| `--z-drawer` | 40 | Mobile sidebar drawer and its scrim. |
| `--z-popover` | 50 | Menus and dropdown popovers. |
| `--z-dialog` | 60 | Shortcut help dialog and its backdrop. |
| `--z-toast` | 70 | Toast stack (always above everything, including dialogs). |
| `--z-skiplink` | 80 | "Skip to content" link when focused. |

### 2.7 Motion

| Variable | Value | Used for |
|---|---|---|
| `--duration-fast` | 150ms | Hover and pressed background and color changes, checkbox check, toggle knob, tab underline color. |
| `--duration-base` | 200ms | Row exit (opacity to 0, then height collapse), menu and popover open (opacity plus 4px translate), progress fill width, meter fill on value change, tab underline position. |
| `--duration-slow` | 250ms | Confirm bar enter (8px rise plus fade), toast enter and exit (8px rise plus fade), slide-over (translateX 100% to 0), mobile drawer. |
| `--ease-out` | `cubic-bezier(0.2, 0, 0, 1)` | Everything that enters or expands. |
| `--ease-in` | `cubic-bezier(0.4, 0, 1, 1)` | Everything that exits (toast out, slide-over close, row exit). |
| `--ease-standard` | `cubic-bezier(0.4, 0, 0.2, 1)` | Position or size changes in place (progress width, tab underline). |
| `--animate-shimmer` | `shimmer 1.4s linear infinite` | Skeleton gradient (the only looping animation besides the button spinner). |
| `--animate-spin` | `spin 0.8s linear infinite` | Button loading spinner. |

Nothing animates on first render of data (meters render at final width). No animation exceeds 250ms except the two loops.

**`prefers-reduced-motion: reduce`:** all transforms and size transitions are removed; enter and exit become opacity fades of 150ms; row exits are instant; progress fill jumps to its value; skeleton shimmer stops (static `surface-sunk`); the spinner is replaced by a static three-dot "Working" glyph (the button label already says "Working…"). Implemented with a global rule in `styles.css` (section 2.9) plus `motion-safe:` variants on transform utilities.

### 2.8 Breakpoints

Desktop-first design, implemented with Tailwind's min-width variants (the base style is the narrow layout; `lg:` and `xl:` restore the desktop layout).

| Range | Name | Layout |
|---|---|---|
| `>= 1280px` | `xl` (primary target) | Sidebar 208px fixed. Main fluid. Review work area = list (fluid, min 560px) plus inline detail panel 300px. |
| `1024px – 1279px` | `lg` | Sidebar 208px. Review list takes the full work area width. The detail panel becomes a slide-over: 340px wide, anchored to the right edge of the viewport, full main height, `shadow-overlay`, no scrim (non-modal, the list stays interactive), opened by Enter or click on a row, closed by Esc or its close button. |
| `640px – 1023px` | `sm` | Sidebar collapses into a 48px top bar (menu button, brand, Review count). The menu button opens the sidebar as a modal drawer (208px, scrim `rgba(16,17,22,.32)`). Single column. Detail opens as a full-screen sheet with a back button. Summary card stacks: text above, full-width Clean up button below. List columns: checkbox, sender, verdict, confidence (percentage and band word only, no meter), emails. |
| `< 640px` | base | "Usable, not optimized." Same as `sm` plus: list rows become two lines (sender and count on line 1; verdict tag and confidence text on line 2); tables scroll horizontally inside their panel; keyboard hints hidden. |

### 2.9 Paste-ready Tailwind v4 theme (`app/src/web/styles.css`)

```css
@import "tailwindcss";

/* Clearbox design tokens v1 (light). Source: docs/superpowers/specs/2026-10-15-clearbox-ui-design.md section 2. */
@theme static {
  --color-*: initial;
  --radius-*: initial;
  --shadow-*: initial;
  --text-*: initial;
  --font-weight-*: initial;
  --breakpoint-*: initial;

  /* Surfaces and lines */
  --color-canvas: #FBFBFC;
  --color-surface: #FFFFFF;
  --color-surface-raised: #FCFCFD;
  --color-surface-sunk: #F4F5F7;
  --color-surface-hover: #F8F8FA;
  --color-surface-selected: #F3F4FF;
  --color-track: #F4F5F7;
  --color-skeleton-highlight: #ECEDF1;
  --color-line: #E8E9ED;
  --color-line-subtle: #F0F1F4;
  --color-line-control: #868A95;
  --color-tick: #7C808C;
  --color-neutral-fill: #D9DBE3;

  /* Ink */
  --color-ink: #16171B;
  --color-ink-2: #4A4D57;
  --color-ink-3: #686C77;
  --color-primary: #16171B;
  --color-primary-hover: #2A2C33;
  --color-on-primary: #FFFFFF;
  --color-inverse: #16171B;
  --color-on-inverse: #FFFFFF;
  --color-on-inverse-2: #C9CAD1;
  --color-on-inverse-3: #A9ABB5;
  --color-inverse-track: #33353D;
  --color-inverse-line: #4A4C55;
  --color-white: #FFFFFF;
  --color-transparent: transparent;

  /* Accent */
  --color-accent: #4F46E5;
  --color-accent-hover: #4338CA;
  --color-accent-soft: #EEF0FF;
  --color-accent-bar: #7F86EB;
  --color-focus: #4F46E5;
  --color-spark-from: #8B85FF;
  --color-spark-to: #4F46E5;

  /* Verdicts */
  --color-trash: #D93636;
  --color-trash-hover: #C42B2B;
  --color-trash-soft: #FDEEEE;
  --color-trash-ink: #B42323;
  --color-trash-line: #F5C9C9;
  --color-archive: #2F6FDB;
  --color-archive-soft: #ECF2FD;
  --color-archive-ink: #1F58B8;
  --color-archive-line: #C9DAF7;
  --color-keep: #1F9D55;
  --color-keep-soft: #EAF7EF;
  --color-keep-ink: #167A41;
  --color-keep-line: #C3E8D1;
  --color-check: #B76E00;
  --color-check-soft: #FFF5E0;
  --color-check-ink: #8F5600;
  --color-check-line: #F4DDB0;
  --color-check-ink-strong: #6E4300;

  /* Confidence bands (fills are owner-binding; -ink variants are for text) */
  --color-band-very-sure: #1F9D55;
  --color-band-very-sure-ink: #167A41;
  --color-band-sure: #6CC08B;
  --color-band-sure-ink: #2F7A4D;
  --color-band-likely: #E0A030;
  --color-band-likely-ink: #8F5600;
  --color-band-unsure: #E5762E;
  --color-band-unsure-ink: #B4501A;

  /* Account status */
  --color-status-ok: #1F9D55;
  --color-status-sync: #2F6FDB;
  --color-status-warn: #B76E00;
  --color-status-error: #D93636;
  --color-status-off: #868A95;

  /* Provider tiles */
  --color-provider-gmail: #D93025;
  --color-provider-outlook: #0F6CBD;
  --color-provider-off: #6B6F7A;

  /* Sender monogram palette (index = fnv1a32(domain) % 12) */
  --color-avatar-0: #B42323;
  --color-avatar-1: #B4501A;
  --color-avatar-2: #8F5600;
  --color-avatar-3: #167A41;
  --color-avatar-4: #0F766E;
  --color-avatar-5: #0E7490;
  --color-avatar-6: #1F58B8;
  --color-avatar-7: #4F46E5;
  --color-avatar-8: #7C3AED;
  --color-avatar-9: #A21CAF;
  --color-avatar-10: #BE185D;
  --color-avatar-11: #475569;

  /* Typography */
  --font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", "Inter", system-ui, sans-serif;
  --font-mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace;

  --text-micro: 0.65625rem;
  --text-micro--line-height: 1rem;
  --text-caption: 0.6875rem;
  --text-caption--line-height: 0.875rem;
  --text-meta: 0.71875rem;
  --text-meta--line-height: 1rem;
  --text-small: 0.75rem;
  --text-small--line-height: 1.0625rem;
  --text-body: 0.78125rem;
  --text-body--line-height: 1.125rem;
  --text-base: 0.8125rem;
  --text-base--line-height: 1.45;
  --text-title-sm: 0.875rem;
  --text-title-sm--line-height: 1.25rem;
  --text-title-sm--letter-spacing: -0.01em;
  --text-title: 0.9375rem;
  --text-title--line-height: 1.3125rem;
  --text-title--letter-spacing: -0.01em;
  --text-title-lg: 0.96875rem;
  --text-title-lg--line-height: 1.375rem;
  --text-title-lg--letter-spacing: -0.01em;
  --text-h1: 1.0625rem;
  --text-h1--line-height: 1.5rem;
  --text-h1--letter-spacing: -0.015em;
  --text-stat: 1.25rem;
  --text-stat--line-height: 1.625rem;
  --text-stat--letter-spacing: -0.02em;

  --font-weight-normal: 400;
  --font-weight-medium: 500;
  --font-weight-emphasis: 560;
  --font-weight-semibold: 620;
  --font-weight-heading: 650;
  --font-weight-heavy: 700;

  /* Radii */
  --radius-xs: 4px;
  --radius-sm: 6px;
  --radius-md: 8px;
  --radius-lg: 10px;
  --radius-xl: 12px;
  --radius-full: 9999px;

  /* Shadows */
  --shadow-card: 0 1px 2px rgba(16, 17, 22, 0.04), 0 4px 14px rgba(16, 17, 22, 0.06);
  --shadow-nav: 0 1px 2px rgba(16, 17, 22, 0.06);
  --shadow-button-primary: 0 1px 2px rgba(0, 0, 0, 0.2), inset 0 1px 0 rgba(255, 255, 255, 0.08);
  --shadow-bar: 0 12px 30px -10px rgba(16, 17, 22, 0.45);
  --shadow-toast: 0 10px 28px -8px rgba(16, 17, 22, 0.4);
  --shadow-overlay: 0 2px 6px rgba(16, 17, 22, 0.05), 0 24px 60px -24px rgba(16, 17, 22, 0.25);

  /* Breakpoints (desktop-first design, min-width variants) */
  --breakpoint-sm: 40rem;   /* 640px */
  --breakpoint-lg: 64rem;   /* 1024px */
  --breakpoint-xl: 80rem;   /* 1280px */

  /* Motion */
  --ease-out: cubic-bezier(0.2, 0, 0, 1);
  --ease-in: cubic-bezier(0.4, 0, 1, 1);
  --ease-standard: cubic-bezier(0.4, 0, 0.2, 1);
  --animate-shimmer: shimmer 1.4s linear infinite;
  --animate-spin: spin 0.8s linear infinite;

  @keyframes shimmer {
    from { background-position: 200% 0; }
    to { background-position: -200% 0; }
  }
  @keyframes spin {
    to { transform: rotate(360deg); }
  }
}

:root {
  color-scheme: light;
  --duration-fast: 150ms;
  --duration-base: 200ms;
  --duration-slow: 250ms;
  --z-base: 0;
  --z-sticky: 10;
  --z-confirm: 20;
  --z-slideover: 30;
  --z-drawer: 40;
  --z-popover: 50;
  --z-dialog: 60;
  --z-toast: 70;
  --z-skiplink: 80;
  --layout-sidebar: 208px;
  --layout-detail: 300px;
  --layout-slideover: 340px;
  --layout-row-height: 56px;
}

@layer base {
  html { background: var(--color-canvas); }
  body {
    font-family: var(--font-sans);
    font-size: var(--text-base);
    line-height: var(--text-base--line-height);
    color: var(--color-ink);
    background: var(--color-canvas);
    font-variant-numeric: tabular-nums;
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
  }
  :focus-visible { outline: 2px solid var(--color-focus); outline-offset: 2px; }
  [data-inverse] :focus-visible { outline-color: var(--color-on-inverse); }
  ::selection { background: var(--color-accent-soft); }
}

/* Meter, progress, split bar and chart geometry come from CSS custom properties set through
   React's style prop (CSSOM, allowed by CSP style-src 'self'; see section 8.4). */
@layer components {
  .cb-fill { width: calc(var(--cb-value, 0) * 100%); }
  .cb-tick { left: calc(var(--cb-tau, 0) * 100%); }
  .cb-grow { flex-grow: var(--cb-grow, 0); }
  .cb-bar-height { height: calc(var(--cb-value, 0) * 100%); }
}

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
    scroll-behavior: auto !important;
  }
  .cb-fade { transition: opacity 150ms linear !important; }
}

@media (forced-colors: active) {
  .cb-tag, .cb-chip, .cb-meter, .cb-toast, .cb-bar { border: 1px solid CanvasText; }
  .cb-row[aria-selected="true"] { outline: 2px solid Highlight; outline-offset: -2px; }
}
```

Notes:

- `@theme static` makes Tailwind emit every variable even when no utility references it (the dark set and the `cb-*` classes read them directly).
- Marker classes for forced-colors mode are part of the component contract: VerdictTag adds `cb-tag`, Chip `cb-chip`, ConfidenceMeter and ProgressBar tracks `cb-meter`, Toast `cb-toast`, ConfirmBar `cb-bar`, SenderGroupRow `cb-row`.
- Class examples: `bg-surface`, `bg-surface-selected`, `text-ink-3`, `border-line`, `bg-trash-soft text-trash-ink`, `text-band-likely-ink`, `rounded-xl`, `shadow-card`, `text-body font-emphasis`, `z-(--z-toast)`, `duration-(--duration-base) ease-out`.
- The default Tailwind palette, radii, shadows, text sizes and weights are cleared (`initial`) so off-system values cannot be used by accident. Arbitrary values (`w-[300px]`, `bg-[rgba(22,23,27,.05)]`) are allowed only where this spec writes them out explicitly (layout constants, translucent hover overlays, Kbd tones).

### 2.10 Dark mode token set (OPTIONAL, v1.1, not shipped in v1)

The owner did not request dark mode. v1 ships light only (`color-scheme: light`). The following block is prepared for v1.1 and must stay out of the v1 build (keep it in `app/src/web/styles.dark.css`, not imported). It only remaps variables; component classes do not change. All pairs are measured in section 7.3.

```css
/* v1.1 OPTIONAL. Import from styles.css only when dark mode is approved. */
@media (prefers-color-scheme: dark) {
  :root {
    color-scheme: dark;
    --color-canvas: #0F1013;
    --color-surface: #16171B;
    --color-surface-raised: #131418;
    --color-surface-sunk: #1D1F24;
    --color-surface-hover: #1B1D22;
    --color-surface-selected: #23254A;
    --color-track: #26282E;
    --color-skeleton-highlight: #24262C;
    --color-line: #2A2C33;
    --color-line-subtle: #222429;
    --color-line-control: #777B86;
    --color-tick: #8E929C;
    --color-neutral-fill: #3A3D45;

    --color-ink: #ECEDF0;
    --color-ink-2: #B4B7C0;
    --color-ink-3: #9599A3;
    --color-primary: #ECEDF0;
    --color-primary-hover: #FFFFFF;
    --color-on-primary: #16171B;
    --color-inverse: #26282E;
    --color-on-inverse: #ECEDF0;
    --color-on-inverse-2: #C9CAD1;
    --color-on-inverse-3: #A9ABB5;
    --color-inverse-track: #3A3D45;
    --color-inverse-line: #4A4C55;

    --color-accent: #8B85FF;
    --color-accent-hover: #A5A0FF;
    --color-accent-soft: #24224A;
    --color-accent-bar: #5A5FB8;
    --color-focus: #8B85FF;

    --color-trash-soft: #3A1C1E;
    --color-trash-ink: #FF9A9A;
    --color-trash-line: #5A2A2D;
    --color-archive-soft: #172540;
    --color-archive-ink: #9DBEF7;
    --color-archive-line: #26406B;
    --color-keep-soft: #13301F;
    --color-keep-ink: #7BD9A3;
    --color-keep-line: #1F4D33;
    --color-check-soft: #33260F;
    --color-check-ink: #F2C46D;
    --color-check-line: #5A4317;
    --color-check-ink-strong: #F2C46D;

    --color-band-very-sure-ink: #4CC883;
    --color-band-sure-ink: #8FD3A8;
    --color-band-likely-ink: #E9B455;
    --color-band-unsure-ink: #F0915A;

    --shadow-card: 0 1px 2px rgba(0, 0, 0, 0.3), 0 4px 14px rgba(0, 0, 0, 0.35);
    --shadow-overlay: 0 2px 6px rgba(0, 0, 0, 0.4), 0 24px 60px -24px rgba(0, 0, 0, 0.7);
  }
}
```

Band fills, verdict solid colors (`trash`, `archive`, `keep`, `check`), status dots, provider tiles and avatar colors stay unchanged in dark mode (they pass on the dark track, see 7.3).

---

## 3. Layout shell

### 3.1 Grid

```
+----------------------+---------------------------------------------------------------+
| Sidebar 208px        | Main (fluid, min-width 0, scrolls vertically)                 |
| bg surface-sunk      | padding 18px 22px 22px, bg canvas                             |
| border-right line    |  PageHeader                                                   |
| padding 14px 10px    |  App banners (0 to 3)                                         |
| full viewport height |  Page content                                                 |
| sticky, own scroll   |  (Review: SummaryCard, ActionTabs, Work area, ConfirmBar)     |
+----------------------+---------------------------------------------------------------+
```

- Root: `display: grid; grid-template-columns: 208px minmax(0, 1fr); min-height: 100dvh`.
- Sidebar: `position: sticky; top: 0; height: 100dvh; overflow-y: auto`. Flex column, gap 2px.
- Main: `<main id="main" tabIndex={-1}>`. Content width is fluid on Review. Activity, Insights and Accounts cap content at `max-width: 1040px`; Rules caps at `880px`; Setup is a centered 560px column without the sidebar.
- A "Skip to content" link is the first focusable element: visually hidden until focused, then shown at top-left (12px, 12px) as a secondary button, `z-(--z-skiplink)`, target `#main`.

### 3.2 Sidebar anatomy (top to bottom)

| Element | Spec |
|---|---|
| Brand | Row: padding 4px 8px 14px, gap 9px. Mark: 22px square, radius `md`, bg `ink`, white inbox glyph (SVG, 2px stroke). Word "Clearbox": `text-title-sm font-heading`, letter-spacing -0.01em. Links to `/review`. |
| Nav items | Review, Activity, Insights, Rules. Each: `NavLink`, height 30px, padding 6px 8px, radius `md`, gap 9px, 15px icon (stroke 1.5, 70% opacity), label `text-body text-ink-2`. Count right-aligned `text-meta text-ink-3`. Active: bg `surface`, text `ink`, `font-emphasis`, `shadow-nav`, icon 100% opacity, `aria-current="page"`. Hover (inactive): bg `rgba(22,23,27,.04)`. |
| Review count | `QueueSummary.groups` for "All accounts" (pending sender groups). Hidden when 0 or loading. During a Clean up run it shows the run progress ("63%"). |
| Section header | "Accounts": `text-meta text-ink-3`, padding 16px 8px 6px. It is a link to `/accounts` (hover: `text-ink-2`, underline). |
| Account items | One `AccountStatusItem` per account (variant `sidebar`), in API order. Max 6 shown; more collapse into "N more" linking to `/accounts`. |
| Add account | Nav-style item with plus icon, margin-top 4px, label "Add account", links to `/accounts?add=1`. |
| User row | `margin-top: auto`. Padding 8px, gap 8px. 22px circle avatar (`neutral-fill` bg, `ink` initial of the owner email, `font-heavy text-micro`). Owner email `text-small text-ink-2`, truncated with ellipsis, full value in `title`. The row is a menu button (see Menu): items "Keyboard shortcuts" (`?`), "Sign out" (navigates to `/cdn-cgi/access/logout`). |

Sidebar `<nav aria-label="Primary">` wraps brand, nav items and Add account. Accounts list is a separate `<nav aria-label="Accounts">`.

### 3.3 Page header pattern (`PageHeader`)

Row, `display: flex; align-items: center; gap: 10px; margin-bottom: 14px; min-height: 32px`.

1. `h1` (`text-h1 font-heading`), `tabIndex={-1}` so route changes can focus it.
2. Meta text (`text-small text-ink-3`), optional, directly after the title (for example "Sorted 4 min ago").
3. Actions, pushed right (`margin-left: auto`), gap 8px: selects, ghost and secondary buttons, at most one primary button per page (Rules: Save changes; Review has none in the header because Clean up lives in the summary card).

| Page | Title | Meta | Actions (left to right) |
|---|---|---|---|
| Review | Review | "Sorted 4 min ago" (+ " · catching up" when any in-scope account is backfilling) | Account select ("All accounts"), ghost "Scan now" |
| Activity | Activity | "Undo is available for 24 hours" | Account select |
| Insights | Insights | none | none |
| Rules | Rules | "These always override the AI" | Primary "Save changes" |
| Accounts | Accounts | none | Secondary "Connect Gmail", secondary "Connect Outlook" |

### 3.4 App banners region

Between the PageHeader and the page content: a `div` with `display: flex; flex-direction: column; gap: 8px; margin-bottom: 14px`, rendered only when at least one banner applies. Max 3 banners, ordered error, warning, info; extras collapse into a final info line "2 more issues. See Accounts." Which banners appear on which page is defined in section 5.9.

### 3.5 Routes

Router: React Router 8 data router (`createBrowserRouter` plus `RouterProvider`), as chosen in contracts section 2.

| Path | Page component | Document title | Notes |
|---|---|---|---|
| `/` | `RootRedirect` | none | Loads accounts. 0 accounts: replace to `/setup`. Otherwise replace to `/review`. |
| `/review` | `ReviewPage` | `Review · Clearbox`; with pending groups `(412) Review · Clearbox` | Search params: `account` (account id), `tab` (`all`, `trash`, `archive`, `check`, `keep`; default `all`), `sort` (`confidence`, `count`, `newest`; default `confidence`), `group` (GroupKey of the open group, written with `replace`). |
| `/activity` | `ActivityPage` | `Activity · Clearbox` | Search param `account`. |
| `/insights` | `InsightsPage` | `Insights · Clearbox` | none |
| `/rules` | `RulesPage` | `Rules · Clearbox` (with unsaved changes: `Rules (unsaved) · Clearbox`) | none |
| `/accounts` | `AccountsPage` | `Accounts · Clearbox` | Search params `connected`, `error`, `provider` (consumed on mount, then removed with `replace`); `add=1` focuses the Connect Gmail button; hash `#acc_<id>` scrolls to and focuses that account card. |
| `/setup` | `SetupPage` | `Set up Clearbox` | First run. No sidebar. Reachable any time; shows "Go to Review" once an account exists. |
| `/settings/accounts` | `OAuthReturn` | none | Fixed by the server (contracts 7.14). Reads `sessionStorage["clearbox.oauthReturn"]` (`"/setup"` or `"/accounts"`, default `"/accounts"`), removes it, and replaces to that path with the same query string. |
| `/dev/components` | `ComponentGallery` | `Components · Clearbox` | Only registered when `import.meta.env.DEV`. Renders section 7 of the mockup with live components for visual QA. |
| `*` | `NotFoundPage` | `Page not found · Clearbox` | "Page not found" / "This page does not exist in Clearbox." / secondary button "Go to Review". |

Route-to-API tab mapping: `trash` to `action=delete`, `archive` to `archive`, `check` to `unsure`, `keep` to `keep`, `all` to no `action` parameter.

---

## 4. Component inventory

### 4.0 Shared view types and helpers (`app/src/web/lib/`)

```ts
// lib/view-types.ts
import type { SenderGroup, SuggestionItem, AccountView, CleanupPreview, ApiReason, GroupKey } from "../../shared/api.ts";

export type Verdict = "delete" | "archive" | "keep" | "unsure";          // API SuggestedAction
export type TagKind = Verdict | "protected";
export type Band = "very_sure" | "sure" | "likely" | "unsure";
export type TabKey = "all" | "trash" | "archive" | "check" | "keep";
export type GroupSort = "confidence_desc" | "count_desc" | "newest";
export type Platform = "mac" | "other";
export type AccountUiStatus = "up_to_date" | "catching_up" | "paused" | "needs_reauth" | "config_error" | "waiting";

export const VERDICT_LABEL: Record<Verdict, string> = { delete: "Trash", archive: "Archive", keep: "Keep", unsure: "Check" };
export const BAND_LABEL: Record<Band, string> = { very_sure: "Very sure", sure: "Sure", likely: "Likely", unsure: "Unsure" };
export const TAB_ACTION: Record<TabKey, Verdict | undefined> = { all: undefined, trash: "delete", archive: "archive", check: "unsure", keep: "keep" };
```

```ts
// lib/confidence.ts
export const VERY_SURE_MIN = 0.95;
export const LIKELY_MIN = 0.70;

/** Band for a confidence value. tau always comes from the API. Check (unsure) verdicts are always "unsure". */
export function bandFor(confidence: number, tau: number, verdict: Verdict): Band {
  if (verdict === "unsure") return "unsure";
  if (confidence < LIKELY_MIN) return "unsure";
  if (confidence < tau) return "likely";
  if (confidence < VERY_SURE_MIN) return "sure";
  return "very_sure";
}

/** Floor, never round, so 0.949 shows "94%" and stays consistent with the band. Epsilon guards float drift (0.29 * 100). */
export function toPercent(confidence: number): number {
  return Math.floor(confidence * 100 + 1e-9);
}

/** True when this verdict and band are executed by Clean up. Keep is never in Clean up (section 5.2). */
export function inCleanup(verdict: Verdict, band: Band): boolean {
  return (verdict === "delete" || verdict === "archive") && (band === "sure" || band === "very_sure");
}
```

Group rows display `confidence.avg`. Detail panels also show the range (`min` to `max`).

```ts
// lib/format.ts (all Intl based, browser locale; examples use en-US)
formatCount(1284)            // "1,284"
plural(n, "email", "emails") // "1 email", "1,284 emails"
formatPercent(0.986, 1)      // "98.6%"  (Insights only; confidence always uses toPercent)
relativeAgo(iso, now)        // "just now" (< 60 s), "4 min ago", "2 h ago", "yesterday", "3 days ago", then "12 Oct"
shortAge(iso, now)           // email list: "now", "45m", "3h", "2d", "5w", "Mar 2024" (> 1 year)
activityWhen(iso, now)       // "Today 16:21", "Yesterday 09:02", "Sun 12 Oct, 18:40" (24h or 12h follows locale)
localResetTime(now)          // next 00:00 UTC rendered in local time: "07:00"
modKeyLabel(platform)        // "⌘" or "Ctrl"
```

Account display label: there is no nickname in the API, so an account is always shown as its email address (for example `you@gmail.com`), with the provider name where context needs it ("Gmail, you@gmail.com").

`deriveAccountUiStatus(account, now)`:

| Condition (first match wins) | Result |
|---|---|
| `status === "config_error"` | `config_error` |
| `status === "needs_reauth"` | `needs_reauth` |
| `paused` | `paused` |
| `sync.backoffUntil` is in the future | `waiting` |
| `sync.phase !== "incremental"` or `!sync.backfillDone` | `catching_up` |
| otherwise | `up_to_date` |

### 4.1 AppShell

- **Purpose:** frame every authenticated page: sidebar, main, banners, toasts, global shortcuts, the Clean up run (so it survives navigation), the shortcut dialog.
- **Anatomy:** skip link, `SidebarNav`, `<main>`, `ToastRegion`, `ShortcutHelpDialog`, `GSequenceHint`, `OfflineWatcher`.
- **Props:**

```ts
interface AppShellProps { children: React.ReactNode }
```

Providers mounted above it in `main.tsx`: `QueryClientProvider`, `RouterProvider`. Inside AppShell: `ToastProvider`, `UndoStackProvider`, `CleanupProvider`, `HotkeysProvider`.

- **States:** `loading` (me and accounts loading: sidebar skeleton with 4 nav skeleton bars, main shows the page's own skeleton); `ready`; `session_error` (any query returns 401, 403 or `access_misconfigured`: AppShell renders the full-page error state from section 5.9 instead of children).
- **Tokens:** sidebar `bg-surface-sunk border-r border-line`; main `bg-canvas`.
- **Accessibility:** landmarks `nav` (Primary), `nav` (Accounts), `main`, `region` "Notifications" (toasts). `lang="en"` on `html`. Document title per route (3.5).
- **Copy:** skip link "Skip to content".

### 4.2 SidebarNav

- **Purpose:** primary navigation plus account health at a glance.
- **Anatomy:** see 3.2.
- **Props:**

```ts
interface NavItem {
  to: "/review" | "/activity" | "/insights" | "/rules";
  label: "Review" | "Activity" | "Insights" | "Rules";
  icon: IconName;                 // "review" | "activity" | "insights" | "rules"
  count?: number | null;          // Review only
  progressLabel?: string | null;  // "63%" during a Clean up run (replaces count)
  shortcut: string;               // "G R", "G A", "G I", "G U" (shown in the item's title attribute)
}
interface SidebarNavProps {
  items: NavItem[];
  accounts: AccountView[];
  ownerEmail: string;
  variant: "rail" | "drawer";     // rail: >= 1024px; drawer: < 1024px modal drawer
  onNavigate?: () => void;        // drawer closes itself after navigation
}
```

- **States:** item default, hover (`bg-[rgba(22,23,27,.04)]`), focus-visible (2px `focus` outline, offset -2px so it stays inside the 208px rail), active (`aria-current="page"`, see 3.2), pressed (`bg-[rgba(22,23,27,.06)]`). Drawer variant: scrim click or Esc closes, focus returns to the menu button.
- **Accessibility:** items are links. Counts get an accessible suffix: `aria-label="Review, 412 groups to review"`. Drawer: `role="dialog" aria-modal="true" aria-label="Navigation"`, focus trapped.
- **Copy:** "Review", "Activity", "Insights", "Rules", "Accounts", "Add account", "Keyboard shortcuts", "Sign out", menu button "Open navigation" / "Close navigation".

### 4.3 AccountStatusItem

- **Purpose:** one connected mailbox with a status dot and the next step when something is wrong.
- **Anatomy (sidebar):** row padding 5px 8px, gap 8px, `text-body text-ink-2`: 7px status dot, email (truncate), trailing affordance (right aligned, `text-small`).
- **Props:**

```ts
interface AccountStatusItemProps {
  account: AccountView;
  status: AccountUiStatus;                  // from deriveAccountUiStatus
  catchUpPercent: number | null;            // needs contract addition A4; null shows "Sorting"
  variant: "sidebar" | "inline";            // inline: Insights table status cell
  onReconnect: (account: AccountView) => void;
}
```

| Status | Dot | Trailing affordance (sidebar) | Inline text (tables) | Accessible name |
|---|---|---|---|---|
| `up_to_date` | `status-ok` | none | "Up to date" | "you@gmail.com, up to date" |
| `catching_up` | `status-sync` | `text-ink-3` "41%" or "Sorting" | "Catching up" | "you@outlook.com, catching up, 41% sorted" |
| `waiting` | `status-sync` | `text-ink-3` "Waiting" | "Waiting for Gmail" / "Waiting for Outlook" | "you@gmail.com, waiting for the provider, retrying in 3 min" |
| `paused` | `status-off` | `text-ink-3` "Paused" | "Paused" | "you@gmail.com, paused" |
| `needs_reauth` | `status-warn` | link button "Reconnect" (`text-ink-2`, underline on hover) | "Needs reconnect" | "you@company.com, needs reconnect" |
| `config_error` | `status-error` | link "Fix setup" to `/accounts#acc_<id>` | "Setup error" | "you@company.com, setup error" |

- **Interactions:** clicking the row (outside the trailing link) goes to `/accounts#acc_<id>`. "Reconnect" calls `onReconnect`: writes `sessionStorage["clearbox.oauthReturn"] = "/accounts"` then `window.location.assign("/oauth/google/start?loginHint=<email>")` (or `/oauth/microsoft/start`).
- **Accessibility:** the row is a link with the accessible name above; the trailing Reconnect is a separate button (not nested inside the link: the row is rendered as a flex container with the link covering the email area and the button beside it). Dot is `aria-hidden`.

### 4.4 PageHeader

- **Purpose and anatomy:** see 3.3.
- **Props:**

```ts
interface PageHeaderProps {
  title: string;
  meta?: React.ReactNode;
  actions?: React.ReactNode;
  titleRef?: React.Ref<HTMLHeadingElement>;   // focused on route change
}
```

- **States:** static. Meta text updates every 30 s for relative times ("Sorted 4 min ago").
- **Accessibility:** exactly one `h1` per page.

### 4.5 SummaryCard (AI summary, split bar, legend, Clean up)

- **Purpose:** the hero. States what Clean up will do, with one primary button.
- **Anatomy:** card `bg-surface border border-line rounded-xl shadow-card`, padding 16px 18px, flex row, gap 16px, margin-bottom 16px.
  1. Spark glyph 22px (SVG four-point star, linear gradient `spark-from` to `spark-to`, `aria-hidden`).
  2. Text column (`flex: 1; min-width: 0`): headline `h2 text-title-lg font-heading`, margin-bottom 3px; sub-line `p text-body text-ink-2`; split bar (margin-top 10px, width 340px, max-width 100%, height 6px, `rounded-xs`, overflow hidden, segments separated by 2px gaps); legend (margin-top 7px, gap 14px, `text-meta text-ink-2`, each item a 7px `rounded-[2px]` swatch, 5px gap, then text).
  3. Primary button size `lg`: "Clean up 1,284" plus Kbd "⌘ ↵".
- **Props:**

```ts
interface SummaryCardProps {
  state: "loading" | "ready" | "nothing_sure" | "error";
  preview: CleanupPreview | null;          // GET /api/cleanup/preview?actions=delete,archive
  pendingTotal: number;                    // QueueSummary.pending.total
  awaitingModel: number;                   // QueueSummary.awaitingModel
  groupsLeft: number | null;               // contract addition A2; null uses the email-count fallback copy
  tau: number;                             // preview.threshold
  catchingUp: boolean;
  cleanupBusy: boolean;                    // a Clean up run is preparing or running
  offline: boolean;
  platform: Platform;
  onCleanUp: () => void;
  onRetry: () => void;
}
```

- **Split bar segments** (zero-count segments are omitted, and so are their legend items): Trash `bg-trash` grows by `byAction.delete`; Archive `bg-archive` grows by `byAction.archive`; Left for you `bg-neutral-fill` grows by `pendingTotal - preview.count`. Growth is set with `style={cssVars({ "--cb-grow": n })}` and class `cb-grow`. The bar is `aria-hidden`; the legend carries the information.

| State | Headline | Sub-line | Bar and legend | Button |
|---|---|---|---|---|
| `loading` | Skeleton 260px x 14px | Skeleton 360px x 10px | Skeleton 340px x 6px | Hidden; a 120px x 36px skeleton in its place |
| `ready` | "1,284 emails are ready to clean up" (1: "1 email is ready to clean up") | "Clearbox is confident about 371 sender groups. 41 groups are left for you to check." (see variants) | Shown | Enabled: "Clean up 1,284" + Kbd |
| `nothing_sure` (`preview.count === 0`, `pendingTotal > 0`) | "Nothing is sure enough to clean up yet" | "41 groups are left for you to check. Suggestions at 86% or higher go into Clean up." | Only the Left for you segment | Hidden |
| `error` | "Couldn't load the Clean up summary" | "Your sender groups below still work." | Hidden | Secondary "Try again" (calls `onRetry`) |

Sub-line variants for `ready`: when `groupsLeft === 0`: "Clearbox is confident about 371 sender groups. Nothing else needs you."; when `groupsLeft === null` (A2 not available): "Clearbox is confident about 371 sender groups. 240 emails are left for you to check."; when `catchingUp`: append " Still sorting older mail."; when `awaitingModel > 0`: append " 25 emails are waiting for the AI model." Singular forms: "1 sender group", "1 group is left".

Legend copy: "1,102 to trash", "182 to archive", "240 to check or keep".

| Button state | Visual | Behavior |
|---|---|---|
| default | `bg-primary text-on-primary shadow-button-primary` | Click or `mod+Enter`: start the Clean up flow (section 5.2). |
| hover | `bg-primary-hover` | |
| focus-visible | 2px `focus` outline, offset 2px | |
| active | `translate-y-px` (motion-safe only) | |
| loading (`cleanupBusy`, preparing) | 12px spinner before the label; label "Preparing…"; `aria-busy="true"` | Disabled |
| running | Label "Cleaning up…", disabled | Progress shows in the ConfirmBar |
| disabled (offline) | 45% opacity, `aria-disabled="true"` | Helper below the legend: "You're offline." |

- **Accessibility:** `section aria-labelledby` the headline. Button `aria-keyshortcuts="Meta+Enter"` (mac) or `"Control+Enter"`.

### 4.6 ActionTabs

- **Purpose:** filter the sender group list by verdict.
- **Anatomy:** row with bottom border `line`, gap 2px. Tabs: padding 8px 10px, `text-body text-ink-3`; count `b` margin-left 4px `font-emphasis text-ink-2`. Active tab: `text-ink font-emphasis`, 2px `ink` underline inset 8px from each side at bottom -1px, `rounded-xs`. Right side (`margin-left: auto`): optional "New suggestions" pill, then the Sort select (borderless variant, "Sort: Confidence").
- **Props:**

```ts
interface ActionTabsProps {
  value: TabKey;
  counts: Record<TabKey, number | null>;   // group counts; null renders no count (loading or A1 missing)
  onChange: (tab: TabKey) => void;
  sort: GroupSort;
  onSortChange: (sort: GroupSort) => void;
  newSuggestions: boolean;
  onRefresh: () => void;
}
```

- **Tabs and copy:** "All", "Trash", "Archive", "Check", "Keep". Sort options: "Confidence" (`confidence_desc`), "Most emails" (`count_desc`), "Newest" (`newest`); rendered label "Sort: Confidence".
- **New suggestions pill:** `bg-accent-soft text-accent rounded-full px-2.5 py-0.5 text-meta font-emphasis`, text "New suggestions · Refresh". Button.
- **States:** tab default, hover (`text-ink-2`), focus-visible (outline offset -2px), selected, disabled (never). Count of 0 shows "0" in `text-ink-3`.
- **Accessibility:** WAI-ARIA tabs: `role="tablist" aria-label="Filter by suggestion"`, `role="tab" aria-selected aria-controls="group-list"`, roving tabindex, Left and Right arrows move, Home and End jump, activation on focus (automatic). Number keys 1 to 5 select tabs globally on Review. Accessible tab name includes the count: "Trash, 318 groups".

### 4.7 SenderGroupList (with header row and selection toolbar)

- **Purpose:** the scannable list of sender groups for the active tab.
- **Anatomy:** the work area is a grid container `bg-surface border border-line rounded-xl overflow-hidden` with its top border and top radii removed (it hangs from the tabs): `grid-template-columns: minmax(0, 1fr) 300px` at `xl`, single column below. The list column has `border-r border-line` at `xl`.
  - **Header row:** sticky (`top: 0`, `z-(--z-sticky)`), `bg-surface-raised border-b border-line`, padding 8px 14px, same grid as rows: `grid-template-columns: 22px minmax(0, 1fr) 92px 108px 44px; gap: 10px`, `text-meta text-ink-3`. Cells: select-all Checkbox, "Sender", "Verdict", "Confidence", "Emails" (right aligned).
  - **Selection toolbar:** when at least one group is selected, the header row content is replaced (same height, same background): Checkbox (mixed or checked), "3 groups selected · 455 emails" (`text-body font-emphasis text-ink`), then buttons size `sm`: secondary "Approve suggestions", secondary "Trash" + Kbd `T`, secondary "Archive" + Kbd `A`, secondary "Keep" + Kbd `E`, ghost "Clear" + Kbd `Esc` (pushed right). When every loaded group of the tab is selected and more pages exist, a second line appears under the toolbar: "All 50 loaded groups are selected. Select all 318 in Trash" (link button).
  - **Rows:** `SenderGroupRow` x n.
  - **Load more:** infinite scroll. A sentinel 400px before the end triggers `fetchNextPage`; while fetching, 3 skeleton rows are appended. Page size 50.
- **Props:**

```ts
interface SenderGroupListProps {
  state: "loading" | "ready" | "empty" | "error";
  tab: TabKey;
  groups: SenderGroup[];
  tau: number;
  accountsById: Record<string, AccountView>;
  showAccount: boolean;                         // true when more than one account and the filter is "All accounts"
  activeKey: GroupKey | null;
  selected: ReadonlySet<GroupKey>;
  busyKeys: ReadonlySet<GroupKey>;              // rows with an in-flight action
  totalInTab: number | null;                    // for "Select all 318 in Trash"
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  onActivate: (key: GroupKey, opts: { openDetail: boolean }) => void;
  onToggleSelect: (key: GroupKey, opts: { range: boolean }) => void;
  onSelectAllLoaded: () => void;
  onSelectAllInTab: () => void;
  onClearSelection: () => void;
  onBulkAction: (action: "approve" | "delete" | "archive" | "keep") => void;
  onLoadMore: () => void;
  onRetry: () => void;
}
```

| State | Rendering |
|---|---|
| `loading` | Header row (checkbox disabled) plus 8 skeleton rows. |
| `ready` | Rows. |
| `empty` | `EmptyState` variant `panel` inside the list column, copy per tab (below). |
| `error` | `EmptyState` with title "Couldn't load sender groups", body "Check your connection, then try again.", secondary button "Try again". |
| busy toolbar | While a bulk action runs: toolbar text "Working on 2 of 3 groups…", buttons disabled, spinner. |

Empty copy per tab: All: "Nothing to review" / "New mail gets sorted every 30 minutes."; Trash: "No trash suggestions" / "Nothing here looks safe to trash right now."; Archive: "No archive suggestions" / "Receipts and finished threads will show up here."; Check: "No groups to check" / "Clearbox is confident about everything left."; Keep: "No keep suggestions" / "Emails Clearbox thinks you should keep will show up here."

- **Approve suggestions** is disabled when any selected group is a Check group; helper text under the toolbar: "Check groups need your choice. Use Trash, Archive or Keep."
- **Accessibility:** `role="grid" id="group-list" aria-label="Sender groups, Trash tab" aria-multiselectable="true" aria-rowcount={totalInTab ?? -1} aria-busy` while loading. Header row `role="row"` with `role="columnheader"` cells. Rows are `role="row"` with `aria-selected` (checkbox state) and `aria-rowindex`. Row focus mode: one row has `tabIndex=0` (roving), others -1; Up and Down arrows (and J and K) move; Home and End jump to first and last loaded row; PageUp and PageDown move by 10. Cells are `role="gridcell"`. Selection toolbar is a `role="toolbar" aria-label="Selected groups"` rendered inside the header row's single spanning cell.

### 4.8 SenderGroupRow

- **Purpose:** one sender group: who, what Clearbox suggests, how sure, how many.
- **Anatomy:** `display: grid; grid-template-columns: 22px minmax(0,1fr) 92px 108px 44px; gap: 10px; align-items: center; padding: 10px 14px; min-height: 56px; border-bottom: 1px solid line-subtle`.
  1. Checkbox (15px).
  2. Sender cell: `SenderAvatar` 22px, margin-right 9px, then a two-line block: name (`font-emphasis text-ink`, truncate) followed inline by a `VerdictTag kind="protected" size="sm"` when `ceilingApplied`; second line (`text-small text-ink-3`, single line ellipsis): latest subject (contract addition A6), falling back to the first top reason text. When `showAccount`, the second line is prefixed with the account email and " · ".
  3. `VerdictTag` (md).
  4. `ConfidenceLabel` variant `cell` (percentage + band word on line 1, `ConfidenceMeter` on line 2).
  5. Count, right aligned, `font-emphasis text-ink-2`.
- **Props:**

```ts
interface SenderGroupRowProps {
  group: SenderGroup;
  tau: number;
  rowIndex: number;
  active: boolean;           // open in the detail panel
  selected: boolean;
  busy: boolean;
  focusable: boolean;        // roving tabindex owner
  accountEmail: string | null;
  onClick: (e: React.MouseEvent) => void;          // activate; shift: range select; mod: toggle select
  onCheckboxChange: (e: React.MouseEvent | React.KeyboardEvent) => void;
}
```

Display name rule: `group.senderName` if present and not equal to the address, else the address; empty sender shows "Unknown sender" in `text-ink-3`.

| State | Visual |
|---|---|
| default | `bg-surface` |
| hover | `bg-surface-hover` (`duration-fast`) |
| active (open in detail) | `bg-surface-selected` |
| selected (checked) | `bg-surface-selected` and checked checkbox |
| active and hover | stays `bg-surface-selected` |
| focus-visible | 2px `focus` outline, offset -2px (inside the row) |
| busy | Contents at 60% opacity, a 12px spinner replaces the count, `aria-busy="true"`, row ignores action keys |
| exiting (after a successful action) | Opacity to 0 (`duration-base ease-in`), then height collapses to 0 (`duration-base`); reduced motion: removed instantly |
| disabled | Never; rows of accounts that need reconnect stay actionable and the server returns `retry_later` |

- **Accessibility:** accessible row name (via `aria-label` on the row): "Shopee, Trash, 97% Very sure, in Clean up, 248 emails". Protected appends ", protected by a guardrail".

### 4.9 SenderAvatar

- **Purpose:** recognizable, private sender monogram. Remote favicons and logos are never loaded (privacy, and CSP `img-src 'self' data:`).
- **Anatomy:** square, `rounded-sm` (22px) or `rounded-md` (30px), centered single letter `text-white font-heavy`, 10.5px (22px size) or 13px (30px size).
- **Props:**

```ts
interface SenderAvatarProps {
  name: string | null;    // display name
  address: string;        // "" for unknown sender
  domain: string;         // SenderGroup.domain
  size: 22 | 30;
}
```

- **Algorithm:**

```ts
// lib/avatar.ts
export function fnv1a32(s: string): number {
  let h = 0x811c9dc5;
  for (const ch of s) { h ^= ch.codePointAt(0) ?? 0; h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}
export function avatarColorIndex(domain: string): number {
  return fnv1a32(domain.trim().toLowerCase()) % 12;            // --color-avatar-<index>
}
export function monogram(name: string | null, address: string, domain: string): string {
  const source = (name ?? "").trim() || address.split("@")[0] || domain;
  const m = source.match(/[\p{L}\p{N}]/u);
  return m ? m[0].toLocaleUpperCase() : "?";
}
```

Avatar classes are a static lookup (`AVATAR_BG = ["bg-avatar-0", ..., "bg-avatar-11"]`) so Tailwind can see every class name. Unknown sender (empty address and domain): `?` on `bg-neutral-fill text-ink`.

- **States:** static.
- **Accessibility:** `aria-hidden="true"`; the name is always next to it.

### 4.10 VerdictTag

- **Purpose:** what Clearbox suggests (or that a guardrail protects the group). Always icon plus word.
- **Anatomy:** `inline-flex items-center gap-[5px] rounded-sm text-meta font-emphasis`, padding 2px 8px 2px 6px (md) or 1px 6px 1px 4px with 10px icon (sm). Icon 12px SVG, `currentColor`, stroke 1.6.

| Kind | Background | Text and icon | Icon | Default word |
|---|---|---|---|---|
| `delete` | `trash-soft` | `trash-ink` | trash can | "Trash" |
| `archive` | `archive-soft` | `archive-ink` | archive box | "Archive" |
| `keep` | `keep-soft` | `keep-ink` | circle with check | "Keep" |
| `unsure` | `check-soft` | `check-ink` | circle with question mark | "Check" |
| `protected` | `surface-sunk` | `ink-2` | shield | "Protected" |

- **Props:**

```ts
interface VerdictTagProps {
  kind: TagKind;
  label?: string;        // overrides the default word, for example "Move 248 to Trash" in the detail panel
  size?: "sm" | "md";    // default "md"
}
```

- **States:** static (not interactive). Forced colors: 1px `CanvasText` border via `.cb-tag`.
- **Accessibility:** icon `aria-hidden`; the word is the accessible text.

### 4.11 ConfidenceMeter

- **Purpose:** visual magnitude of confidence with the Clean up threshold tick. Supplementary: the percentage and band word always appear beside it.
- **Anatomy:** `.cb-meter` `relative h-1 rounded-xs bg-track` (overflow visible). Fill `<i>` `cb-fill h-full rounded-xs` colored by band fill token. Tick: `cb-tick absolute -top-[3px] -bottom-[3px] w-[1.5px] rounded-[1px] bg-tick -translate-x-1/2`.
- **Props:**

```ts
interface ConfidenceMeterProps {
  value: number;          // 0..1
  band: Band;
  tau: number | null;     // null hides the tick (used for non-confidence meters such as budget)
  height?: 4 | 6;         // 4 default; 6 for budget and backlog meters
  tone?: "band" | "accent" | "archive";   // non-confidence meters
}
```

Geometry is set with `style={cssVars({ "--cb-value": value, "--cb-tau": tau ?? 0 })}` (custom properties only, see 8.4).

- **States:** default; loading (track only, `animate-shimmer` gradient); value change animates width `duration-base ease-standard` (motion-safe).
- **Accessibility:** `aria-hidden="true"` (the adjacent ConfidenceLabel is the accessible text). Budget and backlog meters (no adjacent text duplicate) use `role="progressbar"` instead; see ProgressBar.

### 4.12 ConfidenceLabel

- **Purpose:** the textual confidence: percentage plus band word, plus membership hint where needed.
- **Anatomy (cell):** grid `grid-template-columns: 1fr auto; gap: 2px 8px; align-items: center`: percentage (`text-small font-emphasis text-ink`), band word (`text-caption font-emphasis`, band `-ink` color), meter spanning both columns.
- **Props:**

```ts
interface ConfidenceLabelProps {
  value: number;
  verdict: Verdict;
  tau: number;
  variant: "cell" | "inline" | "scale";   // cell: list row; inline: detail panel verdict card; scale: legend card
  modelUnavailable?: boolean;              // all items in scope carry reason model_unavailable
}
```

| Variant | Content |
|---|---|
| `cell` | "97%" + "Very sure", meter with tick. The cell never adds "left for you" (the column is 108px); that hint appears in the inline variant. |
| `inline` | Baseline-aligned "97%" (`font-semibold text-ink`) + "Very sure" (band ink) + for Likely or Unsure: " · left for you" (`text-ink-3`). |
| `scale` | Card per band (4 columns, gap 8px, each `border border-line rounded-lg px-2.5 py-[9px] text-small`): 9px `rounded-[3px]` swatch (fill color) + band word (`font-semibold`), range line, membership line `text-ink-3`. |

Scale copy (tau = 0.86 example): "Very sure" / "95 to 100%" / "In Clean up"; "Sure" / "86 to 94%" / "In Clean up"; "Likely" / "70 to 85%" / "Left for you"; "Unsure" / "Below 70%" / "Left for you". Ranges are computed: Sure = `toPercent(tau)` to 94, Likely = 70 to `toPercent(tau) - 1`. When `tau >= 0.95`, the Sure card reads "None right now" / "Threshold is above 95%".

Model unavailable: percentage is replaced by "n/a", band word "Unsure", meter empty, and the inline variant adds " · model unavailable".

- **Accessibility:** rendered as text; the cell variant's accessible text is "97 percent, Very sure". Band word is never conveyed by color alone (it is a word).

### 4.13 ReasonLine

- **Purpose:** one plain-language reason behind a suggestion.
- **Anatomy:** flex row, gap 9px, align start, `text-body text-ink-2`. Icon box 18px `rounded-sm bg-surface-sunk text-ink-2` with a 12px SVG icon; text is `reason.text` from the API, verbatim.
- **Props:**

```ts
interface ReasonLineProps { reason: ApiReason }   // { code, text }
```

| Reason codes | Icon |
|---|---|
| `prior_sender_deleted`, `prior_sender_kept`, `prior_domain_deleted`, `prior_domain_kept` | history (counter-clockwise arrow) |
| `low_open_rate`, `old_unread` | eye-off |
| `list_unsubscribe`, `bulk_mail`, `auto_sent`, `category` | megaphone |
| `guard_starred` | star |
| `guard_replied`, `guard_correspondent`, `flag_human` | person |
| `guard_allowlist`, `deny_listed` | list |
| `guard_too_recent`, `flag_expired` | clock |
| `guard_attachment` | paperclip |
| `guard_record_pattern`, `flag_record` | receipt |
| `auth_failed` | alert triangle |
| `model_important` | flag |
| `model_unavailable` | spark with slash |
| `low_confidence` | question circle |

- **Accessibility:** icon `aria-hidden`; reasons are rendered as a `ul` with `li` items (`aria-label="Reasons"`).

### 4.14 DetailPanel

- **Purpose:** everything about the active sender group: verdict, confidence, reasons, latest emails, and the actions.
- **Anatomy:** `bg-surface-raised`, padding 16px, flex column, gap 12px, width 300px (inline, `xl`), 340px (slide-over, `lg`), full screen (sheet, below `lg`).
  1. **Header** (flex, gap 10px): `SenderAvatar` 30px; name (`text-title-sm font-semibold`), sub-line `text-small text-ink-3`: "promo@shopee.co.id · you@gmail.com". Slide-over and sheet add a ghost icon button "Close" (sheet: "Back") at the right.
  2. **Verdict card** (`bg-surface border border-line rounded-lg p-3`): top row (`justify-between`, margin-bottom 8px): `VerdictTag` with action label; `ConfidenceLabel variant="inline"`. Then a range line `text-small text-ink-3` when `max - min >= 0.05`: "Range 91–99% across 248 emails". Then a membership line `text-small text-ink-3`: see table. Then reasons (`ul`, gap 7px) from `group.topReasons`.
  3. **Label** "Latest emails" (`text-meta font-emphasis text-ink-3`).
  4. **EmailPreviewList.**
  5. **Actions** (flex wrap, gap 6px): see table.
  6. **Hints** (flex wrap, gap 10px, `text-meta text-ink-3`): Kbd J K "move", X "select", T "trash", A "archive", E "keep". Hidden below `lg`.

| Verdict | Verdict tag label | Primary action | Other actions (secondary) | Ghost |
|---|---|---|---|---|
| Trash (`delete`) | "Move 248 to Trash" | Danger "Trash 248" (trash icon) | "Archive", "Keep" | "Always keep Shopee", More menu |
| Archive | "Archive 42" | Primary "Archive 42" (archive icon) | "Trash" (trash icon), "Keep" | "Always keep Tokopedia Orders", More menu |
| Keep | "Keep 3 in inbox" | Primary "Keep 3" (keep icon) | "Archive", "Trash" (trash icon) | More menu |
| Check (`unsure`) | "Check 67 yourself" | none | "Trash" (trash icon), "Archive", "Keep" | "Always keep GitHub", More menu |

Membership line: Trash or Archive with `band` Sure or Very sure and `min >= tau`: "All 248 are in Clean up."; Trash or Archive with `min < tau <= max`: "Emails below 86% stay here for you after Clean up."; Trash or Archive with `max < tau`: "Below 86%, so Clean up leaves this group for you."; Keep: "Keep suggestions are not part of Clean up."; Check: "Clearbox needs your call on this group."

More menu items: "Always OK to trash Shopee" (deny list), "Always keep everything from @shopee.co.id" (allow list, domain), "Copy sender address". The "Always ..." items are hidden for an unknown sender.

Name in buttons: display name truncated to 24 characters with an ellipsis.

- **Props:**

```ts
interface DetailPanelProps {
  mode: "inline" | "slideover" | "sheet";
  open: boolean;                           // inline: always true when a group is active
  group: SenderGroup | null;
  detail: GroupDetail | null;              // GET /api/groups/:key?limit=20
  detailState: "loading" | "ready" | "error";
  tau: number;
  account: AccountView | null;
  busy: boolean;
  onAction: (action: ActionKind) => void;                      // T, A, E semantics (6.4)
  onAlwaysKeep: (entry: string) => void;                        // address or "@domain"
  onAlwaysTrash: (entry: string) => void;
  onItemAction: (itemId: number, action: ActionKind) => void;
  onLoadMoreItems: () => void;
  onClose: () => void;
  onRetry: () => void;
}
```

| State | Rendering |
|---|---|
| no group (list empty) | Panel hidden at `xl`; the list column spans the full width. |
| loading | Header from `group` (already known), verdict card from `group`, email list shows 3 skeleton lines, actions enabled (they do not need the detail). |
| ready | Full content. |
| error | Email list area: "Couldn't load these emails." + link button "Try again". Actions still enabled. |
| busy | Action buttons disabled; the clicked button shows a spinner and "Working…". |
| account needs reconnect | Warning line above actions (`text-small text-check-ink-strong`, warning icon): "Reconnect you@company.com to act on these emails." with link button "Reconnect". Actions disabled. |

- **Accessibility:** inline: `aside aria-labelledby` the sender heading (`h2`). Slide-over: `role="dialog" aria-modal="false" aria-labelledby`, focus moves to the heading on open, Esc closes and returns focus to the row. Sheet: `role="dialog" aria-modal="true"`, focus trapped, Back button first in tab order. Action buttons expose shortcuts with `aria-keyshortcuts` ("T", "A", "E").

### 4.15 EmailPreviewList

- **Purpose:** show the actual emails behind a group as plain text so the owner can trust the suggestion; per-email override.
- **Anatomy:** `bg-surface border border-line rounded-lg overflow-hidden`. Rows: flex `justify-between`, gap 10px, padding 7px 10px, `border-b border-line-subtle` (last none), `text-small text-ink-2`. Left: subject (single line ellipsis; "(no subject)" in `text-ink-3` when null or empty). Right: `shortAge` in `text-ink-3`. Unread emails show the subject in `font-emphasis text-ink`.
  - **Expanded row** (one at a time, toggled by click or Enter on the row): adds below the subject: snippet (`text-small text-ink-3`, up to 3 lines, `line-clamp-3`, `whitespace-pre-line`; when snippet is null: "Preview not stored (turned off in Rules)."), a meta line "Received Mon 13 Oct, 08:12 · 92% Sure" and per-email actions (size `sm`): "Trash", "Archive", "Keep", ghost link "Open in Gmail" with external icon (Outlook: "Open in Outlook"), opened with `target="_blank" rel="noopener noreferrer"` from `item.deepLink` (hidden when null).
  - **Footer row:** when more items exist: left "+ 245 more" (`text-ink-3`), right link button "Show 20 more". When all are loaded: no footer.
- **Props:**

```ts
interface EmailPreviewListProps {
  items: SuggestionItem[];
  total: number;                     // group.count
  provider: ProviderKind;
  expandedId: number | null;
  hasMore: boolean;
  loadingMore: boolean;
  tau: number;
  onToggleExpand: (id: number) => void;
  onItemAction: (id: number, action: ActionKind) => void;
  onLoadMore: () => void;
}
```

- **States:** row default, hover `bg-surface-hover`, focus-visible (outline offset -2px), expanded (`bg-surface-hover`), busy (item action in flight: row 60% opacity), removed (item executed: row collapses like SenderGroupRow exit).
- **Text safety:** subject and snippet are React text nodes. Snippets keep line breaks via CSS `white-space: pre-line` only; no HTML parsing, no linkification.
- **Accessibility:** `ul aria-label="Latest emails from Shopee"`; each row is a `button aria-expanded` controlling its expansion region. "Open in Gmail" has `aria-label="Open this email in Gmail (new tab)"`.

### 4.16 ConfirmBar

- **Purpose:** the inline, non-modal confirmation and progress surface for Clean up (and for "Confirm all keeps" in the Keep tab).
- **Anatomy:** `data-inverse`, `bg-inverse text-on-inverse rounded-xl shadow-bar`, padding 12px 14px 12px 18px, flex row, gap 14px, `position: sticky; bottom: 16px; z-(--z-confirm)`, margin-top 14px, placed directly after the work area so it sits at the bottom of the list viewport. Enter animation: 8px rise plus fade, `duration-slow ease-out`.
  - **Confirming:** spark glyph 14px; text block (`flex: 1`): title `font-semibold` and sub-line `text-small text-on-inverse-3`; ghost button on inverse "Cancel" + Kbd `Esc` (tone `on-inverse`); white button "Clean up" + Kbd `↵` (`bg-on-inverse text-ink`).
  - **Running:** text block: title "Cleaning up… 812 of 1,284" and a 4px `ProgressBar tone="on-inverse"` (margin-top 8px); right: `text-small text-on-inverse-3` "You can keep reviewing" and ghost "Stop".
  - **Partial or error:** title and sub-line with the outcome; buttons "Try again" (white) and ghost "Dismiss". Done and undo outcomes do not use the bar; they use toasts.
- **Props:**

```ts
type ConfirmBarMode = "cleanup" | "confirm_keeps";
interface ConfirmBarProps {
  mode: ConfirmBarMode;
  phase: "confirming" | "running" | "partial";
  title: string;                 // composed by copy helpers (5.2.4)
  detail: string;
  processed?: number;            // running
  total?: number;                // running
  platform: Platform;
  onConfirm: () => void;         // Enter
  onCancel: () => void;          // Esc (confirming), Dismiss (partial)
  onStop: () => void;            // running
  onRetry: () => void;           // partial
}
```

- **States:** confirming (focus on "Clean up" button); confirm button hover `bg-surface-sunk`; focus-visible on inverse: 2px `on-inverse` outline; running (no confirm button; Stop available); stopping (Stop shows spinner and "Stopping…"); partial.
- **Accessibility:** `role="region" aria-label="Clean up"`; confirming: `aria-describedby` the sub-line so screen readers read the exact counts when focus lands on the confirm button. Running: a visually hidden `aria-live="polite"` node announces "Clean up started", then at 25%, 50%, 75% ("Cleaning up, 50 percent done"), and the final outcome. Keyboard: Enter confirms only when focus is inside the bar or on the body; Esc cancels while confirming.

### 4.17 ProgressBar

- **Purpose:** determinate or indeterminate progress (Clean up run, account backlog, daily budget, first sort).
- **Anatomy:** track (`bg-track` light, `bg-inverse-track` on inverse) with height 4px or 6px, `rounded-xs`, overflow hidden; fill `cb-fill` with tone color; indeterminate: a 30% wide fill sliding left to right, 1.2s `ease-standard` infinite (reduced motion: static 30% fill at the left, label carries the information).
- **Props:**

```ts
interface ProgressBarProps {
  value: number | null;          // 0..1, null = indeterminate
  tone: "on-inverse" | "accent" | "archive" | "ink";
  height?: 4 | 6;
  label: string;                 // accessible name, for example "Daily writes used"
  valueText?: string;            // "21,080 of 90,000 (23%)"
  width?: "full" | 240;
}
```

- **Accessibility:** `role="progressbar" aria-label aria-valuemin=0 aria-valuemax=100 aria-valuenow` (omitted when indeterminate) `aria-valuetext`.

### 4.18 Toast (with Undo)

- **Purpose:** short-lived outcome messages; the place where Undo lives after every Trash or Archive action (Keep decisions are not undoable, see 5.2.6).
- **Anatomy:** `data-inverse`, `inline-flex items-center gap-3 bg-inverse text-on-inverse rounded-lg shadow-toast`, padding 9px 10px 9px 14px, `text-body`, max-width 560px. Leading icon 14px in `on-inverse` (success: check; info: info circle; error: alert triangle). Message. Action: underlined text button `font-semibold` (underline offset 2px), for Undo followed by Kbd "⌘ Z" (tone `on-inverse`). Close icon button (ghost on inverse, 20px) on error toasts and on hover for others.
- **Props:**

```ts
interface ToastInput {
  kind: "success" | "info" | "error";
  message: string;
  action?: { label: "Undo" | "Try again" | "Reconnect" | "View"; onAction: () => void; shortcut?: "mod+z" };
  durationMs?: number;           // default: success 8000, info 5000, error: persistent
  dedupeKey?: string;
}
interface ToastApi { show(t: ToastInput): string; update(id: string, t: Partial<ToastInput>): void; dismiss(id: string): void }
```

- **States:** entering (8px rise plus fade, `duration-slow ease-out`), visible, paused (hover or focus within: timer paused), action running ("Undoing…" with spinner, action hidden), exiting (fade plus 4px drop, `duration-base ease-in`).
- **Placement:** `ToastRegion` is fixed, bottom 24px (96px when a ConfirmBar is visible), horizontally centered within the main column, `z-(--z-toast)`, flex column gap 8px, newest at the bottom. Below 640px: left and right 16px, full width.
- **Accessibility:** `ToastRegion` is `role="region" aria-label="Notifications"`. Success and info toasts render inside an `aria-live="polite"` container; error toasts use `role="alert"`. Toasts never steal focus. The Undo button has `aria-keyshortcuts="Meta+Z"` (or `Control+Z`).
- **Copy:** see section 5 per action; generic error: "Something went wrong. Nothing was changed." Network error: "Couldn't reach Clearbox. Check your connection and try again."

### 4.19 Banner

- **Purpose:** persistent page-level conditions (reconnect, setup errors, budget, model unavailable, offline, unsaved changes).
- **Anatomy:** flex row, gap 12px, `rounded-lg border px-3 py-2.5 text-body`, tone colors from 2.1 (warning: `bg-check-soft border-check-line text-check-ink-strong`). Leading 16px icon (warning triangle, error octagon, info circle, success check). Text block (`flex: 1`): bold lead sentence (`font-semibold`) followed by detail text in the same paragraph. Actions: secondary button(s) size `sm` on the right; optional dismiss icon button.
- **Props:**

```ts
interface BannerProps {
  tone: "warning" | "error" | "info" | "success";
  title: string;                       // bold lead sentence, ends with a period
  body?: string;
  actions?: { label: string; onClick?: () => void; href?: string; external?: boolean }[];
  dismissible?: boolean;
  onDismiss?: () => void;
}
```

- **States:** static; action loading (spinner in the button); dismissed (removed, remembered in `sessionStorage` under `clearbox.banner.<id>` for the session).
- **Accessibility:** warning and error banners that appear after page load are announced once with `role="status"` (warning) or `role="alert"` (error); banners present at load are plain regions. Icons `aria-hidden`; the tone is stated by the title words, never color alone.

### 4.20 EmptyState

- **Purpose:** explain an empty list or a finished state and offer the next step.
- **Anatomy:** `panel` variant: `bg-surface border border-line rounded-xl p-[26px] text-center`; title `text-title font-semibold`; body `text-ink-3`, margin 4px 0 12px; one secondary button. `page` variant: same content without border, centered in the main area with 32px top padding, optional 32px icon in `text-ink-3`. `inline` variant (inside the list column): no border, padding 40px 16px.
- **Props:**

```ts
interface EmptyStateProps {
  variant: "panel" | "page" | "inline";
  title: string;
  body: string;
  action?: { label: string; onClick: () => void; variant?: "secondary" | "primary" };
  secondaryAction?: { label: string; onClick: () => void };
  icon?: IconName;
}
```

- **Accessibility:** title is an `h2` (or `h3` inside panels with their own heading). When an EmptyState replaces content after an action, focus moves to its action button.

### 4.21 Skeleton rows

- **Purpose:** loading placeholders that match final geometry exactly (no layout shift).
- **Anatomy:** `SkeletonLine` `h-2.5 rounded-xs bg-[linear-gradient(90deg,var(--color-surface-sunk),var(--color-skeleton-highlight),var(--color-surface-sunk))] bg-[length:200%_100%] animate-shimmer`. `SkeletonRow`: same grid and padding as SenderGroupRow: 15px square, 22px square plus two lines (140px and 220px, 70% of cell max), 64px x 18px tag, 80px line plus 4px bar, 24px line right aligned.
- **Props:**

```ts
interface SkeletonLineProps { width: number | `${number}%`; height?: 6 | 10 | 14 }
interface SkeletonRowsProps { count: number }
```

- **States:** shimmering; reduced motion: static.
- **Accessibility:** skeleton containers are `aria-hidden="true"`; the parent region has `aria-busy="true"` and a visually hidden "Loading sender groups" text.

### 4.22 Button

- **Purpose:** every clickable action.
- **Anatomy:** `inline-flex items-center gap-[7px] whitespace-nowrap rounded-md border font-emphasis`, optional leading 14px icon, label, optional trailing Kbd.

| Variant | Default | Hover | Active (pressed) | Notes |
|---|---|---|---|---|
| `primary` | `bg-primary text-on-primary border-primary shadow-button-primary` | `bg-primary-hover` | `translate-y-px` (motion-safe) | One per view region. Clean up, Save changes, Archive/Keep primary in detail. |
| `secondary` | `bg-surface text-ink border-line` | `bg-surface-hover border-neutral-fill` | `bg-surface-sunk` | Default button. |
| `danger` | `bg-trash text-white border-trash` | `bg-trash-hover border-trash-hover` | `translate-y-px` | Only for Trash as the suggested action and for Disconnect confirm. Always has the trash icon or the word "Disconnect"; never color alone. |
| `ghost` | `bg-transparent text-ink-2 border-transparent` | `bg-[rgba(22,23,27,.05)] text-ink` | `bg-[rgba(22,23,27,.08)]` | Tertiary actions, Cancel, Scan now. |
| `on-inverse` | `bg-white text-ink border-white` | `bg-surface-sunk` | | Inside ConfirmBar. |
| `on-inverse-ghost` | `bg-transparent text-on-inverse-2 border-transparent` | `text-on-inverse bg-[rgba(255,255,255,.08)]` | | Inside ConfirmBar and toasts. |

| Size | Height | Padding | Text | Radius | Icon |
|---|---|---|---|---|---|
| `sm` | 28px | 5px 10px | `text-small` | `md` | 12px |
| `md` (default) | 32px | 7px 12px | `text-body` | `md` | 14px |
| `lg` | 36px | 9px 15px | `text-base` | `lg` | 16px |

- **Props:**

```ts
interface ButtonProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "type"> {
  variant?: "primary" | "secondary" | "danger" | "ghost" | "on-inverse" | "on-inverse-ghost";
  size?: "sm" | "md" | "lg";
  icon?: IconName;
  kbd?: string[];               // ["⌘", "↵"]; rendered with Kbd
  loading?: boolean;            // spinner + loadingLabel, aria-busy, ignores clicks
  loadingLabel?: string;        // default "Working…"
  type?: "button" | "submit";   // default "button"
}
// LinkButton has the same visual API and renders a react-router Link (internal) or <a> (external, with rel="noopener noreferrer").
```

- **States:** focus-visible (2px `focus` outline, offset 2px; on inverse: `on-inverse`); disabled (`opacity-45`, `cursor-not-allowed`, `aria-disabled="true"` instead of the `disabled` attribute when the reason is shown nearby, so it stays focusable); loading (12px spinner, border 2px `line-control` with top `ink`, label "Working…" or `loadingLabel`).
- **Accessibility:** native `<button>`. Icon-only buttons (close, more, menu) need `aria-label` and are 28px square minimum (24px target size rule of WCAG 2.2 met).

### 4.23 Kbd

- **Purpose:** show keyboard shortcuts next to the actions they trigger.
- **Anatomy:** `font-mono text-micro text-ink-3 bg-surface border border-line border-b-2 rounded-xs px-[5px]`, one element per key, joined by a 3px gap ("⌘ ↵" is two keys).
- **Props:**

```ts
interface KbdProps { keys: string[]; tone?: "default" | "on-primary" | "on-inverse" }
```

| Tone | Style |
|---|---|
| `default` | as above |
| `on-primary` | `bg-[rgba(255,255,255,.12)] border-[rgba(255,255,255,.18)] text-[#D6D7DD]` |
| `on-inverse` | `bg-transparent border-inverse-line text-on-inverse-3` |

- **Platform labels:** mac: "⌘", "⌥", "⇧", "↵"; other: "Ctrl", "Alt", "Shift", "Enter". Letters uppercase ("T").
- **Accessibility:** `<kbd>` elements, `aria-hidden="true"` when inside a button that already has `aria-keyshortcuts`. Hidden below 640px.

### 4.24 Select (dropdown)

- **Purpose:** choose one value (account filter, sort, minimum age).
- **Decision:** a styled native `<select>` (accessible and keyboard-complete for free). The chevron is an inline SVG sibling positioned over the right padding (`pointer-events: none`), not a CSS background.
- **Anatomy:** `appearance-none bg-surface border border-line rounded-md pl-2.5 pr-7 py-[5px] text-body text-ink-2`, height 30px. Borderless variant (`ghost`) for "Sort: Confidence": no border, transparent background, `text-small text-ink-3`, the visible prefix "Sort:" is part of each option label.
- **Props:**

```ts
interface SelectOption<V extends string> { value: V; label: string }
interface SelectProps<V extends string> {
  label: string;                  // accessible name, visually hidden unless showLabel
  showLabel?: boolean;
  value: V;
  options: SelectOption<V>[];
  onChange: (value: V) => void;
  variant?: "default" | "ghost";
  disabled?: boolean;
}
```

- **States:** hover `border-neutral-fill` (ghost: `text-ink-2`), focus-visible outline, disabled 45% opacity.
- **Copy:** account filter options "All accounts" then each email; sort options "Sort: Confidence", "Sort: Most emails", "Sort: Newest"; minimum age options "Off", "1 day", "2 days", "3 days", "5 days", "7 days", "14 days", "30 days".

### 4.25 Menu

- **Purpose:** action lists behind a button (user menu, detail More menu, account card overflow below 1024px).
- **Anatomy:** popover `bg-surface border border-line rounded-lg shadow-overlay p-1 min-w-[200px] z-(--z-popover)`; items 30px high, padding 6px 8px, `rounded-sm text-body text-ink-2`, optional 14px icon; hover and keyboard-active `bg-surface-hover text-ink`; destructive items use `text-trash-ink` and an icon.
- **Props:**

```ts
interface MenuItem { id: string; label: string; icon?: IconName; destructive?: boolean; disabled?: boolean; onSelect: () => void }
interface MenuProps { trigger: React.ReactElement; label: string; items: MenuItem[]; align?: "start" | "end" }
```

- **Accessibility:** WAI-ARIA menu button: trigger `aria-haspopup="menu" aria-expanded`, list `role="menu"`, items `role="menuitem"`, arrow keys, Home and End, type-ahead, Esc closes and returns focus. Opens with 4px drop and fade (`duration-base`).

### 4.26 Tabs

- **Purpose:** generic underline tabs (ActionTabs uses it; Insights uses none in v1). Spec as in 4.6: `role="tablist"`, automatic activation, arrow keys.

```ts
interface TabsProps<K extends string> {
  label: string;
  value: K;
  items: { key: K; label: string; count?: number | null }[];
  onChange: (key: K) => void;
  controls: string;              // id of the tab panel
}
```

### 4.27 Chip (removable) and ChipInput

- **Purpose:** list entries in Rules (senders, domains, record words).
- **Chip anatomy:** `inline-flex items-center gap-1.5 border border-line rounded-full bg-surface pl-2.5 pr-1.5 py-[3px] text-small text-ink-2`. Remove button: 16px circle `bg-surface-sunk text-ink-3`, "×" glyph as SVG; hover `bg-line text-ink`.
- **ChipInput anatomy:** the chips wrap (gap 6px) followed by a `TextInput` (size `sm`, `rounded-full`, width 200px, placeholder "Add sender or @domain"). Enter or comma adds; Backspace on an empty input focuses the last chip's remove button.
- **Props:**

```ts
interface ChipProps { label: string; onRemove?: () => void; removeLabel: string; note?: string }
interface ChipInputProps {
  label: string;                             // "Always keep these senders"
  values: string[];
  placeholder: string;
  validate: (raw: string) => { ok: true; value: string } | { ok: false; error: string };
  onAdd: (value: string) => void;
  onRemove: (value: string) => void;
  max: number;                               // 1000 for sender lists, 100 for record words
}
```

- **States:** chip default, hover, remove focus-visible (outline), just added (fade in `duration-base`), moved (when an entry moves from the other list, the chip shows `note` "Moved from Always OK to trash" in `text-ink-3` for 4 s). Input error: border `trash-ink`, error text below `text-small text-trash-ink` with an alert icon.
- **Accessibility:** chips are `li` in a `ul aria-label`; remove buttons `aria-label="Remove @bank.co.id from Always keep"`. Input has a visible group label (the field title) via `aria-labelledby` and `aria-describedby` for errors and helper text. Validation messages: "Use name@domain.com or @domain.com.", "This entry is already in the list.", "Lists hold up to 1,000 entries.", record words: "Use 2 to 40 characters.".

### 4.28 TextInput

- **Anatomy:** `bg-surface border border-line-control rounded-md px-2.5 py-[7px] text-body text-ink placeholder:text-ink-3`, height 32px (sm: 26px, padding 3px 10px).
- **Props:**

```ts
interface TextInputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label: string;
  hideLabel?: boolean;
  helper?: string;
  error?: string | null;
  size?: "sm" | "md";
}
```

- **States:** default, hover (`border-ink-3`), focus-visible (outline 2px `focus`, border `focus`), disabled (`bg-surface-sunk`, 45% text opacity), error (border `trash-ink`, `aria-invalid="true"`), read-only.

### 4.29 Toggle

- **Anatomy:** 30px x 18px track `rounded-full`; knob 14px white circle, 2px inset. On: track `ink`, knob right. Off: track `line-control`, knob left. Knob moves `duration-fast ease-out` (reduced motion: instant).
- **Props:**

```ts
interface ToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;            // field title, used as accessible name
  description?: string;
  locked?: boolean;         // always-on guardrails: rendered on, not changeable
}
```

- **States:** hover (track 90% opacity), focus-visible (outline offset 2px), disabled and locked (on, 45% opacity, lock icon 12px left of the toggle, `aria-disabled="true"`, description ends with "Always on.").
- **Accessibility:** `<button role="switch" aria-checked>`; the whole field row label is associated via `aria-labelledby`, description via `aria-describedby`. Space and Enter toggle.

### 4.30 Table

- **Anatomy:** `table w-full border-collapse text-body`. `th`: left aligned, `font-medium text-meta text-ink-3`, padding 8px 16px, `border-b border-line`, `bg-surface` (no tint). `td`: padding 10px 16px, `border-b border-line-subtle text-ink-2`; strong cell text `font-emphasis text-ink`. Last row has no bottom border. Numeric columns right aligned only when they are pure numbers (Pending), otherwise left (mockup "Backlog" text).
- **Props:**

```ts
interface Column<Row> { key: string; header: string; align?: "left" | "right"; width?: string; render: (row: Row) => React.ReactNode }
interface TableProps<Row> {
  caption: string;                 // visually hidden
  columns: Column<Row>[];
  rows: Row[];
  rowKey: (row: Row) => string | number;
  state: "loading" | "ready" | "empty" | "error";
  emptyText: string;
  onRetry?: () => void;
  footer?: React.ReactNode;        // "Load more"
}
```

- **States:** loading (5 skeleton rows), empty (single row spanning all columns with `emptyText` in `text-ink-3`, centered, padding 24px), error (single row "Couldn't load this table." + "Try again" link button), row hover (`bg-surface-hover`) only when rows have actions.
- **Accessibility:** native table semantics, `caption` visually hidden, `scope="col"` on headers. Below 640px the table scrolls horizontally inside a `div tabIndex=0 role="region" aria-label={caption}`.

### 4.31 Chart (weekly bars)

- **Purpose:** emails cleaned per week (6 weeks, current week last).
- **Anatomy:** flex row `items-end gap-1.5 h-[120px] px-4 pt-3.5 pb-1.5`. Each bar `flex-1 rounded-t-[4px] rounded-b-[2px]`, height `cb-bar-height` from `--cb-value` (`week.cleaned / max`). Past weeks `bg-accent-bar`; current week `bg-accent`. Under the bars: week labels row (`text-meta text-ink-3`, "8 Sep", ..., "This week"). Below: summary line `text-small text-ink-3 px-4 pb-3`: "This week: 1,284 cleaned, 18 undone".
- **Props:**

```ts
interface WeeklyChartProps {
  weeks: { weekStart: string; cleaned: number; undone: number }[];   // contract addition A3
  state: "loading" | "ready" | "empty";
}
```

- **States:** loading (6 skeleton bars of 30 to 90% height), empty (all zero: bars at 2px minimum height and the line "No Clean ups yet. Your first one will show up here."), hover or focus on a bar: a small label above it "1,284 cleaned · 18 undone" (`bg-inverse text-on-inverse text-meta rounded-sm px-1.5 py-0.5`).
- **Accessibility:** the chart `div` is `role="img" aria-label="Emails cleaned per week: 8 Sep 420, 15 Sep 730, ..., this week 1,284"`; each bar is also focusable (`tabIndex=0`, `aria-label` with its values) so keyboard users get the hover label. A visually hidden table with the same data follows the chart.

### 4.32 Checkbox

- **Anatomy:** 15px square `rounded-xs border-[1.5px] border-line-control bg-surface`. Checked: `bg-ink border-ink`, white check mark (SVG, 2px stroke). Mixed: `bg-ink`, white 8px horizontal bar.
- **Props:**

```ts
interface CheckboxProps {
  checked: boolean | "mixed";
  onChange: (next: boolean, e: React.MouseEvent | React.KeyboardEvent) => void;
  label: string;               // accessible name: "Select Shopee", "Select all groups in Trash"
  tabIndex?: 0 | -1;           // -1 inside grid rows (the row owns focus)
  disabled?: boolean;
}
```

- **States:** hover (`border-ink-3`), focus-visible (outline offset 2px), checked, mixed, disabled (45% opacity). Click target is the full 22px grid cell.
- **Accessibility:** native `<input type="checkbox">` visually replaced (the input is kept, `appearance: none`, styled directly), `aria-checked="mixed"` via the `indeterminate` property.

### 4.33 Supporting primitives

| Component | Spec |
|---|---|
| `Icon` | Inline SVG set in `components/ui/icons.tsx`, 16px viewBox, stroke 1.5, `currentColor`, `aria-hidden` by default. Names: `review`, `activity`, `insights`, `rules`, `plus`, `trash`, `archive`, `keep`, `check-question`, `shield`, `spark`, `spark-off`, `close`, `chevron-down`, `external`, `refresh`, `pause`, `play`, `more`, `menu`, `arrow-left`, `info`, `warning`, `error`, `success`, `history`, `eye-off`, `megaphone`, `star`, `person`, `list`, `clock`, `paperclip`, `receipt`, `alert`, `flag`, `question`, `lock`, `copy`. No icon font, no external sprite. |
| `Spark` | 14px or 22px four-point star, SVG `linearGradient` from `spark-from` to `spark-to` (gradient ids made unique with `useId`). |
| `StatusDot` | 7px circle, color by `AccountUiStatus`, `aria-hidden`. |
| `ProviderTile` | 34px square `rounded-lg`, white `font-heavy` letter "G" (Gmail) or "O" (Outlook), bg `provider-gmail`, `provider-outlook`, or `provider-off` when the account is not up to date and not catching up. `aria-hidden`. |
| `Dialog` | Native `<dialog>` opened with `showModal()`, `bg-surface rounded-xl shadow-overlay p-5 w-[520px] max-w-[calc(100vw-32px)]`, backdrop `rgba(16,17,22,.32)`, title `h2 text-title`, close icon button. Used only for the shortcut help sheet. |
| `VisuallyHidden` | `sr-only` span. |
| `LiveAnnouncer` | Single app-wide polite live region (`aria-live="polite"`, `aria-atomic="true"`) with `announce(text)`; clears after 1 s so repeats are re-announced. |

---

## 5. Screens

Each screen lists purpose, layout, hierarchy, data needed (contract routes and fields), every state, interactions, and final copy. "A1" to "A7" refer to the contract additions in section 9.3.

### 5.1 Review (home, `/review`)

**Purpose:** the weekly session. The AI has already sorted everything; the owner reads one summary, presses Clean up, then skims what is left for them.

**Layout (>= 1280px):** sidebar 208px | main (padding 18px 22px 22px):

1. PageHeader: "Review", meta "Sorted 4 min ago", right: account Select (width 160px), ghost "Scan now" (refresh icon).
2. App banners (0 to 3).
3. SummaryCard (full width).
4. ActionTabs (full width, attached to the work area below).
5. Work area: list (fluid, min 560px) | DetailPanel 300px. Height: natural; the page scrolls, the list header row and the detail panel are sticky (`top: 0` within main; the detail panel uses `position: sticky; top: 0; max-height: 100dvh; overflow-y: auto`).
6. ConfirmBar (only during the Clean up flow), sticky bottom 16px.

At 1024 to 1279px the detail panel is a slide-over (2.8). Below 1024px see 2.8.

**Content hierarchy:** summary headline and Clean up button, then tabs with counts, then rows (sender name, verdict, confidence, count), then detail (reasons, emails, actions).

**Data needed:**

| Route | Query key | Fields used |
|---|---|---|
| `GET /api/me` | `["me"]` | `email`, `tauDelete` (fallback only), `issues`, `providers`, `freeTier`, `serverTime` |
| `GET /api/accounts` | `["accounts"]` | `accounts[].id`, `provider`, `email`, `status`, `statusReason`, `paused`, `archiveSupported`, `sync.phase`, `sync.backfillDone`, `sync.lastTickAt`, `sync.awaitingModelCount`, `sync.backoffUntil`, `sync.lastErrorCode` |
| `GET /api/queue/summary?accountId=` | `["queue", "summary", { accountId }]` | `asOf`, `pending.total`, `pending.delete/archive/keep/unsure`, `awaitingModel`, `groups`, `tauDelete`, A1 `groupsByAction` |
| `GET /api/cleanup/preview?actions=delete,archive&accountId=` | `["cleanup", "preview", { accountId }]` | `asOf`, `threshold`, `defaultThreshold`, `count`, `byAction.delete`, `byAction.archive`, `groups`, A2 `groupsLeft` |
| `GET /api/groups?accountId=&action=&sort=&limit=50&cursor=` | `["groups", { accountId, action, sort }]` (infinite) | `items[]` (all `SenderGroup` fields, A6 `latestSubject`), `nextCursor` |
| `GET /api/groups/:key?limit=20&cursor=` | `["group", key]` (infinite) | `asOf`, `group`, `items.items[]` (`id`, `action`, `confidence`, `reasons`, `from`, `subject`, `snippet`, `receivedAt`, `isRead`, `deepLink`, `ceilingApplied`, `status`), `items.nextCursor` |

Tau used everywhere on this page: `preview.threshold` (falls back to `summary.tauDelete`, then `me.tauDelete`). Never a constant.

"Sorted N ago": the newest `sync.lastTickAt` among in-scope accounts with status `active`; "Not sorted yet" when all are null.

**States:**

| State | Condition | Rendering |
|---|---|---|
| Loading | first load of summary, preview or groups | SummaryCard `loading`, tabs without counts, 8 skeleton rows, detail panel skeleton (avatar, 2 lines, card, 3 lines). |
| Ready | data present, `preview.count > 0` | As designed. First row active by default (`group` search param wins when present and found). |
| Nothing sure | `preview.count === 0`, `summary.pending.total > 0` | SummaryCard `nothing_sure`; list as usual. |
| Inbox cleared (after a Clean up) | Clean up finished, `preview.count === 0`, groups remain | SummaryCard is replaced by EmptyState `panel`: "Inbox cleared" / "41 groups are waiting for your call. New mail gets sorted every 30 minutes." / secondary "Review the 41 groups" (switches to the All tab and focuses the first row). Shown until the next preview refetch returns `count > 0`. |
| All caught up | `summary.pending.total === 0`, accounts exist, no account in backfill | Summary, tabs and work area are replaced by EmptyState `page`: "All caught up" / "Nothing needs your attention. New mail gets sorted every 30 minutes." / secondary "Scan now". |
| First sort | `pending.total === 0` and any in-scope account has `sync.backfillDone === false` | EmptyState `page`: "Sorting your mailbox" / "Clearbox reads your newest emails first. Your first suggestions appear within a few minutes." + ProgressBar (determinate with A4, else indeterminate, label "Sorting progress") + meta "32,118 emails sorted so far". Rev 2.4: while a scan history window applies (`sync.scanHistoryDays !== null`) the ProgressBar is indeterminate and the meta reads "Scanning the last 90 days · 32,118 emails sorted so far" ("the last 30 days", "the last year"). |
| Catching up | some groups exist and an in-scope account is backfilling | Ready layout; header meta "Sorted 1 min ago · catching up"; summary sub-line appends " Still sorting older mail." |
| Partial | summary or preview failed but groups loaded (or the reverse) | Failed region shows its own error state (SummaryCard `error` or list `error`); the rest works. |
| Error | all three queries failed | EmptyState `page`: "Couldn't load Review" / "Check your connection, then try again." / secondary "Try again". |
| Needs reauth | any in-scope account `needs_reauth` | Warning banner per account (max 2, then "and 1 more account"): title "you@company.com needs to reconnect.", body "Google ended the session (password change or 6 months unused). Sorting is paused for this account." (Outlook: "Microsoft ended the session. Sorting is paused for this account."), action "Reconnect". Its groups stay listed; detail panel shows the reconnect warning (4.14). |
| Setup error | any account `config_error`, or issue `google_client_invalid` / `microsoft_client_invalid` | Error banner: "Google sign-in is misconfigured." body "Google rejected the client ID or secret. Update GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET, redeploy, then reconnect." action "Open setup guide" (external link to the repository's `docs/setup-google.md`). Outlook variant: "Microsoft sign-in is misconfigured." / "Microsoft rejected the client secret (it may have expired). Create a new secret, update MS_CLIENT_SECRET, redeploy, then reconnect." / `docs/setup-microsoft.md`. |
| Budget exhausted | issue `budget_exhausted_today` | Warning banner (dismissible): "Today's free-tier limit is reached." body "New mail is sorted again after 07:00. Clean up and other actions keep working until the action limit is reached." |
| Storage near limit | issue `storage_near_limit` | Warning banner (dismissible): "Storage is almost full." body "Clearbox paused reading older mail at 450 MB of 500 MB. Old data is removed nightly, then sorting resumes." |
| Model not configured | issue `decision_not_configured`, `decision_auth_failed` or `decision_deployment_not_found` | Error banner: "Clearbox can't use the AI model." body per code: not configured "AZURE_DECISION_ENDPOINT, AZURE_DECISION_KEY or AZURE_DECISION_DEPLOYMENT is missing or invalid. The endpoint must be an https URL and the deployment name cannot be Microsoft-Decision-1." (the server rejects an `http://` endpoint, one with a path, query or credentials, and the reserved deployment name; it clears as soon as the configuration is valid); auth failed "Azure rejected the API key. Update AZURE_DECISION_KEY and redeploy. This clears after the next successful sort."; deployment not found "The deployment name was not found. Check AZURE_DECISION_DEPLOYMENT. This clears after the next successful sort." (these two clear only after a successful decision, so on a quiet account the banner can outlast the fix; the sentence says so). Then: " New emails are marked Check until this is fixed." Action "Open setup guide" (`docs/setup-azure.md`). |
| Model temporarily unavailable (many Unsure) | `summary.awaitingModel > 0`, or more than 50% of loaded groups are Check with top reason `model_unavailable` | Info banner: "The AI model is not responding right now." body "25 emails are waiting and Clearbox retries automatically. Emails it could not score are marked Check with the reason \"Model unavailable\"." Check rows with `model_unavailable` show confidence "n/a" (4.12). |
| Offline | browser offline or network errors | See 5.9. Clean up and actions disabled. |

**Interactions:**

| Trigger | Result |
|---|---|
| Account Select change | Sets `account` search param; refetches summary, preview, groups; clears selection; Clean up scope follows the filter. |
| Scan now | For the selected account, or each `active` unpaused account in sequence: `POST /api/accounts/:id/scan`. Button loading "Scanning…". Success toast (info): "Scan finished. 25 new emails sorted." (sum of `decided + unsure`); an `idle` report or 0 sorted: "Scan finished. No new emails." A `200` `TickReport` with `outcome: "error"` (the tick failed and Clearbox backs off): error toast "Scan hit a problem. Clearbox will retry automatically." and that account does not count as finished. Then invalidate accounts, summary, preview. `409 account_busy`: info toast "A scan is already running for you@gmail.com. Try again in 2 min." (`retryAt`); `409 account_inactive` has two shapes: with `retryAt` the account is backing off after an error and the info toast reads "you@gmail.com is retrying after a problem. Next try at 14:05." (local `HH:MM` of `retryAt`, shown in "All accounts" mode too); without `retryAt` the account is paused or needs attention: skip silently in "All accounts" mode, toast "you@gmail.com is paused." in single mode; `429 budget_exhausted`: toast "Today's free-tier limit is reached. Scanning resumes after 07:00." |
| Click Clean up, or `mod+Enter` | Clean up flow (5.2). |
| Tab click or 1 to 5 | Switch tab (search param `tab`); clears selection; first row becomes active. |
| Row click | Activate (detail shows it). Shift+click: range select. `mod`+click: toggle select. |
| Checkbox click | Toggle select (shift: range). |
| T / A / E (or detail buttons) | Group action (6.4) on the selection, else on the active group. |
| Enter | Open detail (slide-over or sheet below 1280px; focus into the inline panel at `xl`). |
| "Always keep Shopee" | `PATCH /api/policy/senders { entry: sender, list: "allow" }`, then group action Keep (6.4). Toast: "Shopee is on your Always keep list. 248 emails kept." No Undo promise: a Keep changes nothing in the mailbox, and the sender stays on the Always keep list until removed in Rules (see the Undo and keeps rule in 5.2.6). |
| More > "Always OK to trash Shopee" | `PATCH ... list: "deny"`. Toast (info): "Shopee is on your Always OK to trash list. Future emails from it skip the confidence check." No Undo (rule changes are edited in Rules). |
| More > "Always keep everything from @shopee.co.id" | `PATCH ... { entry: "@shopee.co.id", list: "allow" }`, then Keep for the group. Toast as above with the domain. |
| More > "Copy sender address" | Clipboard write; toast (info) "Copied promo@shopee.co.id." |
| Email row click | Expand (snippet, meta, per-email actions). |
| Per-email Trash / Archive / Keep | If equal to the item's suggested action and not `unsure`: `POST /api/approve { ids: [id] }`, else `POST /api/override { ids: [id], action }`. Row exits; group count decrements. Toast: "Moved 1 email to Trash." / "Archived 1 email." with Undo; "Kept 1 email." without Undo (5.2.6). |
| New suggestions pill | Refetch groups, reset the snapshot (6.6). |

**Toast copy for group actions** (name = display name):

| Action | Success toast |
|---|---|
| Trash | "Moved 248 emails from Shopee to Trash." + Undo |
| Archive | "Archived 42 emails from Tokopedia Orders." + Undo |
| Keep | "Kept 3 emails from Mom. Clearbox will remember." (no Undo, 5.2.6) |
| Bulk (selection) | "Moved 455 emails from 3 sender groups to Trash." / "Archived 120 emails from 4 sender groups." + Undo; "Kept 30 emails from 2 sender groups." (no Undo, 5.2.6); Approve suggestions: "Done: 300 to Trash, 120 archived, 35 kept." + Undo, which restores the Trash and Archive part only |
| Partial | "Moved 240 of 248 emails to Trash. 8 could not be moved and stay in Review." + Undo |
| Account inactive | error: "Reconnect you@company.com to act on its emails." + action "Reconnect" |
| Rate limited | error: "Gmail asked Clearbox to slow down. Nothing else was changed. Try again in a minute." (Outlook: "Outlook asked ...") |
| Budget | error: "Today's free-tier limit for changes is reached. Try again after 07:00." |

### 5.2 Clean up flow (no modal)

**Purpose:** the one big moment: execute every confident Trash and Archive suggestion in one go, with exact counts before, live progress during, and Undo after.

#### 5.2.1 Scope (decided)

- Clean up executes pending suggestions with action **Trash or Archive** and confidence **at or above tau**, within the account filter, created at or before the preview's `asOf`. The UI always sends `actions: ["delete", "archive"]`.
- **Keep suggestions are not part of Clean up** (they need no mailbox change; the mockup's legend groups them with "check or keep"). The Keep tab offers "Confirm all keeps" instead (5.2.6).
- The active tab and the row selection do not change the scope. Selection has its own bulk actions (6.3).
- The threshold sent is the `threshold` returned by the preview the owner confirmed, so a nightly tau change during a run cannot change what was confirmed.

#### 5.2.2 State machine

```ts
type CleanupPhase =
  | { phase: "idle" }
  | { phase: "preparing" }                                                     // fetching a fresh preview
  | { phase: "confirming"; preview: CleanupPreview; groupsLeft: number | null }
  | { phase: "running"; preview: CleanupPreview; run: RunTotals; stopRequested: boolean }
  | { phase: "done"; preview: CleanupPreview; run: RunTotals }
  | { phase: "partial"; preview: CleanupPreview; run: RunTotals; reason: PartialReason }
  | { phase: "undoing"; run: RunTotals }
  | { phase: "undone"; restored: number; failed: number }
  | { phase: "error"; code: "network" | ApiErrorCode };                       // preview could not be loaded

interface RunTotals {
  calls: number;
  executed: number; failed: number; skipped: number;
  lastRemaining: number;
  lastRetryLater: number;
  failedCodes: Partial<Record<ItemErrorCode, number>>;
  batchIds: number[];                 // every non-null ActionResponse.batchId, in order
  total: number;                      // max(preview.count, processed + lastRemaining)
}
type PartialReason = "stopped" | "budget" | "rate_limited" | "account_inactive" | "no_progress" | "network" | "item_failures" | "unexpected";
```

The machine lives in `CleanupProvider` (mounted in AppShell) so a run continues while the owner navigates to other pages. Only one run exists at a time.

| From | Event | Guard | API call | To | UI |
|---|---|---|---|---|---|
| idle | Clean up click or `mod+Enter` on Review | `preview.count > 0`, online | `GET /api/cleanup/preview?actions=delete,archive[&accountId]` (fresh, bypasses cache) | preparing | Button "Preparing…" |
| preparing | preview ok, `count > 0` | | none | confirming | ConfirmBar enters; focus on "Clean up" |
| preparing | preview ok, `count === 0` | | none | idle | Info toast "Nothing left to clean up. New suggestions appear after the next sort." Invalidate summary and groups. |
| preparing | preview fails | | none | error | Error toast "Couldn't prepare Clean up. Nothing was changed." + "Try again" (re-enters preparing). Returns to idle after the toast. |
| confirming | Esc or Cancel | | none | idle | Bar exits; focus returns to the summary button |
| confirming | Enter or "Clean up" | online | first `POST /api/cleanup` | running | Bar switches to progress; LiveAnnouncer "Clean up started" |
| running | response ok | `remaining > 0` and progress made and `calls < maxCalls` and not `stopRequested` | next `POST /api/cleanup` (same body) | running | Progress updates |
| running | response ok | `remaining === 0` and `failed === 0` | none | done | Bar exits; success toast with Undo |
| running | response ok | `remaining === 0` and `failed > 0` | none | partial (`item_failures`) | Partial bar |
| running | response ok | progress made is 0 (only `retry_later` or nothing) or `calls >= maxCalls` | none | partial (`no_progress`, or `account_inactive` / `rate_limited` when those dominate `failedCodes` or the last `retryLater` items) | Partial bar |
| running | Stop clicked | | none (in-flight call completes) | partial (`stopped`) after the in-flight call | Stop shows "Stopping…" |
| running | `429 budget_exhausted` | | none | partial (`budget`) | Partial bar |
| running | `429 rate_limited` | | none | partial (`rate_limited`) | Partial bar |
| running | network error or 5xx | first failure for this call | retry the same body once after 2 s (the server is idempotent) | running | none |
| running | network error or 5xx | second failure | none | partial (`network`) | Partial bar |
| running | `400` or any other error | | none | partial (`unexpected`) | Partial bar; the error is logged to the console as a bug |
| done, partial | Undo (toast button or `mod+Z`) | within 24 h, `batchIds` not empty | `POST /api/batches/:id/undo` for each `batchIds`, newest first, sequentially | undoing | Toast becomes "Undoing…" |
| partial | "Try again" | | back to preparing (fresh preview, new confirm) | preparing | |
| partial | "Dismiss" | | invalidate the same caches as below | idle | Bar exits. Undo stays available in the toast and the undo stack |
| undoing | all undo calls settled | | none | undone | Toast "Restored 1,284 emails to your inbox." (partial: "Restored 1,280 emails. 4 could not be restored and are still in Trash or Archive."; when a whole undo call failed the failed count is unknown: "Restored 1,280 emails. Some could not be restored and are still in Trash or Archive."; nothing restored and nothing failed: info toast "Nothing needed restoring. These emails were already back or untouched.") |
| done, undone, error | timer 0 ms after the toast is shown | | invalidate `queue`, `cleanup`, `groups`, `group`, `accounts`, `batches`, `activity` | idle | List and summary refresh; empty states apply |

Definitions: `processed = executed + failed + skipped`; "progress made" in a call = `executed + failed + skipped > 0` for that response; `maxCalls = ceil(preview.count / 100) + 5`.

#### 5.2.3 The loop (server caps each call at 100 and returns `remaining`)

```ts
async function runCleanup(preview: CleanupPreview, accountId: string | undefined, signal: { stop: boolean }): Promise<RunOutcome> {
  const body: CleanupBody = { threshold: preview.threshold, actions: ["delete", "archive"], asOf: preview.asOf, ...(accountId ? { accountId } : {}) };
  const run = emptyTotals(preview.count);
  const maxCalls = Math.ceil(preview.count / 100) + 5;
  while (true) {
    if (signal.stop) return { phase: "partial", reason: "stopped", run };
    const res = await postWithOneRetry("/api/cleanup", body);           // 2 s delay before the single retry on network/5xx
    if (!res.ok) return { phase: "partial", reason: mapError(res.error), run };   // budget_exhausted, rate_limited, network, unexpected
    accumulate(run, res.data);                                           // sums, batchIds, failedCodes, lastRemaining, total
    const progressed = res.data.executed + res.data.failed + res.data.skipped > 0;
    if (res.data.remaining === 0) return run.failed > 0 ? { phase: "partial", reason: "item_failures", run } : { phase: "done", run };
    if (!progressed || run.calls >= maxCalls) return { phase: "partial", reason: dominantReason(run), run };
  }
}
```

During the run the list is not refetched (no jumping rows); the owner can keep reviewing and acting on groups (the server skips anything no longer pending). Progress text uses `processed` of `total`.

#### 5.2.4 Copy

| Moment | Title | Detail line |
|---|---|---|
| Confirming (all accounts) | "Clean up 1,284 emails in 371 sender groups?" | "1,102 go to Trash and 182 to Archive. Nothing is permanently deleted. 41 groups below 86% stay here for you." |
| Confirming, only Trash | "Clean up 1,102 emails in 312 sender groups?" | "All 1,102 go to Trash. Nothing is permanently deleted. 41 groups below 86% stay here for you." |
| Confirming, only Archive | "Clean up 182 emails in 59 sender groups?" | "All 182 go to Archive. 41 groups below 86% stay here for you." |
| Confirming, account filter | "Clean up 640 emails from you@gmail.com?" | same detail rules |
| Confirming, `groupsLeft === 0` | (unchanged) | last sentence omitted |
| Confirming, A2 missing | (unchanged) | last sentence: "240 emails below 86% or waiting for your choice stay here." |
| Confirming, an in-scope account is not active (`needs_reauth` or `config_error`) | (unchanged) | appended: " Emails from you@company.com are skipped until you reconnect it." The preview and the run exclude that account's Trash and Archive items; its groups count as "left for you". ("Confirm all keeps" has no such line: it covers every visible account.) |
| Running | "Cleaning up… 812 of 1,284" | right side: "You can keep reviewing" |
| Stopping | "Stopping after this step…" | |
| Done toast | "1,284 emails cleaned up from 371 sender groups" (success icon) | Undo + Kbd "⌘ Z"; when `skipped > 0` append " (4 were already handled)". The numbers are what the run executed, not the preview. |
| Done, nothing executed | "Nothing needed cleaning up (4 were already handled)" (the parenthesis only when `skipped > 0`; no period) | no Undo when no batch was created |
| Partial: stopped | "Clean up stopped. 812 emails were cleaned up." | "The rest stay in Review." Buttons "Try again", "Dismiss"; plus toast with Undo for the 812 |
| Partial: budget | "Clean up paused at today's free-tier limit. 1,180 emails were cleaned up." | "The other 104 stay in Review. Actions work again after 07:00." |
| Partial: rate limited | "Gmail asked Clearbox to slow down. 1,180 emails were cleaned up." | "The other 104 stay in Review. Try again in a minute." |
| Partial: account inactive | "1,180 emails were cleaned up. 104 were skipped." | "you@company.com needs to reconnect before its emails can be moved." + button "Reconnect" |
| Partial: item failures | "1,280 emails were cleaned up. 4 could not be moved." | "They were moved or deleted outside Clearbox, or the mailbox refused the change. They are marked as failed." |
| Partial: no progress | "1,180 emails were cleaned up. 104 are still waiting." | "The mailbox did not accept more changes right now. Try again in a few minutes." |
| Partial: network | "Connection lost during Clean up. 812 emails were cleaned up." | "The rest stay in Review. Try again when you're back online." |
| Partial: unexpected | "Clean up stopped because of an unexpected error. 812 emails were cleaned up." | "The rest stay in Review. Try again; if it keeps happening, check the Worker logs." |
| Undo running | toast "Undoing…" | |
| Undo done | toast "Restored 1,284 emails to your inbox." | |
| Undo partial | toast "Restored 1,280 emails. 4 could not be restored and are still in Trash or Archive." (count unknown: "Restored 1,280 emails. Some could not be restored and are still in Trash or Archive.") | The entry is consumed: there is no in-app retry (the server keeps a partly restored batch with retryable failures undone) |
| Undo, nothing to restore | info toast "Nothing needed restoring. These emails were already back or untouched." | mixed, Trash or Archive batches whose items were already back (keep-only batches show no Undo) |
| Undo expired (410) | error toast "Undo is no longer available for this Clean up (24 hours passed)." | |

Numbers: titles use the fresh preview (`count`, `groups`); "groups below 86%" uses A2 `groupsLeft` and `toPercent(threshold)`. Every partial outcome with `executed > 0` also shows a success toast for what was executed ("1,180 emails cleaned up" + Undo, no group count because it is not exact for a partial run), so Undo is always one click away (for Clean up; for "Confirm all keeps" the partial toast is "Kept 12 emails. Clearbox will remember." without a promise of Undo).

#### 5.2.5 After Clean up

Once caches refresh: if `preview.count === 0` and groups remain, the "Inbox cleared" EmptyState panel replaces the summary (5.1). If nothing remains at all, the "All caught up" page state shows. Focus is not moved unless it was inside the ConfirmBar; then it moves to the EmptyState button (or the first row).

#### 5.2.6 Confirm all keeps (Keep tab)

In the Keep tab, the tab bar's right side shows a secondary button size `sm` "Confirm all keeps" when the tab has groups. It runs the same machine with `mode: "confirm_keeps"`: preview `GET /api/cleanup/preview?actions=keep&threshold=0.5[&accountId]`, loop `POST /api/cleanup { actions: ["keep"], threshold: <preview.threshold>, asOf }`.

Copy: title "Mark 47 emails in 12 sender groups as Keep?"; detail "They stay in your inbox, leave Review, and Clearbox learns from your choice."; running "Confirming… 30 of 47"; done toast "Kept 47 emails from 12 sender groups. Clearbox will remember." (no Undo promise, see below). The scope is every visible account (no skipped-account line).

Keeps wording for the other moments (same machine and layout as 5.2.4, "Confirming keeps" for "Clean up", "kept" for "cleaned up"):

| Moment | Copy |
|---|---|
| Preview has nothing (info toast) | "Nothing left to confirm. New suggestions appear after the next sort." |
| Preview fails (error toast, "Try again") | "Couldn't prepare Confirm all keeps. Nothing was changed." |
| Done, nothing executed | "Nothing needed confirming (4 were already handled)" (parenthesis only when `skipped > 0`; no period) |
| Partial title | "Confirming keeps stopped. 12 emails were kept." and the other reasons of 5.2.4 with the same substitution |
| Partial: item failures | "12 emails were kept. 4 could not be confirmed." / "They were deleted or changed outside Clearbox, so they could not be confirmed. They are marked as failed." |
| Partial: account inactive detail | "you@company.com needs to reconnect before its emails can be confirmed." |
| Partial: no progress detail | "Clearbox could not confirm more right now. Try again in a few minutes." |
| Partial toast (executed > 0) | "Kept 12 emails. Clearbox will remember." |

**Undo and keeps (lead decision).** Undo does not apply to keep decisions: a Keep changes nothing in the mailbox, so the server skips keep items on undo (contracts 7.8, 12.6). The spec'd Keep toasts (group, per-email, bulk, "Always keep", "Confirm all keeps") therefore carry no Undo. The same holds in Activity: the SPA shows Undo only when the batch has a Trash or Archive part (`result.delete + result.archive > 0`, A5 keys), so a keep-only batch has no Undo in its toast or its row (5.4). A mixed batch ("Approve suggestions") shows Undo, which restores its Trash and Archive items and skips its keeps. The info toast "Nothing needed restoring. These emails were already back or untouched." remains only for a mixed, Trash or Archive batch whose items were already back, and that batch then reads "Undone" (an all-skipped batch stays undone). The code is aligned with this in the same change set.

### 5.3 Insights (`/insights`)

**Purpose:** answer "is the AI trustworthy?" and "how is the free tier doing?" in plain statements and one table, not a wall of KPI cards.

**Layout:** content max-width 1040px. PageHeader "Insights". App banners. Row 1: `grid-template-columns: 1.4fr 1fr; gap: 14px` (stacks below 1024px): panel "How well Clearbox matches you" | panel "Emails cleaned per week". Row 2 (margin-top 14px): panel "Accounts and daily budget". Row 3 (margin-top 14px): collapsed `details` panel "How the threshold was chosen".

Panels: `bg-surface border border-line rounded-xl`; panel header `px-4 py-3 border-b border-line flex items-center gap-2.5`, title `font-semibold`, optional right meta `text-small text-ink-3`.

**Data needed:** `GET /api/insights` (`["insights"]`): `precision.deletePrecision`, `precision.deleteSuggestionsDecided`, `precision.window`, `labels.total`, `labels.last7Days`, `calibration.tauDelete`, `calibration.outcome`, `calibration.ranAt`, `calibration.points[]` (`tau`, `support`, `precision`), `budget.*`, `accounts[]` (`id`, `provider`, `email`, `status`, `paused`, `sync`), A3 `weekly[]`. Plus `GET /api/me` (`freeTier`) and `GET /api/accounts` (A4 `sync.inboxEstimate`).

**Panel 1: How well Clearbox matches you** (stat lines: flex baseline, gap 8px, padding 14px 16px, `border-b border-line-subtle`, last none; value `text-stat font-heading` min-width 90px; text `text-ink-3`):

| Line | Value | Text | Null or edge case |
|---|---|---|---|
| Agreement | `formatPercent(deletePrecision, 1)` "98.6%" | "of trash suggestions you agreed with (target 98%)" | null: value "n/a", text "Not enough trash decisions yet. Clearbox measures this after 50." |
| Threshold | `toPercent(tauDelete)` + "%" ("86%") | outcome `calibrated`: "current Clean up threshold, tuned nightly from your choices"; `insufficient_data` or null: "starting Clean up threshold. Clearbox tunes it after 50 trash decisions."; `no_tau_meets_target`: "highest Clean up threshold. Your recent choices often disagreed with trash suggestions, so Clearbox is being extra careful." | Suffix line `text-small text-ink-3`: "Last tuned 9 h ago" when `ranAt` |
| Decisions | `formatCount(labels.total)` "1,912" | "decisions learned from you (312 this week)" | 0: "No decisions yet. Every Clean up and choice teaches Clearbox." |

**Panel 2: Emails cleaned per week:** `WeeklyChart` with A3 `weekly` (6 weeks). Interim until A3 exists: title "Emails sorted per day", bars from `history[].messagesIngested` (14 days), summary line "Today: 3,120 sorted".

**Panel 3: Accounts and daily budget:** header right meta: free tier: "Cloudflare free tier · resets 07:00" (`localResetTime`); paid: "Workers Paid · no daily write cap".

Table columns: "Account" (strong email), "Status" (`AccountStatusItem variant="inline"`: dot + text), "Backlog", "Last sorted", "Pending".

| Status | Backlog cell | Last sorted | Pending |
|---|---|---|---|
| up to date | "0" | `relativeAgo(lastTickAt)` | `sync.pendingCount` |
| catching up | with A4: "18,400 emails · about 2 days"; without: "Sorting, 32,118 so far"; rev 2.4 with a scan history window: "Scanning the last 90 days, 32,118 so far" (no count left, no ETA) | as above | as above |
| waiting | "Retrying in 3 min" | as above | as above |
| paused | "Paused" | as above | as above |
| needs reconnect | "Paused" | as above (often "3 days ago") | as above |
| setup error | "Paused" | as above | as above |

"About N days" = `ceil(remaining / dailyRate)` where `dailyRate` is the mean `messagesIngested` of the last 3 complete days in `history` (fallback 6,800); "about 1 day" when below 1.5; "less than a day" when below 0.5.

Below the table (padding 12px 16px): `ProgressBar tone="accent" height=6` (`rowsWritten / rowsCap`, label "Daily writes used"), then `text-small text-ink-3` "21,080 of 90,000 daily writes used (23%)". Then two lines `text-small text-ink-3`: "AI model today: 3,412 calls, 2 failed, about $0.06" (`decisionCalls`, `decisionFailures`, `estimatedDecisionCostUsd` with 2 decimals, "less than $0.01" when below 0.005) and "Storage: 182 MB of 500 MB". Paid tier hides the write meter line.

**Panel 4 (collapsed): How the threshold was chosen:** `details` element, summary row "How the threshold was chosen" with chevron. Content: helper "Each row shows how often you agreed with trash suggestions at that threshold. Clearbox picks the lowest threshold with at least 20 decisions and 98% agreement." and a Table: "Threshold" ("80%"), "Decisions" (`support`), "Agreement" (`precision` as "97.9%" or "n/a"); the chosen row is marked with a "Current" Protected-style neutral tag. Empty `points`: "Not enough decisions yet."

**States:** loading (stat line skeletons, chart skeleton, table skeleton), ready, error (panel-level EmptyState "Couldn't load insights." + "Try again"), budget exhausted (banner from 5.1 also shows here, plus the meter at 100% with text "90,000 of 90,000 daily writes used (100%). Sorting resumes after 07:00."), model issues (banner as 5.1), no accounts (table empty text "No accounts connected. Connect one in Accounts.").

**Interactions:** none besides `details` toggle, chart bar focus, links in banners. Refetch every 5 min and on focus.

### 5.4 Activity (`/activity`)

**Purpose:** everything Clearbox did on the owner's behalf, newest first, with Undo while available.

**Layout:** content max-width 1040px. PageHeader "Activity", meta "Undo is available for 24 hours", right: account Select. One panel containing a Table. "Load more" ghost button below the table when `nextCursor`.

**Data needed:** `GET /api/activity?accountId=&limit=50&cursor=` (`["activity", { accountId }]`, infinite): `id`, `ts`, `kind`, `accountId`, `batchId`, `count`, `result`. `GET /api/batches` (`["batches"]`, all pages, max 7 days): `id`, `undoable`, `undoExpiresAt`, `undoneAt`, `executedCount`, `byAction`. `GET /api/accounts` for emails. A5 defines the `result` keys the UI reads.

**Columns:** "When" (`activityWhen`), "What" (bold verb + " · " + detail), "Accounts" (email or "All accounts" when `accountId` is null; "A removed account" when the id is unknown), "Result", last column (right aligned) undo affordance.

| `kind` | What | Result | Last column |
|---|---|---|---|
| `cleanup` | **Clean up** · 1,284 emails (+ ", 371 sender groups" when `result.groups`) | "1,280 done · 4 already moved" (from `executed`, `skipped`, `failed`; "Done" when all executed) | Batch undoable and `result.delete + result.archive > 0`: secondary sm "Undo"; `undoneAt`: `text-ink-3` "Undone"; expired: `text-small text-ink-3` "Undo expired"; keep-only batch (`result.delete + result.archive` is 0): no Undo and no "Undone" or "Undo expired" text, the cell is empty |
| `approve` | **Trash** / **Archive** / **Keep** · 248 emails (verb from the only non-zero of `result.delete/archive/keep`; several: **Approved**) | as cleanup | as cleanup (a keep-only approve has no Undo) |
| `override` | **Changed** · 12 emails to Trash (target from `result`) | as cleanup | as cleanup |
| `undo` | **Undo** · 1,284 emails restored | "Done" or "1,280 restored · 4 failed" | none |
| `account_connected` | **Connected** · you@gmail.com | "Sorting started" | none |
| `account_reconnected` | **Reconnected** · you@gmail.com | "Sorting resumed" | none |
| `account_disconnected` | **Disconnected** · a mailbox | "Data removed tonight" | none |
| `account_purged` | **Removed data** · disconnected mailbox | "Done" | none |
| `account_paused` / `account_resumed` | **Paused** / **Resumed** · you@gmail.com | "Done" | none |
| `reauth_required` | **Needs reconnect** · you@company.com | "Sorting paused" | ghost sm "Reconnect" (only while the account is still `needs_reauth`) |
| `config_error` | **Setup error** · you@company.com | "Sorting paused" | ghost sm "Open Accounts" |
| `policy_updated` | **Rules updated** | "Always keep 3 · Always OK to trash 1" (from `result.allow`, `result.deny`; "Saved" when absent) | ghost sm "Open Rules" |
| `calibration` | **Threshold tuned** · checked 312 trash decisions | "Now 86%" (from `result.tauDelete`), else "Unchanged" | none |
| `purge` | **Nightly cleanup** · 4,210 old records removed (singular: "1 old record removed") | "Done" | none |

**States:** loading (5 skeleton rows), ready, empty ("Nothing yet. Actions you take and nightly maintenance appear here."), error (table error row), load more (button "Load more" with loading "Loading…"), undo in progress (button loading "Undoing…"), undo done (row result updates to "Undone" after refetch; toast "Restored 248 emails to your inbox."), undo expired (410: toast error "Undo is no longer available for this action (24 hours passed)." and the cell switches to "Undo expired").

**Interactions:** Undo: `POST /api/batches/:id/undo`, then invalidate `batches`, `activity`, `queue`, `groups`, `cleanup`. Focus moves to the row's "Undone" text afterwards. The Undo button comes back only when nothing was restored and something failed (the server keeps that batch undoable); a partly restored batch reads "Undone". A keep-only batch (`result.delete + result.archive` is 0) shows no Undo at all, because Undo restores nothing for keeps (5.2.6); the server still reports such a batch as `undoable: true` and the SPA derives the button from the delete and archive counts (contracts 7.8). For a mixed, Trash or Archive batch whose items were already back, the toast is "Nothing needed restoring. These emails were already back or untouched." and the row reads "Undone". The table waits for activity, accounts and batches before rendering, so rows never flash "Undo expired". Account Select filters. Row hover only highlights rows with an action.

### 5.5 Accounts (`/accounts`)

**Purpose:** connect Gmail or Outlook through their own sign-in screens, and see clear states for syncing, catching up, paused and reconnect.

**Layout:** content max-width 1040px. PageHeader "Accounts", right: secondary "Connect Gmail" (Gmail "G" tile icon 14px), secondary "Connect Outlook". App banners (one warning banner per `needs_reauth` account, one error banner per `config_error` account, callback result banner). One panel with an account card per account. Footer note (margin-top 10px, `text-small text-ink-3`): "Clearbox can only move mail to Trash or Archive. It can never permanently delete or send email."

**Account card** (`grid-template-columns: 34px minmax(0,1fr) auto; gap: 12px; align-items: center; padding: 14px 16px; border-bottom: 1px solid line-subtle`, `id="acc_<id>"`, `tabIndex=-1` for hash focus):

1. `ProviderTile` (provider color while the account is up to date or catching up, grey otherwise).
2. Email (`font-emphasis text-ink`) and status line `text-small text-ink-3`, plus for catching up a `ProgressBar tone="archive" width=240` (margin-top 6px).
3. Actions (gap 6px): per status below. Below 1024px they collapse into a Menu (more icon, label "Account actions for you@gmail.com").

| Status | Status line | Actions |
|---|---|---|
| up to date | "Gmail · up to date · 32,118 emails sorted · connected 15 Oct" | ghost "Scan now", ghost "Pause", ghost "Disconnect" |
| catching up | "Outlook · catching up, 18,400 left (about 2 days) · connected 15 Oct" (without A4: "Outlook · catching up, 32,118 sorted so far · connected 15 Oct"; rev 2.4 with a scan history window: "Outlook · scanning the last 90 days, 32,118 sorted so far · connected 15 Oct", ProgressBar indeterminate) | ghost "Scan now", ghost "Pause", ghost "Disconnect" |
| waiting | "Gmail · waiting, Gmail asked Clearbox to slow down · retrying in 3 min" | ghost "Pause", ghost "Disconnect" |
| paused | "Gmail · paused by you · 32,118 emails sorted" | secondary "Resume", ghost "Disconnect" |
| needs reconnect | "Gmail · paused, needs reconnect" | secondary "Reconnect", ghost "Disconnect" |
| setup error | "Gmail · paused, sign-in setup error (invalid_client)" (`statusReason`) | secondary "Reconnect" (enabled; it works once credentials are fixed), ghost "Disconnect" |

**Status cue on this surface:** the account card shows status as text only, with no dot (`AccountCard` has no `StatusDot`; the status line already names the state in words and the tile tone and the actions repeat it). The global "dot plus text" rule (7.1, 7.4) applies to `AccountStatusItem` in the sidebar and the Insights table, which do render the `StatusDot`.

`archiveSupported === false` (Outlook without an archive folder) adds to the status line: " · Archive unavailable, archive suggestions are kept in Review".

**Disconnect (inline confirm, no modal):** clicking "Disconnect" turns the card's action area into an inline confirm row spanning the card (bg `trash-soft`, `rounded-lg`, padding 10px 12px, margin-top 10px, all borders 1px `trash-line`): text "Disconnect you@gmail.com? Clearbox stops sorting it and deletes its stored data tonight. Your mailbox is not changed." buttons ghost "Cancel", danger "Disconnect". Focus moves to "Cancel". Then `DELETE /api/accounts/:id`. Result: Gmail `revoked`: toast "Disconnected you@gmail.com. Google access was revoked."; Gmail `failed`: toast "Disconnected you@gmail.com. Google did not confirm the revoke; you can remove access at myaccount.google.com/permissions." (link); Outlook `not_supported`: an info banner on the page "Disconnected you@outlook.com. Microsoft has no revoke button for apps, so remove Clearbox's access yourself." with actions "Personal account" (`consentUrls.personal`) and "Work or school account" (`consentUrls.work`), both external links.

**Pause / Resume:** `PATCH /api/accounts/:id { paused }`, optimistic (status flips immediately, rollback with error toast "Couldn't pause you@gmail.com. Try again."). Toast (info): "Paused sorting for you@gmail.com." / "Resumed sorting for you@gmail.com."

**Connect and Reconnect:** set `sessionStorage["clearbox.oauthReturn"] = "/accounts"`, then full navigation to `/oauth/google/start` or `/oauth/microsoft/start` (Reconnect adds `?loginHint=<email>`). Buttons show loading "Opening Google…" / "Opening Microsoft…" until unload. When `me.providers.gmail === false`: "Connect Gmail" is `aria-disabled` and a helper line under the header reads "Gmail is not set up yet. Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET as Worker secrets (see docs/setup-google.md)." Outlook equivalent with MS_CLIENT_ID and MS_CLIENT_SECRET and docs/setup-microsoft.md.

**OAuth return (query params, consumed then removed):**

| Param | Banner or toast |
|---|---|
| `connected=<id>` | Success toast: "Connected you@gmail.com. Sorting starts within a minute." The card gets focus. |
| `error=access_denied` | Warning banner: "Access was not granted." / "You cancelled the sign-in or declined the permissions. Clearbox needs them to sort your mail." / "Try again" |
| `error=admin_consent_required` | Warning: "Your organization must approve Clearbox first." / "Ask your Microsoft 365 admin to grant consent for this app, then try again." / "Try again" |
| `error=state_invalid` | Warning: "The sign-in took too long or was opened in another tab." / "Start again from this page." / "Try again" |
| `error=token_exchange_failed` | Error: "The provider did not complete the sign-in." / "Wait a moment and try again." / "Try again" |
| `error=provider_config_error` | Error: "Google sign-in is misconfigured." (or Microsoft) / setup error body from 5.1 / "Open setup guide" |
| `error=scope_missing` | Warning: "Some permissions were not granted." / "Clearbox needs permission to read and organize mail. Try again and keep every box checked." / "Try again" |
| `error=no_refresh_token` | Warning: "Google did not grant offline access." / "Remove Clearbox at myaccount.google.com/permissions, then connect again." / "Try again" |
| `error=profile_failed` | Error: "Connected, but Clearbox could not read the mailbox profile." / "Try again. If it keeps failing, check that the Gmail API (or Microsoft Graph) is enabled." / "Try again" |
| `error=provider_not_configured` | Warning: "Gmail is not set up yet." / "Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET as Worker secrets, then redeploy." / "Open setup guide" |

**Data needed:** `GET /api/me` (`providers`), `GET /api/accounts` (all fields), A4. Mutations: `PATCH /api/accounts/:id`, `DELETE /api/accounts/:id`, `POST /api/accounts/:id/scan`.

**States:** loading (3 skeleton cards), ready, empty (EmptyState `panel`: "No accounts yet" / "Connect Gmail or Outlook to start sorting." / two buttons), error ("Couldn't load accounts." + "Try again"), plus the per-status states above.

### 5.6 Rules (`/rules`)

**Purpose:** simple guardrails in plain language. These always win over the AI.

**Layout:** content max-width 880px. PageHeader "Rules", meta "These always override the AI", right: primary "Save changes" (enabled only when dirty). App banners (unsaved or conflict). One panel of fields. Each field: `flex flex-col gap-1.5 px-4 py-3.5 border-b border-line-subtle` (last none); title `font-emphasis text-ink`; description `text-small text-ink-3`. Row fields (`flex-row items-center`) put the control on the right.

| # | Field title | Description | Control | Policy key |
|---|---|---|---|---|
| 1 | "Always keep these senders" | "Never suggested for trash or archive." | ChipInput, placeholder "Add sender or @domain" | `allowlist` |
| 2 | "Always OK to trash" | "Skip the confidence check for these." | ChipInput, same placeholder | `denylist` |
| 3 | "Scan history" (rev 2.4) | "How far back Clearbox sorts mail already in your inbox. New mail is always scanned. A longer window picks up where the last scan stopped; a shorter one keeps existing suggestions." | Select (Last 30 days, Last 90 days, Last year, All mail); default Last 90 days | `scanHistoryDays` (30, 90, 365, null) |
| 4 | "Leave recent emails alone" | "Don't suggest anything for emails newer than this." | Select (Off, 1 day, 2, 3, 5, 7, 14, 30 days) | `minAgeDays` |
| 5 | "Protect starred, flagged and replied threads" | "Always on. These are never trashed." | Toggle locked on | none (fixed guardrail) |
| 6 | "Receipts and attachments go to Archive, not Trash" | "Always on. Emails with files, and emails whose subject or preview contains one of the words below." + nested ChipInput "Record words" (placeholder "Add a word", validation 2 to 40 characters, max 100) | Toggle locked on | `recordPatterns` |
| 7 | "Store email previews" | "Keeps a short snippet for 30 days to show in Review. Turn off to store subjects only." | Toggle | `storeSnippets` |
| 8 | "Remember subjects of emails you decide" | "Keeps the first 60 characters of the subject with each decision to improve suggestions. Turn off to keep only the sender." | Toggle | `labelSubjects` |

Below the panel, `text-small text-ink-3`: "Rule changes apply to emails sorted from now on. Suggestions already in Review keep their current verdict." and a link button "Reset to defaults" (fills the form with `defaults`, marks dirty; does not save).

**Data needed:** `GET /api/policy` (`["policy"]`): `policy`, `version`, `defaults`. Mutation: `PUT /api/policy { policy, expectedVersion: version }`.

**Editing model:** the form holds a local draft of the full `Policy`. Adding an entry to one list removes it from the other in the draft (chip note "Moved from Always OK to trash" / "Moved from Always keep"). Entries are lowercased and trimmed before validation with the shared `SenderEntrySchema` (client-side zod schema from `shared/api.ts`). Duplicates are rejected with "This entry is already in the list.".

**States:**

| State | Rendering |
|---|---|
| Loading | Field skeletons (title line, description line, 3 chip skeletons). Save disabled. |
| Ready, clean | Save disabled. |
| Dirty | Save enabled; document title "Rules (unsaved) · Clearbox"; info banner "You have unsaved changes." with actions "Save changes" and "Discard". Navigating away (router `useBlocker`) shows the same banner in a warning tone with "Save and leave", "Leave without saving", "Stay"; browser unload uses `beforeunload`. |
| Saving | Save loading "Saving…"; fields disabled. |
| Saved | Toast (success, no Undo): "Rules saved. They apply to new emails from now on." Draft resets from the response. |
| Validation error (400) | Field-level errors from `details[].path` (for example `allowlist.3`) shown under the matching ChipInput; toast error "Some entries are not valid. Fix the highlighted fields." |
| Conflict (409) | Warning banner: "Rules changed in another tab." / "Reload to see the latest rules. Your unsaved changes will be lost." / "Reload rules" (refetch and replace the draft). |
| Error loading | EmptyState `panel` "Couldn't load your rules." + "Try again". |

**Accessibility:** every field title is the accessible label of its control (`aria-labelledby`), descriptions via `aria-describedby`. Save also triggers on `mod+S` while the page is focused (prevent the browser save dialog).

### 5.7 Components gallery (`/dev/components`, development only)

**Purpose:** the mockup's section 7 as live components for visual QA and screenshots. Not shipped in production builds (route registered only when `import.meta.env.DEV`).

**Layout:** `grid grid-cols-2 gap-3.5 p-4` of cards (`bg-surface border border-line rounded-xl p-3.5 flex flex-col gap-2.5`, title `h4 text-body font-semibold`).

| Card | Content |
|---|---|
| Buttons | primary "Clean up 1,284", secondary "Archive", danger "Trash 248", ghost "Cancel"; focused secondary "Focused" (forced focus ring), disabled "Disabled", loading "Working…"; sizes sm, md, lg. |
| Verdict tags (icon + word, never color alone) | Trash, Archive, Keep, Check, Protected; sm and md. |
| Confidence scale (tick = Clean up threshold, tuned nightly) | ConfidenceLabel `scale` with a tau control (slider 0.80 to 0.99, dev only) and four `cell` examples: 97% Very sure, 89% Sure, 78% Likely · left for you, 54% Unsure · left for you. |
| Rows | SenderGroupRow in default, hover (forced), active, selected, busy, protected, model unavailable. |
| Banners and toasts | Each Banner tone; toasts success with Undo, info, error. |
| Inputs | TextInput states, ChipInput, Select, Toggle (on, off, locked), Checkbox (off, on, mixed, disabled). |
| Empty states and skeletons | Each EmptyState variant; skeleton rows. |
| Confirm bar | Confirming, running at 63%, partial. |

### 5.8 First-run setup (`/setup`)

**Purpose:** get from a fresh deploy to the first suggestions with no guesswork.

**Layout:** no sidebar. Centered column `max-w-[560px] mx-auto pt-12 px-4`. Brand row (mark + "Clearbox"). `h1` "Set up Clearbox". Intro `text-ink-2`: "Three checks, then Clearbox sorts your mailbox in the background." A panel with three step rows (`grid-template-columns: 24px 1fr auto; gap 12px; padding 14px 16px; border-b line-subtle`): step status icon (success check in `keep-ink`, warning in `check-ink`, error in `trash-ink`, pending as a 16px `line-control` circle), title plus description, action. Below the panel: the privacy note (`text-small text-ink-3`): "Clearbox can only move mail to Trash or Archive. It never permanently deletes or sends email. It stores sender, subject, date and a short preview, never full email bodies."

| Step | Done state | Problem state | Action |
|---|---|---|---|
| 1 "Sign-in protection" | "Protected by Cloudflare Access. Signed in as you@example.com." (`environment === "development"`: warning "Local development mode. Sign-in is bypassed on localhost only.") | (cannot render: AppShell shows the access error page) | none |
| 2 "AI model" | "Connected to your Decision-1 deployment." | Error copy per `decision_*` issue (the same bodies as 5.1, including the https endpoint and `Microsoft-Decision-1` deployment hint of `decision_not_configured` and "This clears after the next successful sort." for the other two), then "New emails will be marked Check until this is fixed." | ghost "Open setup guide" |
| 3 "Connect a mailbox" | "you@gmail.com connected." (one line per account) | Pending: "Connect Gmail or Outlook. You'll sign in on their page." | secondary "Connect Gmail", secondary "Connect Outlook" (disabled with helper when the provider is not configured, 5.5) |

After at least one account exists, a fourth block appears under the panel: "Sorting your first emails" with phase text and a ProgressBar:

| Account phase | Text |
|---|---|
| `sent_backfill` | "Learning who you write to (step 1 of 3)" |
| `inbox_backfill` | "Sorting your inbox, newest first (step 2 of 3). 2,400 emails sorted." Rev 2.4 with a scan history window: "Sorting the last 90 days of your inbox, newest first (step 2 of 3). 2,400 emails sorted." |
| `incremental` | "Caught up (step 3 of 3)." |

and a primary button "Go to Review" (disabled with helper "Your first suggestions appear within a few minutes." until `summary.pending.total > 0`; then enabled with helper "412 sender groups are ready."). Accounts poll every 15 s here.

**Data needed:** `GET /api/me` (`email`, `environment`, `providers`, `issues`), `GET /api/accounts`, `GET /api/queue/summary`.

**States:** loading (step skeletons), ready, provider not configured, model issue, connecting (button loading), returned with `connected` or `error` (same banners as 5.5, rendered above the panel), first sort running, ready to review.

**Redirect rules:** `/` goes to `/setup` when there are no accounts. `/review` with no accounts shows EmptyState `page` "Connect a mailbox to start" / "Clearbox sorts Gmail and Outlook. Setup takes about a minute." / primary "Set up Clearbox" (to `/setup`).

### 5.9 Error, offline and app-level states

**Full-page states** (rendered by AppShell instead of the page, centered EmptyState `page` with the brand row above):

| Condition | Title | Body | Action |
|---|---|---|---|
| Any API call returns `401 unauthenticated` | "Your session expired" | "Sign in again to keep using Clearbox." | primary "Sign in again" (`window.location.reload()`, which sends Access login) |
| `403 forbidden` | "This Clearbox belongs to someone else" | "Sign in with the owner's email address." | secondary "Sign out" (`/cdn-cgi/access/logout`) |
| `500 access_misconfigured` | "Sign-in protection is not configured" | "Set ACCESS_TEAM_DOMAIN, ACCESS_AUD and OWNER_EMAIL as Worker secrets, then redeploy. See docs/setup-cloudflare.md." | none |
| Uncaught render error (error boundary) | "Something went wrong on this page" | "Reload to try again. Your data is safe: Clearbox only acts when you confirm." | primary "Reload" |
| Unknown route | see 3.5 | | |

**Offline:** detected from `navigator.onLine === false` (events `online`/`offline`) or two consecutive network failures. Warning banner on every page: "You're offline." / "Clearbox will refresh when you're back online. Actions are paused." All mutating buttons become `aria-disabled` with the Banner as the explanation; TanStack Query `onlineManager` pauses queries. When back online: banner disappears, info toast "Back online." (dedupe key `online`), all queries refetch.

**`403 csrf_required`:** never expected from the SPA (the client always sends the header); treated as an error toast "Something went wrong. Nothing was changed." and logged.

**Banner matrix (which app-level banners appear where):**

| Banner | Review | Activity | Insights | Rules | Accounts | Setup |
|---|---|---|---|---|---|---|
| Offline | yes | yes | yes | yes | yes | yes |
| Needs reconnect (per account) | yes | no | no | no | yes | no |
| Setup error (account or client) | yes | no | no | no | yes | yes |
| Model not configured | yes | no | yes | no | no | yes (in step 2) |
| Model temporarily unavailable | yes | no | yes | no | no | no |
| Budget exhausted (dismissible) | yes | no | yes | no | no | no |
| Storage near limit (dismissible) | yes | no | yes | no | no | no |
| Unsaved or conflict | no | no | no | yes | no | no |
| OAuth return result | no | no | no | no | yes | yes |

---

## 6. Interaction model

### 6.1 Keyboard map

`mod` = ⌘ on macOS, Ctrl elsewhere. Letter keys are case-insensitive and ignore Caps Lock.

| Keys | Scope | Action |
|---|---|---|
| `J` or `↓` | Review list (also from the detail slide-over) | Next group (activates it; detail follows) |
| `K` or `↑` | Review list | Previous group |
| `Home` / `End` | Review list (row focused) | First / last loaded group |
| `PageDown` / `PageUp` | Review list (row focused) | Move by 10 groups |
| `X` | Review | Toggle selection of the active group |
| `Shift+X` | Review | Select the range from the anchor to the active group |
| `mod+A` | Review list focused | Select all loaded groups in the tab |
| `T` | Review | Trash: the selection, else the active group |
| `A` | Review | Archive: the selection, else the active group |
| `E` | Review | Keep: the selection, else the active group |
| `Enter` | Review row focused | Open detail (slide-over or sheet below 1280px; focus to the detail heading at `xl`) |
| `Enter` | Email row in detail | Expand or collapse the email |
| `O` | Email row expanded | Open the email in Gmail or Outlook (new tab) |
| `mod+Enter` | Review (anywhere, including inputs) | Clean up: open the confirm bar |
| `Enter` | ConfirmBar confirming (focus on body or in the bar) | Confirm Clean up |
| `Esc` | Global, first match wins | Close menu or dialog, cancel confirm bar, close slide-over or sheet, clear selection, collapse expanded email |
| `mod+Z` | Global (not in text inputs) | Undo the most recent undoable action |
| `?` (`Shift+/`) | Global | Open the keyboard shortcut help |
| `1` to `5` | Review | Tabs All, Trash, Archive, Check, Keep |
| `G` then `R` | Global | Go to Review |
| `G` then `A` | Global | Go to Activity |
| `G` then `I` | Global | Go to Insights |
| `G` then `U` | Global | Go to Rules |
| `G` then `C` | Global | Go to Accounts (addition: Accounts had no sequence in the brief) |
| `mod+S` | Rules | Save changes |

### 6.2 Shortcut handling rules

- One `HotkeysProvider` listens on `document` `keydown` (capture: false). Handlers are registered per scope (`global`, `review`, `confirm`, `rules`) with priorities: dialog > menu > confirm > slideover > review > global.
- Ignored when the event target is an `input`, `textarea`, `select` or `contenteditable`, except `Esc` (blurs the field first) and `mod+Enter` on Review.
- Ignored when `event.isComposing`, when `altKey` is pressed (except where listed), or when any modifier other than the listed one is pressed.
- Single-letter shortcuts never fire while a `Dialog` or `Menu` is open.
- `G` starts a sequence with a 1,000 ms window. After 400 ms without a second key a hint chip appears at the bottom left of the main area (`bg-inverse text-on-inverse text-meta rounded-md px-2 py-1`): "Go to: R Review · A Activity · I Insights · U Rules · C Accounts". Any other key or the timeout cancels the sequence and the hint. During the window, `A` means "Go to Activity", not Archive.
- Action keys (`T`, `A`, `E`, `X`) are ignored for busy rows and while a Clean up run is `preparing`.
- Every shortcut is listed in the help dialog and exposed through `aria-keyshortcuts` on the matching button.

### 6.3 Selection model

- **Active group** (one, tinted, shown in detail) is separate from **selected groups** (checkboxes, tinted, used by bulk actions).
- Click a row: activate only. `mod`+click: toggle selected. `Shift`+click (row or checkbox): select the inclusive range from the anchor (the last row toggled or activated) to the clicked row, adding to the selection.
- Checkbox click: toggle, set the anchor.
- `X` toggles the active row; `Shift+X` selects the range from the anchor.
- Header checkbox: unchecked or mixed: select all loaded rows of the tab; checked: clear. When all loaded rows are selected and more pages exist, the toolbar offers "Select all 318 in Trash": the client fetches remaining pages sequentially (limit 100, hard cap 1,000 groups; above the cap the link reads "Select first 1,000") and selects them.
- Selection clears on tab, account filter or sort change, and after a bulk action completes (successful rows leave the list; failed rows stay selected).
- Rows removed by any action are removed from the selection.
- `Esc` clears the selection when nothing with higher priority is open.

### 6.4 Group action semantics (T, A, E, detail buttons, bulk)

```ts
// target: "delete" | "archive" | "keep"
async function actOnGroup(group: SenderGroup, target: ActionKind, asOf: string): Promise<GroupActionResult> {
  const batchIds: number[] = [];
  let executed = 0, failed = 0, skipped = 0, retryLater = 0;
  const maxCalls = Math.ceil(group.count / 100) + 3;
  if (group.action === target) {
    // Approve the suggestion for the whole group, 100 per call.
    for (let i = 0; i < maxCalls; i++) {
      const r = await api.approve({ groupKey: group.key, asOf });
      collect(r);                                                    // sums + batchIds
      if (r.remaining === 0 || r.executed + r.failed + r.skipped === 0) break;
    }
  } else {
    // Override: page through the group's pending items and override them in chunks of 100.
    for (let i = 0; i < maxCalls; i++) {
      const page = await api.groupDetail(group.key, { limit: 100 });
      const ids = page.items.items.map((it) => it.id);
      if (ids.length === 0) break;
      const r = await api.override({ ids, action: target });
      collect(r);
      if (r.executed + r.failed + r.skipped === 0) break;           // only retry_later: stop
    }
  }
  return { executed, failed, skipped, retryLater, batchIds };
}
```

- `asOf`: the open group's `GroupDetail.asOf` when loaded, else `QueueSummary.asOf`.
- Check (`unsure`) groups are never approved; T, A and E always override them.
- Bulk on a selection runs `actOnGroup` per group sequentially in list order; "Approve suggestions" uses each group's own action (`unsure` groups block the button, 4.7).
- Results feed one toast and one undo stack entry (all `batchIds`).

### 6.5 Focus management

| Situation | Focus goes to |
|---|---|
| Route change (except to Review) | The page `h1` (`tabIndex=-1`, no visible ring because it is programmatic) |
| Route change to Review | The active row once rows are loaded; the `h1` while loading |
| Row removed after an action | The next row at the same index, else the previous row, else the EmptyState action |
| ConfirmBar opens | Its "Clean up" button |
| ConfirmBar cancelled | The SummaryCard "Clean up" button |
| ConfirmBar disappears while focus is inside it (run ended) | EmptyState action if shown, else the active row |
| Slide-over or sheet opens | The detail heading |
| Slide-over or sheet closes | The row that opened it |
| Menu opens / closes | First item / trigger |
| Dialog opens / closes | Dialog title / element focused before opening |
| Disconnect inline confirm opens / cancelled | Its "Cancel" button / the "Disconnect" button |
| `/accounts#acc_<id>` or `?connected=` | That account card |
| Rules validation error after Save | The first invalid field |

Focus is never moved by toasts, polling or background refetches.

### 6.6 Optimistic updates and rollback

| Mutation | Optimistic change | On success | On partial | On error (rollback) |
|---|---|---|---|---|
| Group action (approve, override, always keep) | Remove the row from every cached `groups` page; decrement tab counts, `summary.pending`, `summary.groups`, preview counts if applicable; advance focus | Invalidate `queue`, `cleanup`, `group` for that key; push undo entry; toast | Re-insert the row at its old index with `count` reduced by `executed + skipped`, then refetch that group | Re-insert row and counts exactly as before (snapshot from `onMutate`); error toast; focus back to the row |
| Per-email action | Remove the email row; decrement the group count (row and detail) | Invalidate `group` key and `queue`; if the group count reaches 0 the group row exits too | n/a (single id) | Restore the row; error toast |
| Bulk action | Each group row enters busy state (not removed until its call returns) | Row exits as above | As group action | That row only is restored; later groups still run unless the error is `budget_exhausted` or offline (then the remaining are cancelled and stay selected) |
| Pause / Resume | Flip `paused` in `accounts` cache | Invalidate `accounts` | n/a | Flip back; error toast |
| Policy sender patch | none (wait for server, button loading) | Replace `policy` cache | n/a | Error toast |
| Policy save | none (Save loading) | Replace `policy` cache | n/a | Field errors or conflict banner |
| Clean up, Undo, Disconnect, Scan now | none (explicit progress or loading) | Invalidate as listed in 5.2 and 5.5 | n/a | Error states as listed |

The "New suggestions" snapshot: when the groups list loads, store `summary.pending.total` and `summary.groups`. Own optimistic changes update the snapshot by the same deltas. When a later summary poll differs from the snapshot, show the pill. Groups are never refetched automatically while the owner is reviewing (except after own mutations as listed and after a Clean up run).

### 6.7 Polling and refresh cadence

| Query | `staleTime` | `refetchInterval` | On window focus | Notes |
|---|---|---|---|---|
| `["me"]` | 5 min | none | yes | |
| `["accounts"]` | 10 s | 15 s when any account is catching up, waiting, has `awaitingModelCount > 0`, or a scan or Setup page is active; otherwise 60 s | yes | Paused when `document.hidden` |
| `["queue", "summary", …]` | 0 | 60 s | yes | Drives the nav count and the New suggestions pill |
| `["cleanup", "preview", …]` | 0 | 60 s while the Clean up phase is `idle` | yes | Always refetched fresh on Clean up click |
| `["groups", …]` (infinite) | 30 s | none | no | Refetched only after mutations, Refresh pill, filter change |
| `["group", key]` (infinite) | 30 s | none | no | Prefetch the next row's detail when a row becomes active |
| `["batches"]` | 30 s | 60 s while Activity is mounted | yes | |
| `["activity", …]` | 30 s | none | yes | |
| `["insights"]` | 60 s | 5 min | yes | |
| `["policy"]` | Infinity | none | no | Replaced by mutation responses |

Global defaults: `retry: 1` for queries (not for 4xx), `retry: 0` for mutations (the Clean up loop has its own single retry), `refetchOnReconnect: true`, `networkMode: "online"`. All refetch intervals stop while offline or while the tab is hidden (`refetchIntervalInBackground: false`). Relative times re-render every 30 s from a shared clock hook.

### 6.8 Toast queue and undo stack

- At most 3 toasts are visible. A 4th dismisses the oldest non-error toast first; if all 3 are errors, the oldest error is dismissed.
- Durations: success with Undo 8 s, info 5 s, error until dismissed. Timers pause on hover, on keyboard focus inside the toast, and while the tab is hidden.
- A toast with the same `dedupeKey` replaces the existing one in place (timer restarts).
- The Undo action turns the toast into "Undoing…" (spinner, no buttons), then the toast is replaced by the result toast.
- **Undo stack** (`UndoStackProvider`): every action that returns `batchId`s and has a Trash or Archive part (never a keep-only action, 5.2.6) pushes `{ id, label, batchIds, expiresAt }` where `expiresAt` = earliest `undoExpiresAt` (fallback: now + 24 h). Max 20 entries, in memory (lost on reload; Activity remains the durable place to undo). `mod+Z` pops the newest unexpired entry and undoes all its batches (newest batch first). Empty stack: info toast "Nothing to undo here. Actions from earlier sessions can be undone in Activity for 24 hours." with action "View" (to `/activity`).
- The Undo stack entry is consumed before the server call and is never re-queued: a partly restored batch stays undone on the server, so there is no in-app retry. `mod+Z` ignores key auto-repeat (holding it must not walk the stack).
- Undo result toasts: success "Restored 248 emails to your inbox."; partial "Restored 240 emails. 8 could not be restored." (a whole undo call failed, count unknown: "Restored 240 emails. Some could not be restored."); nothing restored and nothing failed (items already back in a mixed, Trash or Archive batch; keep-only batches show no Undo, 5.2.6): info "Nothing needed restoring. These emails were already back or untouched."; expired error "Undo is no longer available for this action (24 hours passed)."

### 6.9 Shortcut help dialog (`?`)

Title "Keyboard shortcuts". Three columns of `dl` lists with Kbd: "Review" (J/K move, X select, Shift X select range, T trash, A archive, E keep, Enter open, 1 to 5 tabs), "Clean up" (⌘ ↵ clean up, ↵ confirm, Esc cancel, ⌘ Z undo), "Go to" (G R Review, G A Activity, G I Insights, G U Rules, G C Accounts, ? this help). Footer `text-small text-ink-3`: "Shortcuts are off while you type in a field." Below it a Toggle "Use single-key shortcuts" (WCAG 2.1.4; stored in `localStorage["clearbox.singleKeys"]`, default on; when off, J, K, X, T, A, E, 1 to 5 and G sequences are disabled, while `mod` combinations, Enter, Esc and `?` keep working). Close: Esc or the close button.

---

## 7. Accessibility

### 7.1 Target and checklist (WCAG 2.2 AA)

| Criterion | How Clearbox meets it |
|---|---|
| 1.1.1 Non-text content | Icons are `aria-hidden` next to words; icon-only buttons have `aria-label`; the chart has a text alternative and a hidden table. |
| 1.3.1 Info and relationships | Landmarks, one `h1` per page, grid semantics for the group list, native tables, labelled fields. |
| 1.4.1 Use of color | Verdicts: icon + word. Confidence: percentage + band word. Account status: dot + text (sidebar and Insights; account cards use text only, 5.5). Destructive buttons: trash icon or the word "Disconnect". |
| 1.4.3 Contrast (text) | All text pairs at least 4.5:1 (7.2). |
| 1.4.11 Non-text contrast | Control boundaries, focus ring, status dots, tau tick, chart bars at least 3:1 (7.2). Confidence meter fills are supplementary (percentage and band word are adjacent text) and are documented as exempt. |
| 1.4.10 Reflow, 1.4.12 Text spacing | Layouts reflow to a single column below 1024px; no fixed heights on text containers. |
| 1.4.13 Content on hover | Chart labels appear on hover and focus, stay while hovered, dismiss with Esc. |
| 2.1.1 Keyboard, 2.1.4 Character key shortcuts | Everything is keyboard operable. Single-key shortcuts are active only when focus is not in a text field, and can be turned off: user menu "Keyboard shortcuts" dialog has a toggle "Use single-key shortcuts" (stored in `localStorage["clearbox.singleKeys"]`, default on). |
| 2.4.3 Focus order, 2.4.7 Focus visible | Order follows layout; 2px ring (7.2). |
| 2.4.11 Focus not obscured (minimum) | The sticky ConfirmBar and list header could cover a focused row: the scroll container sets `scroll-padding-top: 44px` and `scroll-padding-bottom: 96px`, and focused rows call `scrollIntoView({ block: "nearest" })`. |
| 2.5.7 Dragging | No drag interactions. |
| 2.5.8 Target size (minimum) | All targets at least 24 x 24 CSS px (checkbox click area is the 22px cell plus row padding, so 24px+; chip remove 16px icon sits in a 24px button). |
| 3.2.6 Consistent help | The help dialog is always in the same place (user menu and `?`). |
| 3.3.1 Error identification, 3.3.3 Suggestion | Field errors in text with a fix ("Use name@domain.com or @domain.com."). |
| 3.3.7 Redundant entry | No repeated data entry. |
| 3.3.8 Accessible authentication | Sign-in is delegated to Cloudflare Access and the providers; Clearbox adds no cognitive test. |
| 4.1.2 Name, role, value | Native elements first; ARIA patterns for grid, tabs, menu, switch, dialog. |
| 4.1.3 Status messages | Live regions for toasts, progress and banners (7.5). |

### 7.2 Contrast pairs (light, v1)

Computed with the WCAG 2.x relative luminance formula (Node script, 2026-10-15). Required: 4.5:1 for text, 3:1 for UI components and graphical objects.

**Text pairs**

| Pair | Colors | Ratio | Required | Result |
|---|---|---|---|---|
| ink on surface | `#16171B` on `#FFFFFF` | 17.91 | 4.5 | Pass |
| ink on canvas | `#16171B` on `#FBFBFC` | 17.32 | 4.5 | Pass |
| ink on surface-sunk | `#16171B` on `#F4F5F7` | 16.42 | 4.5 | Pass |
| ink on surface-selected | `#16171B` on `#F3F4FF` | 16.37 | 4.5 | Pass |
| ink-2 on surface | `#4A4D57` on `#FFFFFF` | 8.43 | 4.5 | Pass |
| ink-2 on surface-sunk | `#4A4D57` on `#F4F5F7` | 7.73 | 4.5 | Pass |
| ink-2 on surface-selected | `#4A4D57` on `#F3F4FF` | 7.71 | 4.5 | Pass |
| ink-3 on surface | `#686C77` on `#FFFFFF` | 5.25 | 4.5 | Pass |
| ink-3 on canvas | `#686C77` on `#FBFBFC` | 5.08 | 4.5 | Pass |
| ink-3 on surface-raised | `#686C77` on `#FCFCFD` | 5.12 | 4.5 | Pass |
| ink-3 on surface-hover | `#686C77` on `#F8F8FA` | 4.95 | 4.5 | Pass |
| ink-3 on surface-sunk | `#686C77` on `#F4F5F7` | 4.81 | 4.5 | Pass |
| ink-3 on surface-selected | `#686C77` on `#F3F4FF` | 4.80 | 4.5 | Pass |
| on-inverse on inverse (primary button, toast, bar) | `#FFFFFF` on `#16171B` | 17.91 | 4.5 | Pass |
| on-inverse-2 on inverse | `#C9CAD1` on `#16171B` | 10.96 | 4.5 | Pass |
| on-inverse-3 on inverse | `#A9ABB5` on `#16171B` | 7.83 | 4.5 | Pass |
| Kbd on primary (`#D6D7DD` on 12% white over ink = `#323336`) | `#D6D7DD` on `#323336` | 8.80 | 4.5 | Pass |
| White on trash (danger button) | `#FFFFFF` on `#D93636` | 4.63 | 4.5 | Pass |
| White on trash-hover | `#FFFFFF` on `#C42B2B` | 5.63 | 4.5 | Pass |
| Trash tag | `#B42323` on `#FDEEEE` | 5.82 | 4.5 | Pass |
| Archive tag | `#1F58B8` on `#ECF2FD` | 5.94 | 4.5 | Pass |
| Keep tag | `#167A41` on `#EAF7EF` | 4.89 | 4.5 | Pass |
| Check tag | `#8F5600` on `#FFF5E0` | 5.54 | 4.5 | Pass |
| Protected tag | `#4A4D57` on `#F4F5F7` | 7.73 | 4.5 | Pass |
| Warning banner | `#6E4300` on `#FFF5E0` | 7.86 | 4.5 | Pass |
| Error banner | `#B42323` on `#FDEEEE` | 5.82 | 4.5 | Pass |
| Info banner | `#1F58B8` on `#ECF2FD` | 5.94 | 4.5 | Pass |
| Field error text on surface | `#B42323` on `#FFFFFF` | 6.55 | 4.5 | Pass |
| Very sure word on surface / selected | `#167A41` on `#FFFFFF` / `#F3F4FF` | 5.39 / 4.93 | 4.5 | Pass |
| Sure word on surface / selected | `#2F7A4D` on `#FFFFFF` / `#F3F4FF` | 5.23 / 4.78 | 4.5 | Pass |
| Likely word on surface / selected | `#8F5600` on `#FFFFFF` / `#F3F4FF` | 6.00 / 5.49 | 4.5 | Pass |
| Unsure word on surface / selected / sunk | `#B4501A` on `#FFFFFF` / `#F3F4FF` / `#F4F5F7` | 5.12 / 4.68 / 4.69 | 4.5 | Pass |
| Accent link on surface | `#4F46E5` on `#FFFFFF` | 6.29 | 4.5 | Pass |
| Accent on accent-soft (New suggestions pill) | `#4F46E5` on `#EEF0FF` | 5.55 | 4.5 | Pass |
| Accent-hover on surface | `#4338CA` on `#FFFFFF` | 7.90 | 4.5 | Pass |
| Monogram white on avatar-0 .. avatar-11 | `#FFFFFF` on `#B42323`, `#B4501A`, `#8F5600`, `#167A41`, `#0F766E`, `#0E7490`, `#1F58B8`, `#4F46E5`, `#7C3AED`, `#A21CAF`, `#BE185D`, `#475569` | 6.55, 5.12, 6.00, 5.39, 5.47, 5.36, 6.67, 6.29, 5.70, 6.32, 6.04, 7.58 | 4.5 | Pass |
| Unknown sender and owner avatar | `#16171B` on `#D9DBE3` | 12.96 | 4.5 | Pass |
| Gmail tile | `#FFFFFF` on `#D93025` | 4.77 | 4.5 | Pass |
| Outlook tile | `#FFFFFF` on `#0F6CBD` | 5.38 | 4.5 | Pass |
| Inactive provider tile | `#FFFFFF` on `#6B6F7A` | 5.02 | 4.5 | Pass |

**UI component and graphic pairs**

| Pair | Colors | Ratio | Required | Result |
|---|---|---|---|---|
| Focus ring on surface / selected / sunk | `#4F46E5` on `#FFFFFF` / `#F3F4FF` / `#F4F5F7` | 6.29 / 5.75 / 5.76 | 3 | Pass |
| Focus ring on inverse (white) | `#FFFFFF` on `#16171B` | 17.91 | 3 | Pass |
| Control border (checkbox, input, toggle off) on surface / selected / sunk | `#868A95` on `#FFFFFF` / `#F3F4FF` / `#F4F5F7` | 3.45 / 3.16 / 3.16 | 3 | Pass |
| Toggle knob on off track | `#FFFFFF` on `#868A95` | 3.45 | 3 | Pass |
| Toggle on track and checked checkbox | `#16171B` on `#FFFFFF` | 17.91 | 3 | Pass |
| Tau tick on track / on selected row | `#7C808C` on `#F4F5F7` / `#F3F4FF` | 3.62 / 3.61 | 3 | Pass |
| Status ok / sync / warn / error / off dots on sidebar | `#1F9D55`, `#2F6FDB`, `#B76E00`, `#D93636`, `#868A95` on `#F4F5F7` | 3.20 / 4.36 / 3.67 / 4.25 / 3.16 | 3 | Pass |
| Chart past-week bar | `#7F86EB` on `#FFFFFF` | 3.22 | 3 | Pass |
| Chart current-week bar | `#4F46E5` on `#FFFFFF` | 6.29 | 3 | Pass |
| Active tab underline | `#16171B` on `#FFFFFF` | 17.91 | 3 | Pass |
| Split bar Trash / Archive on surface | `#D93636` / `#2F6FDB` on `#FFFFFF` | 4.63 / 4.75 | 3 | Pass |
| Confidence fill Very sure on track | `#1F9D55` on `#F4F5F7` | 3.20 | 3 | Pass |
| Confidence fill Sure on track | `#6CC08B` on `#F4F5F7` | 2.02 | 3 | Exempt (supplementary; owner-binding hex) |
| Confidence fill Likely on track | `#E0A030` on `#F4F5F7` | 2.08 | 3 | Exempt (supplementary; owner-binding hex) |
| Confidence fill Unsure on track | `#E5762E` on `#F4F5F7` | 2.76 | 3 | Exempt (supplementary; owner-binding hex) |
| Split bar "left for you" on surface | `#D9DBE3` on `#FFFFFF` | 1.38 | 3 | Exempt (`aria-hidden`; the legend states every number) |

Exemption rationale: 1.4.11 applies to graphics "required to understand the content". The meter and split bar never carry information that is not printed next to them (percentage, band word, legend counts). If an audit still flags them, the fallback is to add a 1px `tick`-colored outline to the meter track, not to change the owner's band colors.

**Failures found in the mockup and the fixes applied in this spec**

| Mockup pair | Ratio | Fix | New ratio |
|---|---|---|---|
| `--ink3` `#7C808C` text on white / sunk | 3.94 / 3.62 | `ink-3` becomes `#686C77` | 5.25 / 4.81 |
| Band word "Very sure" `#1F9D55` on white | 3.49 | Text uses `band-very-sure-ink` `#167A41` | 5.39 |
| Band word "Sure" `#6CC08B` on white | 2.20 | Text uses `band-sure-ink` `#2F7A4D` | 5.23 |
| Band word "Likely" `#E0A030` on white | 2.27 | Text uses `band-likely-ink` `#8F5600` | 6.00 |
| Band word "Unsure" `#E5762E` on white | 3.02 | Text uses `band-unsure-ink` `#B4501A` | 5.12 |
| Checkbox border `#C9CBD3` on white | 1.62 | `line-control` `#868A95` | 3.45 |
| Toggle off track `#D3D5DC` on white | 1.47 | `line-control` `#868A95` | 3.45 |
| Input border `#E8E9ED` on white | 1.21 | `line-control` `#868A95` | 3.45 |
| Meter tick `#B5B8C2` on track | 1.82 | `tick` `#7C808C` | 3.62 |
| Focus halo `#C7CBFF` on white | 1.57 | 2px solid `focus` `#4F46E5` outline | 6.29 |
| Amber status dot `#E0A030` on sunk | 2.08 | `status-warn` `#B76E00` | 3.67 |
| Chart bar `#DADCF8` on white | 1.35 | `accent-bar` `#7F86EB` | 3.22 |
| Gmail tile white on `#EA4335` | 3.92 | `provider-gmail` `#D93025` | 4.77 |
| Paused tile white on `#9AA0A6` | 2.64 | `provider-off` `#6B6F7A` | 5.02 |

A unit test (`app/test/web/tokens.contrast.test.ts`) parses `styles.css`, recomputes every pair in this section and fails below the required ratio.

### 7.3 Contrast pairs (dark, v1.1 optional)

| Pair | Colors | Ratio | Required | Result |
|---|---|---|---|---|
| ink on surface / canvas | `#ECEDF0` on `#16171B` / `#0F1013` | 15.30 / 16.25 | 4.5 | Pass |
| ink-2 on surface / sunk | `#B4B7C0` on `#16171B` / `#1D1F24` | 8.93 / 8.22 | 4.5 | Pass |
| ink-3 on surface / sunk / selected / raised | `#9599A3` on `#16171B` / `#1D1F24` / `#23254A` / `#131418` | 6.28 / 5.78 / 5.13 / 6.45 | 4.5 | Pass |
| Primary button text | `#16171B` on `#ECEDF0` | 15.30 | 4.5 | Pass |
| on-inverse / on-inverse-3 on inverse | `#ECEDF0` / `#A9ABB5` on `#26282E` | 12.59 / 6.44 | 4.5 | Pass |
| White on trash | `#FFFFFF` on `#D93636` | 4.63 | 4.5 | Pass |
| Tags Trash / Archive / Keep / Check | `#FF9A9A`/`#3A1C1E`, `#9DBEF7`/`#172540`, `#7BD9A3`/`#13301F`, `#F2C46D`/`#33260F` | 7.58 / 8.10 / 8.36 / 9.05 | 4.5 | Pass |
| Band words on surface | `#4CC883`, `#8FD3A8`, `#E9B455`, `#F0915A` on `#16171B` | 8.44 / 10.28 / 9.49 / 7.59 | 4.5 | Pass |
| Unsure word on selected | `#F0915A` on `#23254A` | 6.20 | 4.5 | Pass |
| Accent on surface | `#8B85FF` on `#16171B` | 5.88 | 4.5 | Pass |
| Focus ring on canvas | `#8B85FF` on `#0F1013` | 6.25 | 3 | Pass |
| Control border on surface / sunk | `#777B86` on `#16171B` / `#1D1F24` | 4.23 / 3.90 | 3 | Pass |
| Tick on track | `#8E929C` on `#26282E` | 4.73 | 3 | Pass |
| Band fills on dark track | `#1F9D55`, `#6CC08B`, `#E0A030`, `#E5762E` on `#26282E` | 4.22 / 6.70 / 6.48 / 4.88 | 3 | Pass |

### 7.4 Non-color cues (summary)

| Information | Color cue | Non-color cue |
|---|---|---|
| Verdict | Tag tint | Icon + word ("Trash") |
| Confidence band | Fill and word color | Percentage + band word; "left for you" for Likely and Unsure in the detail panel |
| In Clean up or not | Band | Detail membership line; confirm bar counts |
| Destructive action | Red fill | Trash icon + the word "Trash"/"Disconnect"; inline confirm for Disconnect; Undo for Trash |
| Account status | Dot (sidebar, Insights) | "Reconnect", "Fix setup", "Paused", "41%" text; accessible names. Account cards: text only |
| Selected row | Tint | Checked checkbox, `aria-selected`, toolbar count |
| Active row | Tint | Detail panel shows it; `aria-current="true"` on the row |
| Focus | Indigo ring | Ring shape (2px outline), never color change alone |
| Current week in chart | Darker bar | "This week" label |
| Errors | Red text and border | Alert icon + message text |

### 7.5 Screen reader announcements

| Event | Mechanism | Text |
|---|---|---|
| Toast success or info | Polite live region (ToastRegion) | Toast message, then "Press Command Z to undo" when Undo exists (Control Z elsewhere) |
| Toast error | `role="alert"` | Message |
| Clean up started | LiveAnnouncer (polite) | "Clean up started, 1,284 emails" |
| Clean up progress | LiveAnnouncer, only at 25%, 50%, 75% | "Cleaning up, 50 percent done" |
| Clean up finished or partial | Toast plus LiveAnnouncer for the partial bar title | Copy from 5.2.4 |
| Group removed after action | LiveAnnouncer | "Shopee moved to Trash. Next: Medium Daily Digest." |
| Selection change | LiveAnnouncer (debounced 300 ms) | "3 groups selected" |
| Tab change | Native tabs semantics | Tab name with count |
| New suggestions pill appears | LiveAnnouncer | "New suggestions are ready. Refresh to see them." |
| Banner appearing after load | `role="status"` (warning, info) or `role="alert"` (error) | Banner title and body |
| Loading regions | `aria-busy="true"` + hidden text | "Loading sender groups" |
| Scan finished | Toast | Copy from 5.1 |

### 7.6 Reduced motion

Covered in 2.7: no transforms, no size transitions, no shimmer, no looping animations, instant row removal, opacity-only fades of 150ms or less. Test both modes (Playwright is not a dependency, so this is a manual screenshot item in 8.7 plus a Vitest check that `matchMedia("(prefers-reduced-motion: reduce)")` disables the row exit timers).

---

## 8. Frontend architecture notes for implementers

### 8.1 Stack (from contracts section 2)

React 19.3.1, React Router 8.4.0 (declarative data router: `createBrowserRouter`, `RouterProvider`; no framework mode), TanStack Query 5.104.3, Tailwind CSS 4.3.3 with `@tailwindcss/vite`, Vite 8.3.4, zod 4.6.7 (only the small shared request schemas), TypeScript 6.0.3 strict. No UI component library, no icon library, no date library, no CSS-in-JS.

Test-only additions this spec requires (verified with `npm view` on 2026-10-15; per contracts section 11 they must be added to the contracts dependency table with these exact versions before use): `axe-core` 4.14.0, `@testing-library/user-event` 14.6.8.

### 8.2 Folder structure (`app/src/web/`)

```
src/web/
  main.tsx                     # createRoot, QueryClientProvider, RouterProvider (no inline script in index.html)
  styles.css                   # section 2.9 (tokens, base); imports styles-layers.css
  styles-layers.css            # `@layer components` cb-* geometry helpers (split out to stay under the size rule)
  styles.dark.css              # section 2.10, NOT imported in v1
  routes.tsx                   # route table (3.5), RootRedirect, OAuthReturn, dev-only gallery
  api/
    client.ts                  # apiGet/apiSend, CSRF header, ApiError, error envelope parsing
    keys.ts                    # query key factory (8.3)
    queries.ts                 # useMe, useAccounts, useQueueSummary, useCleanupPreview, useGroups, useGroupDetail,
                               # useBatches, useActivity, useInsights, usePolicy
    mutations.ts               # useApprove, useOverride, useGroupAction, useUndo, useScanNow, usePatchAccount,
                               # useDisconnect, usePatchSender, usePutPolicy
    cleanup.ts                 # runCleanup loop (5.2.3), pure and unit tested
  lib/
    view-types.ts  confidence.ts  format.ts  avatar.ts  account-status.ts  copy.ts  copy-actions.ts  platform.ts
    oauth-return.ts  oauth-errors.ts  banners.ts  activity.ts  links.ts  report.ts  rules-draft.ts
  state/
    CleanupProvider.tsx        # state machine (5.2.2)
    UndoStackProvider.tsx      # 6.8
    ToastProvider.tsx          # 4.18, 6.8
    HotkeysProvider.tsx        # 6.1, 6.2
    LiveAnnouncer.tsx          # 4.33
    use-selection.ts           # 6.3
    use-now.ts                 # shared 30 s clock
    use-pageshow-reset.ts      # resets loading buttons after a back-forward cache restore (Connect buttons)
    # also: toast-queue, cleanup-machine, hotkeys-core, offline, use-document-title, use-focus-trap, use-media-query,
    # use-platform, use-route-focus (the file list is in contracts 1.1)
  pages/
    ReviewPage.tsx  ActivityPage.tsx  InsightsPage.tsx  RulesPage.tsx  AccountsPage.tsx  SetupPage.tsx
    NotFoundPage.tsx  ComponentGallery.tsx  FullPageError.tsx  OAuthReturn.tsx  RootLayout.tsx  RootRedirect.tsx
    review/                    # ReviewWorkArea.tsx and the Review controller split: use-review-controller, use-review-focus,
                               # use-review-effects, use-review-hotkeys, use-review-params, use-group-actions, use-item-actions,
                               # use-new-suggestions, use-scan-now, review-state, group-cache, select-all (bounded to 20 page fetches)
    gallery/                   # dev-only gallery sections and sample data
  components/
    ui/                        # Button, LinkButton, Kbd, Select, Menu, Tabs, Chip, ChipInput, TextInput, Toggle,
                               # Checkbox, Table, Dialog, Banner, EmptyState, Skeleton, ProgressBar, Toast,
                               # VisuallyHidden, Icon (icons.tsx), Spark, css-vars.ts (8.4)
    shell/                     # AppShell, SidebarNav, AccountStatusItem, PageHeader, StatusDot, GSequenceHint,
                               # ShortcutHelpDialog, OfflineWatcher
    review/                    # SummaryCard, SplitBar, ActionTabs, SenderGroupList, SelectionToolbar, SenderGroupRow,
                               # SenderAvatar, VerdictTag, ConfidenceMeter, ConfidenceLabel, ReasonLine, DetailPanel,
                               # EmailPreviewList, ConfirmBar
    insights/                  # StatLine, WeeklyChart, BudgetPanel, ThresholdTable
    accounts/                  # AccountCard, ProviderTile, DisconnectConfirm
    rules/                     # RuleField, RulesForm
```

`lib/`, `state/` and the component subfolders are additions inside `src/web/` (contracts 1.1 lets the UI plan own the file lists of `pages/` and `components/`; `lib/` and `state/` are new sibling folders, listed in the contracts layout since rev 2.2; rev 2.3 added the Review controller modules and `styles-layers.css`). Files follow contracts section 11: PascalCase components, kebab-case modules, named exports, `.ts`/`.tsx` extensions in relative imports, under 300 lines each.

### 8.3 Data fetching conventions

```ts
// api/client.ts
import { CSRF_HEADER, CSRF_VALUE, type ApiErrorBody, type ApiErrorCode } from "../../shared/api.ts";

export class ApiError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode | "network";
  readonly retryAt: string | undefined;
  readonly details: unknown;
  constructor(status: number, code: ApiErrorCode | "network", message: string, retryAt?: string, details?: unknown) {
    super(message);
    this.status = status; this.code = code; this.retryAt = retryAt; this.details = details;
  }
}

export async function apiGet<T>(path: string, params?: Record<string, string | number | undefined>): Promise<T>;
export async function apiSend<T>(method: "POST" | "PUT" | "PATCH" | "DELETE", path: string, body?: unknown): Promise<T>;
// Both: same-origin relative URLs, credentials "same-origin", Accept: application/json.
// apiSend always sets `${CSRF_HEADER}: ${CSRF_VALUE}` ("X-Clearbox-CSRF: 1") and Content-Type: application/json when body is present.
// Non-2xx: parse ApiErrorBody and throw ApiError(status, error.code, error.message, error.retryAt, error.details).
// fetch rejection: throw ApiError(0, "network", "Network error").
// 401, 403 (forbidden) and 500 access_misconfigured are also published to a session-error store read by AppShell (5.9).
```

```ts
// api/keys.ts
export const qk = {
  me: ["me"] as const,
  accounts: ["accounts"] as const,
  summary: (accountId?: string) => ["queue", "summary", { accountId: accountId ?? null }] as const,
  preview: (accountId?: string, actions = "delete,archive") => ["cleanup", "preview", { accountId: accountId ?? null, actions }] as const,
  groups: (f: { accountId?: string; action?: Verdict; sort: GroupSort }) => ["groups", { accountId: f.accountId ?? null, action: f.action ?? null, sort: f.sort }] as const,
  group: (key: GroupKey) => ["group", key] as const,
  batches: ["batches"] as const,
  activity: (accountId?: string) => ["activity", { accountId: accountId ?? null }] as const,
  insights: ["insights"] as const,
  policy: ["policy"] as const,
};
```

Rules:

- Lists use `useInfiniteQuery` with `initialPageParam: undefined` and `getNextPageParam: (p) => p.nextCursor ?? undefined`.
- Every mutation lives in `api/mutations.ts`, uses `apiSend` (so the CSRF header is never forgotten), and declares its invalidations next to it (6.6, 5.2.2). Prefix invalidation is used (`["queue"]`, `["groups"]`, `["cleanup"]`, `["group"]`).
- Optimistic updates use `onMutate` snapshots via `queryClient.getQueriesData({ queryKey: ["groups"] })` and restore them in `onError`.
- No request is sent from render; all fetching goes through hooks.
- Response types come from `shared/api.ts`; the web bundle does not import `@clearbox/core` runtime code.
- A Vitest test asserts that every `apiSend` call carries `X-Clearbox-CSRF: 1` and that GETs do not.

### 8.4 CSP strategy (decided)

Production CSP (contracts 3.4): `script-src 'self'; style-src 'self'` with no `unsafe-inline`, no hashes, no nonces.

1. `index.html` has no inline `<script>` or `<style>`, and no `style=""` attributes. Theme color and favicon are external files.
2. All styling is Tailwind classes compiled into the external CSS file. No CSS-in-JS, no runtime `<style>` injection.
3. **Dynamic geometry (meter fill, tick position, split bar segments, progress, chart heights) uses CSS custom properties set through React's `style` prop, and nothing else.** Example: `<i className="cb-fill" style={cssVars({ "--cb-value": 0.97 })} />`. React DOM applies `style` props through the CSSOM (`element.style.setProperty`), which CSP does not block; only `style` attributes in parsed HTML and `setAttribute("style", …)` are blocked. This holds because the SPA is client-rendered only (no SSR, no HTML string rendering).
4. Enforcement: `components/ui/css-vars.ts` exports `cssVars(vars: CbVars): React.CSSProperties`, where `type CbVars = Record<CbVarName, number | string>` and `CbVarName` is the template literal type for names starting with `--cb-`; in development it also throws on any other key. ESLint `no-restricted-syntax` uses the selector `JSXAttribute[name.name="style"] > JSXExpressionContainer > :not(CallExpression[callee.name="cssVars"])` with the message "Use style={cssVars({...})} with --cb-* properties only (CSP, see UI spec 8.4)", so every `style` value must be a direct `cssVars(...)` call. A unit test renders every geometry component and asserts their `style` contains only `--cb-*` properties.
5. SVG uses presentation attributes (`fill`, `stroke`, `width`), never `style`.
6. Vite's default small-asset inlining produces `data:` URIs, which `img-src 'self' data:` allows; no fonts exist, so `font-src 'self'` is never exercised.
7. Verification: after each deploy (the dev server does not apply `_headers`), open every route with DevTools and confirm zero CSP violations; `main.tsx` registers a `securitypolicyviolation` listener that `console.error`s the blocked directive in all builds to make violations obvious.

### 8.5 Plain-text email rendering

- Subjects, snippets, sender names and reasons render as React text nodes only. `dangerouslySetInnerHTML`, `innerHTML` and `insertAdjacentHTML` are banned by ESLint (`no-restricted-syntax` and `no-restricted-properties`).
- Snippet whitespace: CSS `white-space: pre-line`; no HTML entity decoding in the client (the server already decodes), no linkification, no markdown.
- Deep links (`deepLink`) are rendered only when they start with `https://mail.google.com/` or `https://outlook.` (`outlook.live.com`, `outlook.office.com`, `outlook.office365.com`), always with `target="_blank" rel="noopener noreferrer"`.
- A test renders a group whose subject is `<img src=x onerror=alert(1)>` and asserts it appears as literal text with no `img` element.

### 8.6 Testing

Location `app/test/web/**/*.test.tsx`, Vitest with happy-dom, Testing Library, `msw/node` handlers built from the shared types (contracts 10.1).

| Area | Tests |
|---|---|
| `lib/confidence` | `bandFor` at boundaries for several tau values (0.80, 0.86, 0.95, 0.99), `toPercent` float edge cases (0.29, 0.949, 0.86), `inCleanup`. |
| `lib/avatar` | Deterministic color index per domain, monogram for names, emails, Unicode, empty. |
| `api/client` | CSRF header on mutations only, error envelope mapping, network errors, session-error publishing. |
| `api/cleanup` | Loop until `remaining === 0`; stop on no progress; stop on `budget_exhausted`; single retry on 5xx; `maxCalls` guard; `batchIds` collection; threshold and `asOf` sent unchanged. |
| `CleanupProvider` | Every transition of 5.2.2, including Stop and Undo of multiple batches. |
| Components | Each component's states from section 4 render the specified copy and roles. |
| Review page | Keyboard flow: J/K, X, Shift+X, T on a Trash group calls approve with `groupKey`, T on a Check group pages and calls override, Esc priority order, `mod+Enter` opens the confirm bar, Enter confirms, `mod+Z` undoes. Focus moves per 6.5. |
| Optimistic rollback | Group action error restores row, counts and focus. |
| Text safety | 8.5 test. |
| CSP | `style` props contain only `--cb-*` (8.4). |
| Accessibility | `axe-core` run on every page and on the component gallery in each major state with rules `color-contrast` disabled (happy-dom has no layout; contrast is covered by the token test) and all WCAG 2.2 A and AA tags enabled; zero violations allowed. |
| Tokens | `tokens.contrast.test.ts` recomputes every pair in 7.2 from `styles.css`. |
| Copy | A test greps `src/web` for U+2014 (em dash) and fails (also enforced by `scripts/check-text.ts`). |

### 8.7 Screenshot checklist

Capture at 1440 x 900 (primary), 1280 x 800, 1100 x 800 (slide-over), 900 x 800 (single column), 390 x 844 ("usable"), each in default and `prefers-reduced-motion: reduce`; v1.1 only: dark mode. Compare against `docs/design/clearbox-ui-v4.html` for the matching sections.

| # | Screen and state |
|---|---|
| 1 | Review ready, first row active, detail panel (mockup section 1) |
| 2 | Review with 3 rows selected (selection toolbar) |
| 3 | Review row hover, focus ring on a row, busy row |
| 4 | Review loading skeletons |
| 5 | Review nothing sure; Review all caught up; Review first sort; Review no accounts |
| 6 | Each tab including an empty tab |
| 7 | Detail panel for Trash, Archive, Keep, Check, Protected, model unavailable, needs reconnect |
| 8 | Email row expanded with snippet and per-email actions |
| 9 | Clean up: confirming, running at about 63%, done toast, partial (budget), inbox cleared panel (mockup section 2) |
| 10 | Confirm all keeps in the Keep tab |
| 11 | Banners: needs reconnect, setup error, model not configured, model unavailable, budget, storage, offline |
| 12 | Insights ready (mockup section 3), insufficient data, budget at 100%, threshold table expanded |
| 13 | Activity with undoable, undone and expired rows (mockup section 4); empty |
| 14 | Accounts with up to date, catching up, needs reconnect cards (mockup section 5); disconnect inline confirm; each OAuth return banner |
| 15 | Rules clean (mockup section 6), dirty with unsaved banner, validation error, conflict |
| 16 | Component gallery (mockup section 7) |
| 17 | Setup: before any account, after connect while sorting, ready to review |
| 18 | Full-page errors: session expired, forbidden, access misconfigured, error boundary, 404 |
| 19 | Shortcut help dialog; G sequence hint; user menu; detail More menu |
| 20 | 1100px slide-over open; 900px drawer open; 900px detail sheet; 390px Review |

---

## 9. Mockup reference

### 9.1 Source

The approved mockup is [`docs/design/clearbox-ui-v4.html`](../../design/clearbox-ui-v4.html) (static HTML and CSS, "v4, confidence colors", approved 2026-10-15). Its sections map to this spec as follows: 1 Review = 5.1; 2 Clean up flow = 5.2; 3 Insights = 5.3; 4 Activity = 5.4; 5 Accounts = 5.5; 6 Rules = 5.6; 7 Components = section 4 and 5.7. Its `:root` custom properties are the origin of the tokens in section 2. The page chrome around the frames (body `#F1F2F5`, frame borders and shadows, section titles, the `.option` and `data-choice` attributes) is presentation only and is not part of the app.

### 9.2 Deliberate differences between the mockup and this spec

| # | Mockup | Spec | Why |
|---|---|---|---|
| 1 | Meter tick hardcoded at `left: 86%` | Tick at `tau` from the API via `--cb-tau` | tau is tuned nightly; never hardcode |
| 2 | Scale card text "86 to 94%", "70 to 85%" | Ranges computed from tau (4.12) | Same |
| 3 | Confirm copy "41 groups below 90% stay here" | "below 86%" from `toPercent(preview.threshold)` | Same; the mockup's 90% was inconsistent with its own 86% tick |
| 4 | "Clean up 1,284 emails from 371 senders?" and toast "from 371 senders" | "in 371 sender groups" | A sender can appear in more than one group (per account and action); counts must be exact |
| 5 | Rows at or above tau shown pre-checked | Checkboxes are a manual selection, empty by default; Clean up scope is threshold-based and shown by the band word and the detail membership line | The API executes Clean up by threshold (no exclusion list); a pre-checked state would promise control the server cannot honor |
| 6 | No selection toolbar | Toolbar replaces the header row when groups are selected (4.7) | Bulk actions need a visible home |
| 7 | `--ink3` `#7C808C` | `ink-3` `#686C77` | Contrast (7.2) |
| 8 | Band words colored with fill colors | Band words use `-ink` text tokens; fills unchanged | Contrast |
| 9 | Checkbox `#C9CBD3`, toggle off `#D3D5DC`, input `#E8E9ED` borders | `line-control` `#868A95` | Non-text contrast |
| 10 | Meter tick `#B5B8C2` | `tick` `#7C808C` | Non-text contrast |
| 11 | Focus shown as a 3px `#C7CBFF` halo plus accent border | 2px solid `#4F46E5` outline, offset 2px | Non-text contrast and consistency |
| 12 | Amber status dot `#E0A030` | `status-warn` `#B76E00` | Non-text contrast; amber stays the Likely band fill |
| 13 | Chart bars `#DADCF8` | `accent-bar` `#7F86EB` | Non-text contrast |
| 14 | Gmail tile `#EA4335`, paused tile `#9AA0A6` | `#D93025`, `#6B6F7A` | Text contrast |
| 15 | Sender avatars in brand colors with "in" for LinkedIn | Single-letter monogram, color from a 12-color palette by domain hash | Privacy (no brand assets), determinism, contrast |
| 16 | `.meter.low` `#C9A15E` style | Removed; four bands only | Superseded by the v4 confidence bands |
| 17 | Account names "Gmail · personal", "Gmail · work" | Email addresses | The API has no nickname (A7) |
| 18 | Detail footer "+ 245 more · Open in Gmail ↗" | "+ 245 more · Show 20 more", and "Open in Gmail" per email in its expanded row | Deep links exist per email only |
| 19 | Detail actions: Trash, Archive, Keep, Always keep | Same plus a More menu (Always OK to trash, Always keep the domain, Copy address); per-verdict button sets (4.14) | Covers deny list and domain rules from the contract |
| 20 | Running bar without a Stop | Ghost "Stop" | Owner control during long runs |
| 21 | No Keep handling | "Confirm all keeps" in the Keep tab | Keep suggestions are excluded from Clean up |
| 22 | Insights "Last 30 days" selector | Removed | The insights API has no range parameter (precision uses the newest 500 decisions) |
| 23 | Insights threshold shown as "0.86" | "86%" | Consistent with every other confidence display |
| 24 | Insights column "Today's writes" per account | "Pending" per account; daily writes shown once for the deployment | The budget is tracked per deployment, not per account |
| 25 | Insights has no threshold detail | Collapsed "How the threshold was chosen" table | Design spec section 11 lists the calibration curve |
| 26 | Activity "Always keep · Mom" with "Remove rule"; "Trash · Shopee, 248 emails" | "Rules updated" with "Open Rules"; "Trash · 248 emails" | The audit log stores counts and codes only, never addresses or names |
| 27 | Rules chip "Mom" | Chips show entries (`mom@example.com`, `@bank.co.id`) | Policy lists store addresses and domains only |
| 28 | Rules: three toggles | Starred and receipts toggles locked on; added "Record words" chips and "Remember subjects" toggle | Matches the policy schema (`recordPatterns`, `labelSubjects`) and fixed guardrails |
| 29 | Accounts cards: Scan now, Disconnect | Adds Pause and Resume; Disconnect uses an inline confirm | The API supports pause; disconnect is destructive |
| 30 | Radii 5, 7, 9px and weights 580, 600, 640 | Normalized to 4, 6, 8, 10, 12px and 560, 620, 650 | Five radius tokens and six weight tokens |
| 31 | Nav shows only Review, Activity, Insights, Rules | Same, plus the "Accounts" section header links to `/accounts`, and `G C` goes there | Accounts needs a route and a shortcut |
| 32 | Kbd always visible | Hidden below 640px | No physical keyboard expected there |

### 9.3 Contract additions (ACCEPTED as contracts section 12, rev 2.1; A1 to A6 ship in v1, A7 deferred to v1.1)

The interim behaviors below remain as defensive fallbacks only (for example while data is loading or for accounts connected before A4 data exists).

| Id | Addition | Used by | Interim behavior until added |
|---|---|---|---|
| A1 | `QueueSummary.groupsByAction: Record<SuggestedAction, number>` | Tab counts (4.6) | Count shown only on "All" (`groups`); other tabs show no count |
| A2 | `CleanupPreview.groupsLeft: number`: pending groups in scope that keep at least one pending item after this Clean up | Summary sub-line, confirm detail (5.2.4) | Email-count wording ("240 emails are left for you to check") |
| A3 | `Insights.weekly: { weekStart: string; cleaned: number; undone: number }[]` (last 6 ISO weeks, Monday start, UTC; `cleaned` = executed Trash and Archive decisions; `undone` = items restored by undo) | Weekly chart (5.3) | "Emails sorted per day" from `history[].messagesIngested` |
| A4 | `AccountSync.inboxEstimate: number \| null` (provider inbox size at bootstrap, refreshed during backfill) | Backlog remaining, catch-up percent, ETA (4.3, 5.3, 5.5) | "Sorting, N so far" copy and an indeterminate bar |
| A5 | Documented `ActivityEntry.result` keys: approve, override, cleanup `{ executed, failed, skipped, retryLater, delete, archive, keep, groups }`; undo `{ restored, failed }`; policy_updated `{ allow, deny }`; calibration `{ tauDelete }` | Activity table (5.4) | Use `count` and "Done" |
| A6 | `SenderGroup.latestSubject: string \| null` (newest pending item's subject, plain text) | Row second line (4.8) | First top reason text |
| A7 (v1.1) | `AccountView.label: string \| null` (owner nickname) | Sidebar, tables | Email address |

### 9.4 Open questions (resolved by the lead, 2026-10-15)

1. **Keep in Clean up.** Resolved: excluded; Keep is handled by "Confirm all keeps" (contracts 12.3).
2. **Reason wording.** Resolved: templates say "trashed" (contracts 12.2).
3. **Group confidence value.** Resolved: rows show `confidence.avg`; the detail panel adds min and max (contracts 12.3).
4. **Contract additions A1 to A6.** Resolved: accepted (contracts 12.1).
5. **Dark mode.** Prepared as optional v1.1 (2.10, 7.3); not shipped in v1.
6. **Undo stack persistence.** Default: in memory per tab; Activity is the durable undo surface for 24 hours.
7. **Test dependencies.** `axe-core` 4.14.0 and `@testing-library/user-event` 14.6.8 need to be added to the contracts dependency table.
