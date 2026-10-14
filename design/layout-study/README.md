# Layout study

Static reference for the nine layouts: three for each appearance, each drawn on
the sign-in, repository list, code, pull request and settings pages with example
data. Open `index.html` (after `npm --prefix web ci`, which provides the fonts)
and use the bar at the top to switch layout, page and color mode.

Primer (Classic A), Tiles (Golf C) and Console (Flare C) are implemented to this
study; `web/tests/layout-presets.spec.ts` asserts their structure. The other six
layouts are selectable but follow the study only in where navigation and panes sit.

The study invents data the product does not load: check and commit totals, a
latest release, watch counts, a language filter and an activity feed. Those are
not implemented.
