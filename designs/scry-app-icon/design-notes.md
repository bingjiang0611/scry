# Scry App Icon Redesign

## Brief

Redesign the Scry macOS app icon as an original, production-ready symbol. Use current Apple first-party icons as a quality bar for hierarchy, material, depth, and small-size recognition—not as shapes to copy.

## Product signal to preserve

Scry is a local-first observability and governance workbench for AI coding agents. The icon should communicate:

1. **See** — inspect what is happening inside an agent turn.
2. **Trace** — reveal branching execution and tool activity.
3. **Control** — feel deliberate and professional, not mystical or ornamental.

## Existing icon diagnosis

Source: `scry/build/icon.png` (copied here as `reference-current.png`).

- The blue orb dominates while the trace mark is comparatively thin.
- At Dock and Spotlight sizes, the branching symbol loses contrast and identity.
- The outer black tile and inner floating orb create two competing silhouettes.
- The broad blue-on-black palette blends into many developer-tool icons.

## Reference observations

Locally inspected current macOS icons for Activity Monitor, Console, Shortcuts, Freeform, Passwords, and Xcode.

Shared principles used here:

- one dominant object or gesture;
- a clear silhouette inside the system squircle;
- strong figure/ground contrast at 16–32 px;
- material expressed with a few controlled highlights, not decorative noise;
- literal utility cues simplified into a memorable symbol.

No Apple artwork is copied or redistributed.

## Three directions

### A · Aperture Trace — recommended

A warm enamel tile carries a dark optical aperture. A thick mint trace branches inside the lens. The icon reads as “see the trace” in one glance and uses a warm palette to separate Scry from generic blue developer tools.

### B · Prism Relay

Three provider-colored signals enter a translucent prism and leave as one inspected beam. This direction emphasizes multi-provider normalization and governance. It is more expressive, but slightly more abstract at tiny sizes.

### C · Orbit Sentinel

A graphite instrument tile centers a luminous observation core with three governed nodes. It emphasizes monitoring and control. It is the most technical direction, but risks feeling like infrastructure rather than a personal desktop tool.

## Recommendation

Ship **A · Aperture Trace**. It has the strongest semantic compression, clearest small-size silhouette, and most differentiated Dock presence. Keep B and C as documented alternatives.

## Deliverables

- interactive HTML comparison board with light/dark and size previews;
- editable SVG masters for all three directions;
- 1024×1024 PNG previews for all three directions;
- final `icon.png` and `icon.icns` generated from A;
- final asset synchronized to `scry/build/` after verification.

## macOS delivery constraint

The final A master uses the same 824 px legacy-ICNS silhouette envelope as the previous shipped icon (`x/y = 100…924`), with a broad `rx=180` rounded-rectangle profile and no baked outer shadow. This prevents current macOS IconServices from treating the artwork as an irregular legacy glyph and adding a white compatibility backplate in the Dock.
