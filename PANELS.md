# Panel & surface names

A shared vocabulary for the app's UI surfaces, so design feedback is unambiguous.
Each row gives the **name** to use in conversation, what it is, and the code
anchor (CSS class / element id / file) to find it.

Rename anything here freely — it's a communication aid. Keep it in sync when
surfaces are added or restructured.

## The Detail Panel

The whole sheet that opens when you tap a venue (`#detail-panel`). Note: in code
`updatePopup()` just opens this — so "marker popup" = the Detail Panel.
Its parts, top to bottom:

| Name | What it is | Code |
|------|-----------|------|
| **Hero** | The photo header (title + rating/area on the image) | `.detail-new-photos` |
| **Sun card** | "Solforhold" — big "X igjen" + event pills + timeline | `.dp-card` |
| **Venner zone** | The whole friends/plans section | `.dp-social-zone` |
| **Plan card** | Empty-state composer: "Inviter venner hit" + date chip + share bubble + Send | `.dp-composer` |
| **Here-now card** | "X er her nå" (friends currently checked in) | `.dp-here-card` |
| **Plan rows** | Existing plans for the venue | `.dp-plan-card` |
| **Action row** | Directions (honey CTA) + Share / Favorite / Alert | `.dp-actions` |
| **Info card** | Address, hours, busyness, noise, wind | `.dp-info-card` |

## The When picker

The date/time editor that grows up inside the Detail Panel when you tap the
date chip. `body.nar-mode` collapses the panel to handle + Plan card, then the
picker grows up from the bottom.

| Name | What it is | Code |
|------|-----------|------|
| **Date chip** | The "I morgen · 15:30 ⌄" button that opens the picker | `.dp-composer-when` |
| **When picker** | The whole section that grows up (card + CTAs) | `.nar-picker` |
| **Picker card** | "Velg dag og tidspunkt" cream box | `.nar-card` |
| **Day strip** | The scrollable day tiles | `.nar-strip` / `.dc-tile` |
| **Time bar** | The sun/shade scrubber (the reparented Time slider) | `#fts` |
| **Send button** | Navy "Send til venner" | `.nar-send` |

## Plan card states: Resting vs Active

The **Plan card** (and its **Date chip**) renders in two states, switched by the
`body.nar-mode` class (off → Resting, on → Active):

| | **Resting** (Detail Panel, picker closed) | **Active** (When picker open) |
|---|---|---|
| Plan card bg | Cream-frost | Top-bar control glass (`--btn-glass-*`) |
| Date chip | Cream pill **with chevron** — looks like a button | Plain label — no bg, no border, no chevron |
| Meaning | "Tap to set the day/time" | "You're editing it below" |

So you can say *"the Resting chip"* or *"the Active card bg"* and it's unambiguous.

## App-wide surfaces

| Name | What it is | Code |
|------|-----------|------|
| **Venue list** | The scrollable list of venue cards | `#panel` |
| **Top bar** | Date / weather / account / search strip up top | `#top-strip` |
| **Time slider** (FTS) | The floating time scrubber (its home is the Venue list) | `#fts` |
| **Calendar** | The standalone date picker (top-bar date tap) | `#qc-cal` |
| **Invite sheet** | The select-friends + share flow (where "Send til venner" hands off) | `#invite-sheet` |
| **Plan preview** | The invite-link recipient / accept flow | `js/ui-plan-preview.js` |
| **Bell / inbox** | Notifications dropdown | `js/auth.js` (bell dropdown) |

## Distinctions worth keeping straight

- **Plan card** = the composer summary (with the share bubble). **When picker**
  = the whole growing editor. **Picker card** = just the cream box inside it.
- **Sun card** (Solforhold) vs **Picker card** (Velg dag og tidspunkt): both are
  cream-frost boxes in the Detail Panel, but one shows the sun verdict and one
  edits the plan moment.
- **Time bar** and **Time slider** are the same element (`#fts`) in two homes:
  reparented into the When picker, vs. its default home in the Venue list.
