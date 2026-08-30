# Scry Website — Design Notes

## Confirmed brief

- Deliverable: independent responsive HTML prototype in `scry/designs/scry-website/`
- Primary audience: open-source developer community
- Primary action: view the source on GitHub
- Visual direction: Apple product storytelling × Linear product precision
- Exploration: two switchable hero compositions inside one complete page
- Design system: none available; Scry’s shipped UI, app icon, renderer tokens, README, and local screenshots are the brand ground truth

## Product truth used

Scry is a local-first, MIT-licensed desktop app for observing and governing AI coding agents. It drives local provider CLIs and presents conversations, tool calls, file footprints, usage, diagnostics, and trust surfaces. Current adapters cover Claude, Codex, Qoder, OpenCode, and Pi. The website deliberately states that Scry is **not a security sandbox**.

## Visual system

- **Aperture dark:** near-black product-stage surfaces from the current renderer (`#07090d`, `#0b0f15`)
- **Signal colors:** orange from the app icon; mint, blue, and coral from Scry’s existing trace/status tokens
- **Typography:** native Apple/SF stack with compact monospace evidence labels
- **Composition:** Apple-like scale and whitespace; Linear-like hairlines, figure labels, and product evidence
- **Product surfaces:** real Scry component probes rendered as live HTML/CSS—no raster screenshots, invented dashboards, metrics, testimonials, or community counts

## Hero variants

1. **A — Aperture:** centered, cinematic product reveal; strongest Apple-product-page influence.
2. **B — Evidence Grid:** split editorial layout with trace metadata; stronger Linear/open-source tooling influence.

The rest of the page remains identical so the hero decision is isolated.
