---
name: scss
description: SCSS architecture guide - colors, spacing, breakpoints, mixins, file structure. Load when working on styles or layout.
user-invocable: true
allowed-tools: Read, Grep, Glob
---

# SCSS Architecture Guide

## Color Palette

| Variable | Value | Usage |
|----------|-------|-------|
| `$color-1` | #0f0d23 | Deep Purple - backgrounds |
| `$color-2` | #252343 | Medium Purple - surfaces, borders |
| `$color-3` | #9b79b9 | Light Purple - accent (sparingly) |
| `$color-4` | #dc85ad | Pink - **interactive/clickable elements ONLY** |
| `$color-5` | #ede2da | Light Peach - text |
| `$color-6` | #7dd87d | Soft Mint Green - status indicators |

Semantic: `$color-success`, `$color-warning`, `$color-red`, `$color-info`, `$color-bitcoin-orange`

## Spacing

All spacing derives from `$gap: 1rem` (16px):
- Half: `calc($gap / 2)`
- Double: `$gap * 2`
- Never use raw px values for spacing.

## Border Radius

`$radius-sm` (2px), `$radius-base` (4px), `$radius-md` (6px), `$radius-lg` (8px), `$radius-full` (pill)

## Breakpoints (Mobile-First)

Base = Phone (0-639px), then additive min-width queries. **No "down"-Mixins!**

| Name | Range | Mixin | Grid |
|------|-------|-------|------|
| phone | 0-639px | (Base) | 1-column, Sidebar=Drawer |
| tablet | 640px+ | `@include tablet` | 2-column |
| tablet-big | 768px+ | `@include tablet-big` | 2-column, more space |
| desktop | 1024px+ | `@include desktop` | 3-column possible |

```scss
.element {
  width: 100%;           // Phone (Base)
  @include tablet { width: 50%; }
  @include desktop { width: 33%; }
}
```

## Layout System

**LayoutService** modes: `default` | `right-pane` | `wide` | `phone`
Classes on `<html>`: `layout--default`, `layout--wide`, `layout--phone`, etc.

Layout-specific styles go in the component's own file:
```scss
.element {
  // Base (all modes)
  .layout--wide & { ... }
  .layout--phone & { ... }
}
```

**3-Column Layout:** `.sidebar` (sbc), `.primary-content` (pcc), `.secondary-content` (scc)

## Available Mixins (`_mixins.scss`)

- **Responsive:** `@include tablet`, `@include tablet-big`, `@include desktop`
- **Flex:** `@include flex-center`, `@include flex-between`, `@include flex-column`
- **Typography:** `@include text-truncate`, `@include text-truncate-lines($n)`, `@include heading-base`
- **Cards:** `@include card-base`, `@include card-interactive`
- **Scrollbar:** `@include custom-scrollbar`

## Shadows & Transitions

- `$box-shadow`, `$box-hover`, `$overlay-bg`, `$text-glow`, `$surface-tint`
- `$transition-fast` (150ms), `$transition-all` (250ms), `$transition-colors`

## File Structure

```
src/styles/
├── abstracts/     _variables, _mixins, _utilities
├── base/          _reset, _base, _fonts, _typography, _icons, _screensize
├── atoms/         _badges, _links, _profile-pic, _hashtag, _grids, ...
├── molecules/     _tabs, _cards, _forms, _navigation, _lists, _media, ...
├── organisms/     _sidebar, _note-header, _note-header-responsive, _note-menu
├── components/    ~50 view-specific files (_timeline, _profile-view, _modal, ...)
├── templates/     _main-layout
└── main.scss      Entry point
```

## Rules

- Reuse existing patterns in Atoms/Molecules before creating new styles. Ask before introducing new ones.
- No browser dialogs — use Modal Helper
- No deprecated SASS — use `color.adjust()` instead of `darken()`/`lighten()`
- No raw `px` for spacing — use `$gap`-based values
- No TODOs in SCSS
