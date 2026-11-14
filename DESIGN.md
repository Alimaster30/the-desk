---
name: Desk
description: A warm operational workspace for calls, messages and order confirmations.
colors:
  paper: "#f8f7f4"
  sheet: "#fff"
  ink: "#292c29"
  muted: "#6c706b"
  rule: "#e6e5df"
  call: "#333d35"
  stop: "#a83c32"
  focus: "#497a65"
typography:
  headline:
    fontFamily: "Instrument Serif, Georgia, serif"
    fontSize: "44px"
    fontWeight: 400
    lineHeight: 1.12
    letterSpacing: "-.025em"
  title:
    fontFamily: "DM Sans, Segoe UI, sans-serif"
    fontSize: "17px"
    fontWeight: 600
    lineHeight: 1.35
    letterSpacing: "-.02em"
  body:
    fontFamily: "DM Sans, Segoe UI, sans-serif"
    fontSize: "14px"
    lineHeight: 1.55
  label:
    fontFamily: "DM Sans, Segoe UI, sans-serif"
    fontSize: "13px"
    fontWeight: 550
rounded:
  field: "10px"
  control: "11px"
  compact: "12px"
  radius: "16px"
  pill: "20px"
spacing:
  inline: "8px"
  compact: "12px"
  group: "16px"
  space: "24px"
components:
  button-primary:
    backgroundColor: "{colors.call}"
    textColor: "{colors.sheet}"
    rounded: "{rounded.control}"
    padding: "9px 16px"
  button-secondary:
    backgroundColor: "{colors.sheet}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "9px 16px"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "9px 16px"
  button-stop:
    textColor: "{colors.stop}"
    rounded: "{rounded.control}"
    padding: "9px 16px"
  field:
    backgroundColor: "{colors.sheet}"
    textColor: "{colors.ink}"
    rounded: "{rounded.field}"
    padding: "10px 12px"
  panel:
    backgroundColor: "{colors.sheet}"
    rounded: "{rounded.radius}"
    padding: "{spacing.space}"
---

# Design System: Desk

## Overview

**Creative North Star: "The Warm Workspace"**

Desk pairs a charcoal application frame with an inset warm paper task surface. The user's Nomi workspace screenshot establishes that contrast and the serif title treatment; the supplied Figma liquid glass reference appears as restrained translucent highlights in navigation and toolbar controls.

The interface is calm and compact enough for operational records. Opaque forms, tables and conversation surfaces keep real content legible. This is a record of the implemented system in `web/src/styles.css` and shared UI components, refreshed from the provisional direction within the same authorized redesign.

**Key Characteristics:**
- Warm paper and charcoal framing.
- Serif page titles with compact sans-serif controls.
- Fine borders, rounded surfaces and restrained chrome highlights.
- Real states, visible keyboard focus and responsive task surfaces.

## Colors

Warm neutrals dominate; forest green anchors actions and soft green surfaces convey ready or successful states. The normative shared color values are in the frontmatter.

### Primary
- **Forest action** (`call`): primary actions and authentication submission.
- **Sage focus** (`focus`): visible keyboard outlines and input caret.

### Secondary
- **Brick stop** (`stop`): stop actions and validation error text. Pending status uses warm amber surfaces; rejected or cancelled status uses pale brick surfaces. These status treatments accompany readable labels.

### Neutral
- **Warm paper** (`paper`): the main workspace and authentication card.
- **White sheet** (`sheet`): forms, tables and panels.
- **Charcoal ink** (`ink`): primary text.
- **Quiet grey** (`muted`): supporting text and metadata.
- **Warm rule** (`rule`): panel boundaries, table and section dividers.

### Named Rules
**The Readable Task Rule.** Use opaque white or warm paper beneath forms and records; keep translucent highlights in application chrome and controls.

## Typography

**Display Font:** Instrument Serif with Georgia and serif fallbacks.
**Body Font:** DM Sans with Segoe UI and sans-serif fallbacks.

**Character:** Self-hosted serif titles give the workspace an editorial entry point; the sans-serif keeps records and actions compact. Both fonts ship with OFL licenses.

### Hierarchy
- **Headline:** the frontmatter headline role is the desktop page title; it reduces to (36px) on small screens. Authentication titles use (37px), reducing to (32px).
- **Title:** the frontmatter title role introduces sections. Smaller subsection titles use (14px, weight 600).
- **Body:** the frontmatter body role is the application baseline; supporting paragraphs and controls frequently use (12–13px).
- **Label:** the frontmatter label role is used for visible field labels. Metadata and status labels use (10–12px) according to density.
- **Numeric summary:** balance figures use (29px, weight 450, line-height 1.2), decreasing on narrower screens. Tables and numeric summaries use tabular figures.

### Named Rules
**The Two Voices Rule.** Use Instrument Serif for page and brand display, and DM Sans for operational content, controls and data.

## Layout

The desktop application is a viewport-height grid with a persistent (236px) sidebar and an independently scrolling workspace. It sits within a (14px) outer margin; the task container is capped at (1200px) with desktop padding (42px 46px 64px). The normal rhythm uses the frontmatter spacing steps for inline actions, groups and panels.

At (1400px) and above the sidebar grows to (250px). At (1100px) and below it becomes (210px), content padding tightens and the two-column dashboard stacks. At (760px) and below the shell uses a (6px) margin and a button-controlled (250px) navigation drawer; forms and the conversation split stack. The hidden drawer is inert, closes on route changes or Escape, and has an explicit close control. The main content uses (26px 19px 45px) padding. A further (360px) adjustment reduces inline spacing.

Tables scroll inside their own bordered surface. Number inventory uses an auto-filling grid with a minimum card width (220px). Page descriptions are limited to (62ch); explanatory notes can reach (75ch).

## Elevation & Depth

Depth comes from a charcoal frame, tonal separation, fine borders and soft highlights. The toolbar uses a translucent white surface with backdrop blur (18px); selected navigation has a white alpha fill and an inset highlight. Data panels stay flat at rest.

### Shadow Vocabulary
- **Application frame** (`0 12px 40px #3b35351c`): ambient lift around the shell.
- **Selected navigation** (`inset 0 1px 0 #ffffff0b`): a small internal light edge.
- **Role control** (`0 1px 3px #373f3510`): restrained control lift.
- **Field focus** (`0 0 0 3px #e6ede5`): supporting ring around a focused field.

### Named Rules
**The Quiet Depth Rule.** Keep panels flat and use soft shadows or inset highlights for the frame, navigation and interaction states.

## Shapes

Shared panels use the frontmatter radius token; fields and buttons use their smaller dedicated radii. Status badges are pill-shaped. The outer frame uses (24px) corners around a (21px) inner workspace; the mobile frame and workspace use (19px). Fine single-pixel borders define white content surfaces. Shared icons are inline SVG line drawings, typically (19px), with rounded caps and joins at stroke width (1.6).

## Components

### Buttons
Compact rounded controls with visible interaction states. The base button has minimum height (42px), white background and a fine border; primary actions use forest action with white text. Hover shifts the base surface to pale grey-green and primary to a lighter forest. Pressing moves a button down (1px); disabled buttons reduce opacity to (.48) and stop moving. Ghost buttons have transparent backgrounds; stop buttons combine brick text with pale brick fill and border. Keyboard focus uses a (2px) sage outline offset by (4px). Mobile base buttons reach a minimum (44px), while compact controls retain component-specific sizing.

### Chips
Small noninteractive status badges use a pale green surface, green text, a pill silhouette and (11px) type. Pending/review and rejected/cancelled variants change surface and text color together. Filter tabs are interactive buttons in a soft grey-green tray; the selected tab is white with a small soft shadow.

### Cards / Containers
White panels, number cards, order cards, dial forms and tables share fine warm borders and the panel radius. Standard panel padding follows the space token. Empty states use a dashed border, muted icon tile, short heading and constrained explanatory text.

### Inputs / Fields
Opaque white fields use the field radius and padding, with minimum height (44px). Visible labels sit above fields. Focus changes the border to muted green and adds the pale green focus ring; invalid authentication fields pair their state with associated error text. Search fields retain visible labels and use an inline SVG at the leading edge.

### Navigation
Desktop navigation lives in the charcoal sidebar with compact sans-serif labels and inline line icons. Hover adds a faint white surface; the active route adds a brighter translucent surface, white text, an inset highlight and a small green dot. The account footer remains below the route groups. Admin-only workspace navigation remains role-restricted. Mobile navigation uses the drawer behavior described in Layout.

### Conversation and record surfaces
Conversation messages use soft neutral incoming bubbles and pale green outgoing bubbles, with asymmetric bottom corners and compact sender/time metadata. Records use tabular numbers, quiet table headers and fine row rules; hover adds a faint tonal wash. Native disclosure summaries reveal order details and reply settings without decorative modal layers.

## Do's and Don'ts

### Do:
- **Do** use the shared white panels and warm paper workspace for readable task content.
- **Do** retain visible keyboard focus, meaningful state labels and SVG line icons.
- **Do** keep numeric records tabular and wide tables inside scrolling containers.
- **Do** respect reduced motion: transitions and animations are disabled by the existing preference query.
- **Do** preserve role-restricted navigation and truthful loading, empty and failure states.

### Don't:
- **Don't** spread glass effects across data surfaces or forms.
- **Don't** replace the compact mobile drawer with a full sidebar above the task.
- **Don't** add decorative activity, fabricated data or nonfunctional controls copied from visual references.
- **Don't** communicate status through color alone.
