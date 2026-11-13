# UI development

OCI Dash uses Tailwind CSS and shadcn components built on Radix primitives.

## Components and styles

- Keep one-off classes beside their JSX elements. Use `cn()` for conditional classes and a small
  number of genuinely shared combinations.
- Use `cva()` for components with real variants, such as buttons and badges. Avoid large style
  dictionaries for individual screens.
- Prefer the existing UI components and semantic theme colors. Keep ordinary spacing, type sizes
  and radii on the Tailwind scale. Use arbitrary values only for geometry that needs them, such as
  chart axes, canvas sizing and viewport calculations.
- Put styles on the elements they affect. Reserve descendant selectors for library-owned markup
  or shared component slots.

## Shared controls

The shared Button uses shadcn variants: `default`, `outline`, `secondary`, `ghost`, `destructive`
and `link`. Its loading state preserves its label and icon space.

`Panel` combines a card heading, description, action and content. `StatusBadge` adds application
tones. The underlying `ui/card` and `ui/badge` exports retain their composition APIs.

Use `Select` with an explicit `options` array of `{ value, label, disabled? }`. Empty values remain
available for filters such as “all accounts”.

Keep shared behavior in `Modal`, `RefreshButton`, `CopyButton`, `Status` and `TablePanel`. Preserve
initial and returned focus, form labels, pending-state protection and data retained during refresh.

## Responsive layout

Use the default Tailwind breakpoints: `sm` at 40rem, `md` at 48rem, `lg` at 64rem, `xl` at 80rem
and `2xl` at 96rem. Desktop navigation starts at `lg`; JavaScript uses `DESKTOP_NAVIGATION_QUERY` from
`src/lib/ui-layout.ts` to match the CSS threshold.

Allow filters and actions to wrap. Keep table overflow inside the table region and dialog overflow
inside its body. Check narrow screens, short screens, dark mode and larger root font sizes when
changing shared layouts.
