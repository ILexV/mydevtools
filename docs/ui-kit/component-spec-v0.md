# UI Kit v0 Component Spec

## Goal

Create a standalone `ui-kit` inside this repository for the future React frontend migration.

This kit is not a pixel-perfect copy of the current Blazor UI. The current site is used as a source of functional scenarios and repeated interaction patterns. The new kit should establish a stronger, cleaner visual system that can later be reused across this project and other projects.

## Product Direction

### Chosen visual direction

- Style: `developer tool / terminal-inspired`
- Not retro terminal
- Not generic SaaS
- Not a 1:1 restyle of the current site

### Visual principles

- Strong layout grid
- Sans for interface, mono for data and result-heavy areas
- Crisp surfaces and borders over heavy decorative effects
- Strong focus states and keyboard clarity
- Dense but not cramped spacing
- Clear separation between input, settings, and output surfaces
- Light and dark themes supported from the start

### What we inherit from the current site

- Repeated user tasks and interaction patterns
- Input/output workflows
- File processing flows
- Tool page structure
- Common action semantics such as generate, copy, clear, download, validate

### What we do not inherit directly

- Existing page-specific styling
- Ad hoc spacing and sizing decisions
- Raw Razor markup structure
- Blazor-specific DOM wiring

## Scope Boundary

### UI kit owns

- Visual primitives
- Reusable composed components
- Shared layout patterns
- Accessibility baseline
- Theming and tokens
- Storybook documentation

### UI kit does not own

- Routing
- Page-level SEO wiring
- Blazor integration details
- Tool business logic
- WASM orchestration
- Tool-specific computation behavior

## Initial repo target

Planned structure for the next implementation step:

```text
/
├── MyDevToolsApp/
├── wasm/
├── docs/
│   └── ui-kit/
│       └── component-spec-v0.md
├── packages/
│   └── ui-kit/
└── apps/
    └── storybook/
```

## Source Audit Summary

The current site already exposes stable functional patterns worth standardizing:

- `MyDevToolsApp/MyDevTools.Site/Components/Layout/ToolLayout.razor`
- `MyDevToolsApp/MyDevTools.Site/Components/Common/FileDropZone.razor`
- `MyDevToolsApp/MyDevTools.Site/Components/Tools/WordCounter.razor`
- `MyDevToolsApp/MyDevTools.Site/Components/Tools/ImageConverter.razor`
- `MyDevToolsApp/MyDevTools.Site/Components/Sections/ToolsSection.razor`
- `MyDevToolsApp/MyDevTools.Site/Components/Layout/MainLayout.razor`
- `MyDevToolsApp/MyDevTools.Site/Components/Sections/HeroSection.razor`

These files define the main scenarios for the first component pass:

- actions and action hierarchy
- form controls
- tool panels
- stats and result surfaces
- file upload and preview
- shared tool page shell

## V0 Component Set

The first implementation wave will focus on 12 components.

### Priority summary

| Component | Priority | Role |
| --- | --- | --- |
| `Button` | P0 | Core action primitive |
| `IconButton` | P0 | Icon-only actions |
| `Input` | P0 | Text and number input |
| `Textarea` | P0 | Large text and data input |
| `Select` | P0 | Choice input |
| `Alert` | P0 | Info, success, warning, error states |
| `Card` | P0 | Base surface |
| `Field` | P0 | Label + control + help + error wrapper |
| `PanelCard` | P0 | Reusable tool block shell |
| `FileDropZone` | P0 | File upload and drag-drop block |
| `ToolPageLayout` | P0 | Shared tool page template |
| `ToolPanel` | P0 | Input/settings/output panel |

## Cross-cutting component rules

Every component in `v0` should follow these rules:

- Typed props with narrow variant unions where possible
- `className` escape hatch allowed, but not as the primary configuration mechanism
- All interactive components must expose disabled and focus-visible states
- Loading and empty states should be explicit when relevant
- Icon support should be compositional instead of hardcoded
- Components should support both light and dark theme tokens
- Visual variants should be semantic, not page-specific

## Component Specifications

### 1. `Button`

**Purpose**

Primary action trigger for generate, convert, validate, format, download, submit, and other explicit calls to action.

**Current source examples**

- Tool pages across `MyDevToolsApp/MyDevTools.Site/Components/Tools/*.razor`
- `WordCounter.razor`
- `ImageConverter.razor`

**Planned props**

```ts
type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'outline' | 'danger' | 'success';
type ButtonSize = 'sm' | 'md' | 'lg';

type ButtonProps = {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  disabled?: boolean;
  fullWidth?: boolean;
  leadingIcon?: React.ReactNode;
  trailingIcon?: React.ReactNode;
  children: React.ReactNode;
};
```

**States**

- default
- hover
- focus-visible
- active
- disabled
- loading

**Required Storybook stories**

- Primary
- Secondary
- Ghost
- Danger
- Sizes
- With icons
- Loading
- Disabled
- Dark theme

**Intentional improvements**

- Clear action hierarchy
- Consistent spacing and icon alignment
- Stronger keyboard and loading feedback

### 2. `IconButton`

**Purpose**

Small action surface for copy, clear, favorite, theme toggle, search, download, close, and similar icon-led actions.

**Current source examples**

- `WordCounter.razor`
- `ToolsSection.razor`
- `MainLayout.razor`
- `ImageConverter.razor`

**Planned props**

```ts
type IconButtonProps = {
  ariaLabel: string;
  variant?: 'ghost' | 'outline' | 'solid' | 'danger';
  size?: 'sm' | 'md' | 'lg';
  selected?: boolean;
  disabled?: boolean;
  icon: React.ReactNode;
};
```

**States**

- default
- hover
- focus-visible
- active
- selected
- disabled

**Required Storybook stories**

- Default
- Selected
- Danger
- Sizes
- Disabled
- Dark theme

**Intentional improvements**

- Better accessibility for icon-only controls
- Shared sizing and hit-area rules

### 3. `Input`

**Purpose**

Single-line input for text, numeric values, and compact settings.

**Current source examples**

- `X509Tool.razor`
- `UnitConverter.razor`
- `RegexTester.razor`
- `DateConverter.razor`

**Planned props**

```ts
type InputProps = {
  type?: 'text' | 'number' | 'email' | 'password' | 'search' | 'url';
  value?: string;
  defaultValue?: string;
  placeholder?: string;
  disabled?: boolean;
  readOnly?: boolean;
  invalid?: boolean;
  leadingIcon?: React.ReactNode;
  trailingIcon?: React.ReactNode;
};
```

**States**

- default
- focus-visible
- invalid
- disabled
- readOnly

**Required Storybook stories**

- Text
- Number
- With icons
- Invalid
- Disabled
- Read-only
- Dark theme

**Intentional improvements**

- Uniform focus ring and density
- Better distinction between editable and read-only states

### 4. `Textarea`

**Purpose**

Large multi-line input and output surface for text, JSON, XML, tokens, and formatted results.

**Current source examples**

- `WordCounter.razor`
- `JwtDecoder.razor`
- `X509Tool.razor`
- `UrlEncoder.razor`

**Planned props**

```ts
type TextareaProps = {
  value?: string;
  defaultValue?: string;
  placeholder?: string;
  rows?: number;
  resize?: 'none' | 'vertical' | 'both';
  monospace?: boolean;
  readOnly?: boolean;
  disabled?: boolean;
  invalid?: boolean;
};
```

**States**

- default
- focus-visible
- invalid
- disabled
- readOnly

**Required Storybook stories**

- Default
- Monospace
- Invalid
- Read-only
- Disabled
- Dark theme

**Intentional improvements**

- Better long-form readability
- Stronger visual distinction for data-entry mode vs result mode

### 5. `Select`

**Purpose**

Single-choice control for tool settings such as format, category, mode, or language.

**Current source examples**

- `ImageConverter.razor`
- `UuidGenerator.razor`
- `UnitConverter.razor`
- `LanguageSwitcher.razor`

**Planned props**

```ts
type SelectOption = {
  label: string;
  value: string;
  disabled?: boolean;
};

type SelectProps = {
  options: SelectOption[];
  value?: string;
  defaultValue?: string;
  placeholder?: string;
  disabled?: boolean;
  invalid?: boolean;
  size?: 'sm' | 'md' | 'lg';
};
```

**States**

- default
- open
- focus-visible
- invalid
- disabled

**Required Storybook stories**

- Default
- Sizes
- Invalid
- Disabled
- Long labels
- Dark theme

**Intentional improvements**

- Cleaner dropdown behavior
- Better long-label handling and consistent sizing

### 6. `Alert`

**Purpose**

Inline message block for success, warning, error, info, or privacy notices.

**Current source examples**

- `ToolLayout.razor`
- `ImageConverter.razor`
- `X509Tool.razor`

**Planned props**

```ts
type AlertProps = {
  variant?: 'info' | 'success' | 'warning' | 'error';
  title?: string;
  description?: string;
  icon?: React.ReactNode;
  actions?: React.ReactNode;
};
```

**States**

- info
- success
- warning
- error

**Required Storybook stories**

- Info
- Success
- Warning
- Error
- With title and description
- With actions
- Dark theme

**Intentional improvements**

- Better information hierarchy
- More consistent semantic coloring and icon usage

### 7. `Card`

**Purpose**

Base surface primitive for grouping content.

**Current source examples**

- Nearly every tool page
- `ToolsSection.razor`
- `ToolLayout.razor`

**Planned props**

```ts
type CardProps = {
  variant?: 'default' | 'muted' | 'raised' | 'interactive';
  padding?: 'none' | 'sm' | 'md' | 'lg';
  bordered?: boolean;
  children: React.ReactNode;
};
```

**States**

- default
- hover for interactive cards
- selected for interactive cards

**Required Storybook stories**

- Default
- Muted
- Raised
- Interactive
- Padding variants
- Dark theme

**Intentional improvements**

- Shared surface language across the system
- Reduced dependency on one-off panel styling

### 8. `Field`

**Purpose**

Wrapper that connects a label, a form control, helper text, and an error message.

**Current source examples**

- Repeated patterns across many tool settings blocks
- `ImageConverter.razor`
- `X509Tool.razor`

**Planned props**

```ts
type FieldProps = {
  label?: string;
  hint?: string;
  error?: string;
  required?: boolean;
  htmlFor?: string;
  children: React.ReactNode;
};
```

**States**

- default
- required
- invalid
- disabled via child control

**Required Storybook stories**

- With input
- With select
- With hint
- With error
- Required
- Dark theme

**Intentional improvements**

- Standardized form rhythm
- Cleaner error and help text placement

### 9. `PanelCard`

**Purpose**

Structured block for tool input, settings, or output sections.

**Current source examples**

- `WordCounter.razor`
- `ImageConverter.razor`
- `X509Tool.razor`

**Planned props**

```ts
type PanelCardProps = {
  title: string;
  description?: string;
  icon?: React.ReactNode;
  actions?: React.ReactNode;
  footer?: React.ReactNode;
  children: React.ReactNode;
  tone?: 'default' | 'accent' | 'success' | 'danger' | 'muted';
};
```

**States**

- default
- muted
- accent
- success
- danger

**Required Storybook stories**

- Basic
- With actions
- With footer
- Tone variants
- Dark theme

**Intentional improvements**

- Turn raw cards into repeatable tool-building blocks
- Make title, actions, and content hierarchy predictable

### 10. `FileDropZone`

**Purpose**

Drag-and-drop upload surface for image, document, and generic file workflows.

**Current source examples**

- `Components/Common/FileDropZone.razor`
- Image and PDF tools using file input patterns

**Planned props**

```ts
type FileDropZoneProps = {
  accept?: string;
  multiple?: boolean;
  disabled?: boolean;
  title?: string;
  description?: string;
  hint?: string;
  showPreview?: boolean;
  showFileInfo?: boolean;
  files?: File[];
  state?: 'idle' | 'dragOver' | 'selected' | 'invalid' | 'loading';
  onSelect?: (files: File[]) => void;
  onClear?: () => void;
};
```

**States**

- idle
- dragOver
- selected
- invalid
- loading

**Required Storybook stories**

- Idle
- Drag over
- Selected with file info
- Selected with preview
- Invalid
- Loading
- Disabled
- Dark theme

**Intentional improvements**

- Turn an important recurring pattern into a polished flagship component
- Improve state communication for drag, selected, and invalid flows

### 11. `ToolPageLayout`

**Purpose**

Shared page shell for individual tools.

**Current source examples**

- `ToolLayout.razor`

**Planned props**

```ts
type ToolPageLayoutProps = {
  title: string;
  description?: string;
  headerActions?: React.ReactNode;
  privacyNotice?: React.ReactNode;
  sidebar?: React.ReactNode;
  footer?: React.ReactNode;
  maxWidth?: 'wide' | 'content';
  children: React.ReactNode;
};
```

**States**

- single-column
- split layout
- with sidebar

**Required Storybook stories**

- Basic
- With privacy notice
- Split layout
- With sidebar
- Dark theme

**Intentional improvements**

- Move from hardcoded page shell to flexible layout system
- Preserve the repeated structure while allowing nicer composition later

### 12. `ToolPanel`

**Purpose**

Reusable tool section primitive for input, settings, and output groups.

**Current source examples**

- Repeated throughout tool pages
- `WordCounter.razor`
- `ImageConverter.razor`

**Planned props**

```ts
type ToolPanelProps = {
  title: string;
  subtitle?: string;
  actions?: React.ReactNode;
  status?: React.ReactNode;
  children: React.ReactNode;
  kind?: 'input' | 'settings' | 'output';
};
```

**States**

- input
- settings
- output
- with status block
- empty content

**Required Storybook stories**

- Input panel
- Settings panel
- Output panel
- With actions
- With status
- Dark theme

**Intentional improvements**

- Standard building block for future tool pages
- Better visual differentiation between editing and result surfaces

## Accessibility baseline

The first component wave should meet these minimum expectations:

- Every interactive control must have visible keyboard focus
- Icon-only controls require an accessible name
- Error states must not rely on color alone
- Form labels and descriptions must be semantically connected
- Drop zone must preserve keyboard file selection
- Disabled states must remain understandable in both themes

## Token guidance for implementation

Before scaling beyond `v0`, the implementation should stabilize a first token set covering:

- color roles: background, surface, border, text, muted, primary, success, warning, danger
- spacing scale
- radius scale
- shadow scale
- typography roles
- control heights
- focus ring rules

These tokens should drive components instead of page-specific CSS.

## Storybook rules for v0

Each component should include:

- one documentation story or MDX/Autodocs entry
- variant coverage
- disabled state
- dark theme example
- long-content or stress case when relevant
- a usage note describing when to use the component

## Recommended implementation order

To keep momentum and maximize reuse, build components in this order:

1. `Card`
2. `Button`
3. `IconButton`
4. `Input`
5. `Textarea`
6. `Select`
7. `Alert`
8. `Field`
9. `PanelCard`
10. `ToolPanel`
11. `FileDropZone`
12. `ToolPageLayout`

This order establishes the low-level visual system first and postpones larger composed blocks until the primitives are stable.

## Next Step

The next implementation step should create the actual workspace and start with:

- root package manager decision
- workspace setup for `packages/ui-kit` and `apps/storybook`
- shared theme and token scaffolding
- implementation of `Card`, `Button`, and `Input`
- first Storybook stories and theme switcher

That will provide the first usable slice of the new visual system without prematurely building page-specific components.
