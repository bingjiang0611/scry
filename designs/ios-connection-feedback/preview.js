"use strict";
(() => {
  // designs/scry-ios-remote/design-canvas-v5.jsx
  var DC = {
    bg: "#f0eee9",
    grid: "rgba(0,0,0,0.06)",
    label: "rgba(60,50,40,0.7)",
    title: "rgba(40,30,20,0.85)",
    subtitle: "rgba(60,50,40,0.6)",
    postitBg: "#fef4a8",
    postitText: "#5a4a2a",
    font: '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif'
  };
  if (typeof document !== "undefined" && !document.getElementById("dc-styles")) {
    const s = document.createElement("style");
    s.id = "dc-styles";
    s.textContent = [
      ".dc-editable{cursor:text;outline:none;white-space:nowrap;border-radius:3px;padding:0 2px;margin:0 -2px}",
      ".dc-editable:focus{background:#fff;box-shadow:0 0 0 1.5px #c96442}",
      "[data-dc-slot]{transition:transform .18s cubic-bezier(.2,.7,.3,1)}",
      "[data-dc-slot].dc-dragging{transition:none;z-index:10;pointer-events:none}",
      "[data-dc-slot].dc-dragging .dc-card{box-shadow:0 12px 40px rgba(0,0,0,.25),0 0 0 2px #c96442;transform:scale(1.02)}",
      // isolation:isolate contains artboard content's z-indexes so a
      // z-indexed child (sticky navbar etc.) can't paint over .dc-header or
      // the .dc-menu popover that drops into the top of the card.
      ".dc-card{isolation:isolate;transition:box-shadow .15s,transform .15s}",
      ".dc-card *{scrollbar-width:none}",
      ".dc-card *::-webkit-scrollbar{display:none}",
      // Per-artboard header: grip + label on the left, delete/expand on the
      // right. Single flex row; when the artboard's on-screen width is too
      // narrow for both the label yields (ellipsis, then hidden entirely below
      // ~4ch via the container query) and the buttons stay on the row.
      ".dc-header{position:absolute;bottom:100%;left:-4px;margin-bottom:calc(4px * var(--dc-inv-zoom,1));z-index:2;",
      "  display:flex;align-items:center;container-type:inline-size}",
      ".dc-labelrow{display:flex;align-items:center;gap:4px;height:24px;flex:1 1 auto;min-width:0}",
      ".dc-grip{flex:0 0 auto;cursor:grab;display:flex;align-items:center;padding:5px 4px;border-radius:4px;transition:background .12s,opacity .12s}",
      ".dc-grip:hover{background:rgba(0,0,0,.08)}",
      ".dc-grip:active{cursor:grabbing}",
      ".dc-labeltext{flex:1 1 auto;min-width:0;cursor:pointer;border-radius:4px;padding:3px 6px;",
      "  display:flex;align-items:center;transition:background .12s;overflow:hidden}",
      // Below ~4ch of label room: hide the label entirely, and drop the grip to
      // hover-only (same reveal rule as .dc-btns) so a narrow header is clean
      // until the card is moused.
      "@container (max-width: 110px){",
      "  .dc-labeltext{display:none}",
      "  .dc-grip{opacity:0}",
      "  [data-dc-slot]:hover .dc-grip{opacity:1}",
      "}",
      ".dc-labeltext:hover{background:rgba(0,0,0,.05)}",
      ".dc-labeltext .dc-editable{overflow:hidden;text-overflow:ellipsis;max-width:100%}",
      ".dc-labeltext .dc-editable:focus{overflow:visible;text-overflow:clip}",
      ".dc-btns{flex:0 0 auto;margin-left:auto;display:flex;gap:2px;opacity:0;transition:opacity .12s}",
      "[data-dc-slot]:hover .dc-btns,.dc-btns:has(.dc-menu){opacity:1}",
      ".dc-expand,.dc-kebab{width:22px;height:22px;border-radius:5px;border:none;cursor:pointer;padding:0;",
      "  background:transparent;color:rgba(60,50,40,.7);display:flex;align-items:center;justify-content:center;",
      "  font:inherit;transition:background .12s,color .12s}",
      ".dc-expand:hover,.dc-kebab:hover{background:rgba(0,0,0,.06);color:#2a251f}",
      // Slot hosting an open menu floats above later siblings (which otherwise
      // paint on top — same z-index:auto, later DOM order) so the popup isn't
      // clipped by the next card.
      "[data-dc-slot]:has(.dc-menu){z-index:10}",
      ".dc-menu{position:absolute;top:100%;right:0;margin-top:4px;background:#fff;border-radius:8px;",
      "  box-shadow:0 8px 28px rgba(0,0,0,.18),0 0 0 1px rgba(0,0,0,.05);padding:4px;min-width:160px;z-index:10}",
      ".dc-menu button{display:block;width:100%;padding:7px 10px;border:0;background:transparent;",
      "  border-radius:5px;font-family:inherit;font-size:13px;font-weight:500;line-height:1.2;",
      "  color:#29261b;cursor:pointer;text-align:left;transition:background .12s;white-space:nowrap}",
      ".dc-menu button:hover{background:rgba(0,0,0,.05)}",
      ".dc-menu hr{border:0;border-top:1px solid rgba(0,0,0,.08);margin:4px 2px}",
      ".dc-menu .dc-danger{color:#c96442}",
      ".dc-menu .dc-danger:hover{background:rgba(201,100,66,.1)}",
      // Chrome (titles / labels / buttons) counter-scales against the viewport
      // zoom so it stays a constant on-screen size. --dc-inv-zoom is set by
      // DCViewport on every transform update and inherits to all descendants —
      // any overlay inside the world (e.g. a TweaksPanel on an artboard) can use
      // it the same way.
      //
      // The header uses transform:scale (out-of-flow, so layout impact doesn't
      // matter) with its world-space width set to card-width / inv-zoom so that
      // after counter-scaling its on-screen width exactly matches the card's —
      // that's what lets the container query + text-overflow behave against the
      // card's visible edge at every zoom level.
      //
      // The section head uses CSS zoom instead of transform so its layout box
      // grows with the counter-scale, pushing the card row down — otherwise the
      // constant-screen-size title would overflow into the (shrinking) world-
      // space gap and overlap the artboard headers at low zoom.
      ".dc-header{width:calc((100% + 4px) / var(--dc-inv-zoom,1));",
      "  transform:scale(var(--dc-inv-zoom,1));transform-origin:bottom left}",
      ".dc-sectionhead{zoom:var(--dc-inv-zoom,1)}"
    ].join("\n");
    document.head.appendChild(s);
  }
  var DCCtx = React.createContext(null);
  function dcFlatten(children) {
    const out = [];
    React.Children.forEach(children, (c) => {
      if (c && c.type === React.Fragment) out.push(...dcFlatten(c.props.children));
      else out.push(c);
    });
    return out;
  }
  var DC_STATE_FILE = ".design-canvas.state.json";
  function DesignCanvas({ children, minScale, maxScale, style }) {
    const [state, setState] = React.useState({ sections: {}, focus: null });
    const [ready, setReady] = React.useState(false);
    const didRead = React.useRef(false);
    const skipNextWrite = React.useRef(false);
    React.useEffect(() => {
      let off = false;
      fetch("./" + DC_STATE_FILE).then((r) => r.ok ? r.json() : null).then((saved) => {
        if (off || !saved || !saved.sections) return;
        skipNextWrite.current = true;
        setState((s) => ({ ...s, sections: saved.sections }));
      }).catch(() => {
      }).finally(() => {
        didRead.current = true;
        if (!off) setReady(true);
      });
      const t = setTimeout(() => {
        if (!off) setReady(true);
      }, 150);
      return () => {
        off = true;
        clearTimeout(t);
      };
    }, []);
    React.useEffect(() => {
      if (!didRead.current) return;
      if (skipNextWrite.current) {
        skipNextWrite.current = false;
        return;
      }
      const t = setTimeout(() => {
        window.omelette?.writeFile(DC_STATE_FILE, JSON.stringify({ sections: state.sections })).catch(() => {
        });
      }, 250);
      return () => clearTimeout(t);
    }, [state.sections]);
    const registry = {};
    const sectionMeta = {};
    const sectionOrder = [];
    dcFlatten(children).forEach((sec) => {
      if (!sec || sec.type !== DCSection) return;
      const sid = sec.props.id ?? sec.props.title;
      if (!sid) return;
      sectionOrder.push(sid);
      const persisted = state.sections[sid] || {};
      const abs = [];
      dcFlatten(sec.props.children).forEach((ab) => {
        if (!ab || ab.type !== DCArtboard) return;
        const aid = ab.props.id ?? ab.props.label;
        if (aid) abs.push([aid, ab]);
      });
      const srcKey = abs.map(([k]) => k).join("");
      const hidden = persisted.srcKey === srcKey ? persisted.hidden || [] : [];
      const srcIds = [];
      abs.forEach(([aid, ab]) => {
        if (hidden.includes(aid)) return;
        registry[`${sid}/${aid}`] = { sectionId: sid, artboard: ab };
        srcIds.push(aid);
      });
      const kept = (persisted.order || []).filter((k) => srcIds.includes(k));
      sectionMeta[sid] = {
        title: persisted.title ?? sec.props.title,
        subtitle: sec.props.subtitle,
        slotIds: [...kept, ...srcIds.filter((k) => !kept.includes(k))]
      };
    });
    const api = React.useMemo(() => ({
      state,
      section: (id) => state.sections[id] || {},
      patchSection: (id, p) => setState((s) => ({
        ...s,
        sections: { ...s.sections, [id]: { ...s.sections[id], ...typeof p === "function" ? p(s.sections[id] || {}) : p } }
      })),
      setFocus: (slotId) => setState((s) => ({ ...s, focus: slotId }))
    }), [state]);
    React.useEffect(() => {
      const onKey = (e) => {
        if (e.key === "Escape") api.setFocus(null);
      };
      const onPd = (e) => {
        const ae = document.activeElement;
        if (ae && ae.isContentEditable && !ae.contains(e.target)) ae.blur();
      };
      document.addEventListener("keydown", onKey);
      document.addEventListener("pointerdown", onPd, true);
      return () => {
        document.removeEventListener("keydown", onKey);
        document.removeEventListener("pointerdown", onPd, true);
      };
    }, [api]);
    return /* @__PURE__ */ React.createElement(DCCtx.Provider, { value: api }, /* @__PURE__ */ React.createElement(DCViewport, { minScale, maxScale, style }, ready && children), state.focus && registry[state.focus] && /* @__PURE__ */ React.createElement(DCFocusOverlay, { entry: registry[state.focus], sectionMeta, sectionOrder }));
  }
  function DCViewport({ children, minScale = 0.1, maxScale = 8, style = {} }) {
    const vpRef = React.useRef(null);
    const worldRef = React.useRef(null);
    const tf = React.useRef({ x: 0, y: 0, scale: 1 });
    const tfKey = "dc-viewport:" + location.pathname;
    const saveT = React.useRef(0);
    const lastPostedScale = React.useRef();
    const apply = React.useCallback(() => {
      const { x, y, scale } = tf.current;
      const el = worldRef.current;
      if (!el) return;
      el.style.transform = `translate3d(${x}px, ${y}px, 0) scale(${scale})`;
      el.style.setProperty("--dc-inv-zoom", String(1 / scale));
      if (lastPostedScale.current !== scale) {
        lastPostedScale.current = scale;
        window.parent.postMessage({ type: "__dc_zoom", scale }, "*");
      }
      clearTimeout(saveT.current);
      saveT.current = setTimeout(() => {
        try {
          localStorage.setItem(tfKey, JSON.stringify(tf.current));
        } catch {
        }
      }, 200);
    }, [tfKey]);
    React.useLayoutEffect(() => {
      const flush = () => {
        clearTimeout(saveT.current);
        try {
          localStorage.setItem(tfKey, JSON.stringify(tf.current));
        } catch {
        }
      };
      let restored = false;
      try {
        const s = JSON.parse(localStorage.getItem(tfKey) || "null");
        if (s && Number.isFinite(s.x) && Number.isFinite(s.y) && Number.isFinite(s.scale)) {
          tf.current = { x: s.x, y: s.y, scale: Math.min(maxScale, Math.max(minScale, s.scale)) };
          apply();
          restored = true;
        }
      } catch {
      }
      let checks = 0;
      let checkT = 0;
      let sawInput = false;
      let hiddenStreak = 0;
      const onInput = () => {
        sawInput = true;
      };
      const cleanupCheck = () => {
        window.removeEventListener("wheel", onInput, true);
        window.removeEventListener("pointerdown", onInput, true);
      };
      const checkVisible = () => {
        const vp = vpRef.current, world = worldRef.current;
        checks += 1;
        if (!vp || !world || sawInput || checks > 10) {
          cleanupCheck();
          return;
        }
        const vr = vp.getBoundingClientRect();
        let sized = 0, visible = false;
        world.querySelectorAll("[data-dc-slot], .dc-sectionhead .dc-editable").forEach((el) => {
          const r = el.getBoundingClientRect();
          if (r.width <= 0 || r.height <= 0) return;
          sized += 1;
          if (r.right > vr.left && r.left < vr.right && r.bottom > vr.top && r.top < vr.bottom) visible = true;
        });
        if (visible) {
          cleanupCheck();
          return;
        }
        if (sized === 0) {
          hiddenStreak = 0;
          checkT = setTimeout(checkVisible, 400);
          return;
        }
        hiddenStreak += 1;
        if (hiddenStreak < 2) {
          checkT = setTimeout(checkVisible, 400);
          return;
        }
        tf.current = { x: 0, y: 0, scale: 1 };
        apply();
        cleanupCheck();
      };
      if (restored) {
        window.addEventListener("wheel", onInput, true);
        window.addEventListener("pointerdown", onInput, true);
        checkT = setTimeout(checkVisible, 250);
      }
      window.addEventListener("pagehide", flush);
      return () => {
        clearTimeout(checkT);
        cleanupCheck();
        window.removeEventListener("pagehide", flush);
        flush();
      };
    }, []);
    React.useEffect(() => {
      const vp = vpRef.current;
      if (!vp) return;
      const zoomAt = (cx, cy, factor) => {
        const r = vp.getBoundingClientRect();
        const px = cx - r.left, py = cy - r.top;
        const t = tf.current;
        const next = Math.min(maxScale, Math.max(minScale, t.scale * factor));
        const k = next / t.scale;
        let marker = null, markerY0 = 0;
        if (k !== 1) {
          const hit = document.elementFromPoint(cx, cy);
          marker = hit && hit.closest ? hit.closest("[data-dc-slot],[data-dc-section],.dc-postit") : null;
          if (marker) markerY0 = marker.getBoundingClientRect().top;
        }
        t.x = px - (px - t.x) * k;
        t.y = py - (py - t.y) * k;
        t.scale = next;
        apply();
        if (marker) {
          const drift = marker.getBoundingClientRect().top - (cy + (markerY0 - cy) * k);
          if (Math.abs(drift) > 0.1) {
            t.y -= drift;
            apply();
          }
        }
      };
      const isMouseWheel = (e) => e.deltaMode !== 0 || e.deltaX === 0 && Number.isInteger(e.deltaY) && Math.abs(e.deltaY) >= 40;
      const onWheel = (e) => {
        if (!(e.ctrlKey || e.metaKey) && e.target && e.target.closest && e.target.closest("deck-stage")) return;
        e.preventDefault();
        if (isGesturing) return;
        if ((e.ctrlKey || e.metaKey) && !isMouseWheel(e)) {
          zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.01));
        } else if (isMouseWheel(e)) {
          zoomAt(e.clientX, e.clientY, Math.exp(-Math.sign(e.deltaY) * 0.18));
        } else {
          tf.current.x -= e.deltaX;
          tf.current.y -= e.deltaY;
          apply();
        }
      };
      let gsBase = 1;
      let isGesturing = false;
      const onGestureStart = (e) => {
        e.preventDefault();
        isGesturing = true;
        gsBase = tf.current.scale;
      };
      const onGestureChange = (e) => {
        e.preventDefault();
        zoomAt(e.clientX, e.clientY, gsBase * e.scale / tf.current.scale);
      };
      const onGestureEnd = (e) => {
        e.preventDefault();
        isGesturing = false;
      };
      let drag = null;
      const onPointerDown = (e) => {
        const onBg = !e.target.closest("[data-dc-slot], .dc-editable, .dc-postit");
        if (!(e.button === 1 || e.button === 0 && onBg)) return;
        e.preventDefault();
        vp.setPointerCapture(e.pointerId);
        drag = { id: e.pointerId, lx: e.clientX, ly: e.clientY };
        vp.style.cursor = "grabbing";
      };
      const onPointerMove = (e) => {
        if (!drag || e.pointerId !== drag.id) return;
        tf.current.x += e.clientX - drag.lx;
        tf.current.y += e.clientY - drag.ly;
        drag.lx = e.clientX;
        drag.ly = e.clientY;
        apply();
      };
      const onPointerUp = (e) => {
        if (!drag || e.pointerId !== drag.id) return;
        vp.releasePointerCapture(e.pointerId);
        drag = null;
        vp.style.cursor = "";
      };
      const onHostMsg = (e) => {
        const d = e.data;
        if (d && d.type === "__dc_set_zoom" && typeof d.scale === "number") {
          const r = vp.getBoundingClientRect();
          zoomAt(r.left + r.width / 2, r.top + r.height / 2, d.scale / tf.current.scale);
        } else if (d && d.type === "__dc_probe") {
          window.parent.postMessage({ type: "__dc_present" }, "*");
          lastPostedScale.current = void 0;
          apply();
        }
      };
      window.addEventListener("message", onHostMsg);
      window.parent.postMessage({ type: "__dc_present" }, "*");
      lastPostedScale.current = void 0;
      apply();
      vp.addEventListener("wheel", onWheel, { passive: false });
      vp.addEventListener("gesturestart", onGestureStart, { passive: false });
      vp.addEventListener("gesturechange", onGestureChange, { passive: false });
      vp.addEventListener("gestureend", onGestureEnd, { passive: false });
      vp.addEventListener("pointerdown", onPointerDown);
      vp.addEventListener("pointermove", onPointerMove);
      vp.addEventListener("pointerup", onPointerUp);
      vp.addEventListener("pointercancel", onPointerUp);
      return () => {
        window.removeEventListener("message", onHostMsg);
        vp.removeEventListener("wheel", onWheel);
        vp.removeEventListener("gesturestart", onGestureStart);
        vp.removeEventListener("gesturechange", onGestureChange);
        vp.removeEventListener("gestureend", onGestureEnd);
        vp.removeEventListener("pointerdown", onPointerDown);
        vp.removeEventListener("pointermove", onPointerMove);
        vp.removeEventListener("pointerup", onPointerUp);
        vp.removeEventListener("pointercancel", onPointerUp);
      };
    }, [apply, minScale, maxScale]);
    const gridSvg = `url("data:image/svg+xml,%3Csvg width='120' height='120' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath d='M120 0H0v120' fill='none' stroke='${encodeURIComponent(DC.grid)}' stroke-width='1'/%3E%3C/svg%3E")`;
    return (
      // data-om-starter: inert presence marker — Claude Design's starter-usage
      // probe reads it; it renders nothing. Keep it on this root element.
      /* @__PURE__ */ React.createElement(
        "div",
        {
          ref: vpRef,
          "data-om-starter": "design-canvas",
          className: "design-canvas",
          style: {
            height: "100vh",
            width: "100vw",
            background: DC.bg,
            overflow: "hidden",
            overscrollBehavior: "none",
            touchAction: "none",
            position: "relative",
            fontFamily: DC.font,
            boxSizing: "border-box",
            ...style
          }
        },
        /* @__PURE__ */ React.createElement(
          "div",
          {
            ref: worldRef,
            style: {
              position: "absolute",
              top: 0,
              left: 0,
              transformOrigin: "0 0",
              willChange: "transform",
              width: "max-content",
              minWidth: "100%",
              minHeight: "100%",
              padding: "60px 0 80px"
            }
          },
          /* @__PURE__ */ React.createElement("div", { style: { position: "absolute", inset: -6e3, backgroundImage: gridSvg, backgroundSize: "120px 120px", pointerEvents: "none", zIndex: -1 } }),
          children
        )
      )
    );
  }
  function DCSection({ id, title, subtitle, children, gap = 48 }) {
    const ctx = React.useContext(DCCtx);
    const sid = id ?? title;
    const all = React.Children.toArray(dcFlatten(children));
    const artboards = all.filter((c) => c && c.type === DCArtboard);
    const rest = all.filter((c) => !(c && c.type === DCArtboard));
    const sec = ctx && sid && ctx.section(sid) || {};
    const allIds = artboards.map((a) => a.props.id ?? a.props.label).filter(Boolean);
    const srcKey = allIds.join("");
    const hidden = sec.srcKey === srcKey ? sec.hidden || [] : [];
    const srcOrder = allIds.filter((k) => !hidden.includes(k));
    const order = React.useMemo(() => {
      const kept = (sec.order || []).filter((k) => srcOrder.includes(k));
      return [...kept, ...srcOrder.filter((k) => !kept.includes(k))];
    }, [sec.order, srcOrder.join("|")]);
    const byId = Object.fromEntries(artboards.map((a) => [a.props.id ?? a.props.label, a]));
    return /* @__PURE__ */ React.createElement(
      "div",
      {
        "data-dc-section": sid,
        style: { marginBottom: "calc(80px * var(--dc-inv-zoom, 1))", position: "relative" }
      },
      /* @__PURE__ */ React.createElement("div", { style: { padding: "0 60px" } }, /* @__PURE__ */ React.createElement("div", { className: "dc-sectionhead", style: { paddingBottom: 36 } }, /* @__PURE__ */ React.createElement(
        DCEditable,
        {
          tag: "div",
          value: sec.title ?? title,
          onChange: (v) => ctx && sid && ctx.patchSection(sid, { title: v }),
          style: { fontSize: 28, fontWeight: 600, color: DC.title, letterSpacing: -0.4, marginBottom: 6, display: "inline-block" }
        }
      ), subtitle && /* @__PURE__ */ React.createElement("div", { style: { fontSize: 16, color: DC.subtitle } }, subtitle))),
      /* @__PURE__ */ React.createElement("div", { style: { display: "flex", gap, padding: "0 60px", alignItems: "flex-start", width: "max-content" } }, order.map((k) => /* @__PURE__ */ React.createElement(
        DCArtboardFrame,
        {
          key: k,
          sectionId: sid,
          artboard: byId[k],
          order,
          label: (sec.labels || {})[k] ?? byId[k].props.label,
          onRename: (v) => ctx && ctx.patchSection(sid, (x) => ({ labels: { ...x.labels, [k]: v } })),
          onReorder: (next) => ctx && ctx.patchSection(sid, { order: next }),
          onDelete: () => ctx && ctx.patchSection(sid, (x) => ({
            hidden: [...x.srcKey === srcKey ? x.hidden || [] : [], k],
            srcKey
          })),
          onFocus: () => ctx && ctx.setFocus(`${sid}/${k}`)
        }
      ))),
      rest
    );
  }
  function DCArtboard() {
    return null;
  }
  async function dcExport(node, w, h, name, kind) {
    try {
      await document.fonts.ready;
    } catch {
    }
    const toDataURL = (url) => fetch(url).then((r) => r.blob()).then((b) => new Promise((res) => {
      const fr = new FileReader();
      fr.onload = () => res(fr.result);
      fr.onerror = () => res(url);
      fr.readAsDataURL(b);
    })).catch(() => url);
    const fontRules = [], pending = [], seen = /* @__PURE__ */ new Set();
    const scrapeCss = (href) => {
      if (seen.has(href)) return;
      seen.add(href);
      pending.push(fetch(href).then((r) => r.text()).then((css) => {
        for (const m of css.match(/@font-face\s*{[^}]*}/g) || []) fontRules.push({ css: m, base: href });
        for (const m of css.matchAll(/@import\s+(?:url\()?['"]?([^'")\s;]+)/g))
          scrapeCss(new URL(m[1], href).href);
      }).catch(() => {
      }));
    };
    const walk = (rules, base) => {
      for (const r of rules) {
        if (r.type === CSSRule.FONT_FACE_RULE) fontRules.push({ css: r.cssText, base });
        else if (r.type === CSSRule.IMPORT_RULE && r.styleSheet) {
          const ibase = r.styleSheet.href || base;
          try {
            walk(r.styleSheet.cssRules, ibase);
          } catch {
            scrapeCss(ibase);
          }
        } else if (r.cssRules) walk(r.cssRules, base);
      }
    };
    for (const ss of document.styleSheets) {
      const base = ss.href || location.href;
      try {
        walk(ss.cssRules, base);
      } catch {
        if (ss.href) scrapeCss(ss.href);
      }
    }
    while (pending.length) await pending.shift();
    const fontCss = (await Promise.all(fontRules.map(async (rule) => {
      let out = rule.css, m;
      const re = /url\((['"]?)([^'")]+)\1\)/g;
      while (m = re.exec(rule.css)) {
        if (m[2].indexOf("data:") === 0) continue;
        let abs;
        try {
          abs = new URL(m[2], rule.base).href;
        } catch {
          continue;
        }
        out = out.split(m[0]).join('url("' + await toDataURL(abs) + '")');
      }
      return out;
    }))).join("\n");
    const cloneStyled = (src) => {
      if (src.nodeType === 8 || src.nodeType === 1 && src.tagName === "SCRIPT") return document.createTextNode("");
      const dst = src.cloneNode(false);
      if (src.nodeType === 1) {
        const cs = getComputedStyle(src);
        let txt = "";
        for (let i = 0; i < cs.length; i++) txt += cs[i] + ":" + cs.getPropertyValue(cs[i]) + ";";
        dst.setAttribute("style", txt + "animation:none;transition:none;");
        if (src.tagName === "CANVAS") try {
          const im = document.createElement("img");
          im.src = src.toDataURL();
          im.setAttribute("style", txt);
          return im;
        } catch {
        }
      }
      for (let c = src.firstChild; c; c = c.nextSibling) dst.appendChild(cloneStyled(c));
      return dst;
    };
    const clone = cloneStyled(node);
    clone.setAttribute("xmlns", "http://www.w3.org/1999/xhtml");
    clone.style.boxShadow = "none";
    clone.style.borderRadius = "0";
    const jobs = [];
    clone.querySelectorAll("img").forEach((el) => {
      const s = el.getAttribute("src");
      if (s && s.indexOf("data:") !== 0) jobs.push(toDataURL(el.src).then((d) => el.setAttribute("src", d)));
    });
    [clone, ...clone.querySelectorAll("*")].forEach((el) => {
      const bg = el.style.backgroundImage;
      if (!bg) return;
      let m;
      const re = /url\(["']?([^"')]+)["']?\)/g;
      while (m = re.exec(bg)) {
        const tok = m[0], url = m[1];
        if (url.indexOf("data:") === 0) continue;
        jobs.push(toDataURL(url).then((d) => {
          el.style.backgroundImage = el.style.backgroundImage.split(tok).join('url("' + d + '")');
        }));
      }
    });
    await Promise.all(jobs);
    const xml = new XMLSerializer().serializeToString(clone);
    const save = (blob, ext) => {
      if (!blob) return;
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = name + "." + ext;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1e3);
    };
    if (kind === "html") {
      const html = '<!doctype html><html><head><meta charset="utf-8"><title>' + name + "</title>" + (fontCss ? "<style>" + fontCss + "</style>" : "") + '</head><body style="margin:0">' + xml + "</body></html>";
      return save(new Blob([html], { type: "text/html" }), "html");
    }
    const px = 3;
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + w * px + '" height="' + h * px + '" viewBox="0 0 ' + w + " " + h + '"><foreignObject width="' + w + '" height="' + h + '">' + (fontCss ? "<style><![CDATA[" + fontCss + "]]></style>" : "") + xml + "</foreignObject></svg>";
    const img = new Image();
    await new Promise((res, rej) => {
      img.onload = res;
      img.onerror = () => rej(new Error("svg load failed"));
      img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
    });
    const cv = document.createElement("canvas");
    cv.width = w * px;
    cv.height = h * px;
    cv.getContext("2d").drawImage(img, 0, 0);
    cv.toBlob((blob) => save(blob, "png"), "image/png");
  }
  function DCArtboardFrame({ sectionId, artboard, label, order, onRename, onReorder, onFocus, onDelete }) {
    const { id: rawId, label: rawLabel, width = 260, height = 480, children, style = {} } = artboard.props;
    const id = rawId ?? rawLabel;
    const ref = React.useRef(null);
    const cardRef = React.useRef(null);
    const menuRef = React.useRef(null);
    const [menuOpen, setMenuOpen] = React.useState(false);
    const [confirming, setConfirming] = React.useState(false);
    React.useEffect(() => {
      if (!menuOpen) {
        setConfirming(false);
        return;
      }
      const off = (e) => {
        if (!menuRef.current || !menuRef.current.contains(e.target)) setMenuOpen(false);
      };
      document.addEventListener("pointerdown", off, true);
      return () => document.removeEventListener("pointerdown", off, true);
    }, [menuOpen]);
    const doExport = (kind) => {
      setMenuOpen(false);
      if (!cardRef.current) return;
      const name = String(label || id || "artboard").replace(/[^\w\s.-]+/g, "_");
      dcExport(cardRef.current, width, height, name, kind).catch((e) => console.error("[design-canvas] export failed:", e));
    };
    const onGripDown = (e) => {
      e.preventDefault();
      e.stopPropagation();
      const me = ref.current;
      const scale = me.getBoundingClientRect().width / me.offsetWidth || 1;
      const peers = Array.from(document.querySelectorAll(`[data-dc-section="${sectionId}"] [data-dc-slot]`));
      const homes = peers.map((el) => ({ el, id: el.dataset.dcSlot, x: el.getBoundingClientRect().left }));
      const slotXs = homes.map((h) => h.x);
      const startIdx = order.indexOf(id);
      const startX = e.clientX;
      let liveOrder = order.slice();
      me.classList.add("dc-dragging");
      const layout = () => {
        for (const h of homes) {
          if (h.id === id) continue;
          const slot = liveOrder.indexOf(h.id);
          h.el.style.transform = `translateX(${(slotXs[slot] - h.x) / scale}px)`;
        }
      };
      const move = (ev) => {
        const dx = ev.clientX - startX;
        me.style.transform = `translateX(${dx / scale}px)`;
        const cur = homes[startIdx].x + dx;
        let nearest = 0, best = Infinity;
        for (let i = 0; i < slotXs.length; i++) {
          const d = Math.abs(slotXs[i] - cur);
          if (d < best) {
            best = d;
            nearest = i;
          }
        }
        if (liveOrder.indexOf(id) !== nearest) {
          liveOrder = order.filter((k) => k !== id);
          liveOrder.splice(nearest, 0, id);
          layout();
        }
      };
      const up = () => {
        document.removeEventListener("pointermove", move);
        document.removeEventListener("pointerup", up);
        const finalSlot = liveOrder.indexOf(id);
        me.classList.remove("dc-dragging");
        me.style.transform = `translateX(${(slotXs[finalSlot] - homes[startIdx].x) / scale}px)`;
        setTimeout(() => {
          for (const h of homes) {
            h.el.style.transition = "none";
            h.el.style.transform = "";
          }
          if (liveOrder.join("|") !== order.join("|")) onReorder(liveOrder);
          requestAnimationFrame(() => requestAnimationFrame(() => {
            for (const h of homes) h.el.style.transition = "";
          }));
        }, 180);
      };
      document.addEventListener("pointermove", move);
      document.addEventListener("pointerup", up);
    };
    return /* @__PURE__ */ React.createElement("div", { ref, "data-dc-slot": id, style: { position: "relative", flexShrink: 0 } }, /* @__PURE__ */ React.createElement("div", { className: "dc-header", "data-omelette-chrome": "", style: { color: DC.label }, onPointerDown: (e) => e.stopPropagation() }, /* @__PURE__ */ React.createElement("div", { className: "dc-labelrow" }, /* @__PURE__ */ React.createElement("div", { className: "dc-grip", onPointerDown: onGripDown, title: "Drag to reorder" }, /* @__PURE__ */ React.createElement("svg", { width: "9", height: "13", viewBox: "0 0 9 13", fill: "currentColor" }, /* @__PURE__ */ React.createElement("circle", { cx: "2", cy: "2", r: "1.1" }), /* @__PURE__ */ React.createElement("circle", { cx: "7", cy: "2", r: "1.1" }), /* @__PURE__ */ React.createElement("circle", { cx: "2", cy: "6.5", r: "1.1" }), /* @__PURE__ */ React.createElement("circle", { cx: "7", cy: "6.5", r: "1.1" }), /* @__PURE__ */ React.createElement("circle", { cx: "2", cy: "11", r: "1.1" }), /* @__PURE__ */ React.createElement("circle", { cx: "7", cy: "11", r: "1.1" }))), /* @__PURE__ */ React.createElement("div", { className: "dc-labeltext", onClick: onFocus, title: "Click to focus" }, /* @__PURE__ */ React.createElement(
      DCEditable,
      {
        value: label,
        onChange: onRename,
        onClick: (e) => e.stopPropagation(),
        style: { fontSize: 15, fontWeight: 500, color: DC.label, lineHeight: 1 }
      }
    ))), /* @__PURE__ */ React.createElement("div", { className: "dc-btns" }, /* @__PURE__ */ React.createElement("div", { ref: menuRef, style: { position: "relative" } }, /* @__PURE__ */ React.createElement("button", { className: "dc-kebab", title: "More", onClick: () => setMenuOpen((o) => !o) }, /* @__PURE__ */ React.createElement("svg", { width: "12", height: "12", viewBox: "0 0 12 12", fill: "currentColor" }, /* @__PURE__ */ React.createElement("circle", { cx: "2.5", cy: "6", r: "1.1" }), /* @__PURE__ */ React.createElement("circle", { cx: "6", cy: "6", r: "1.1" }), /* @__PURE__ */ React.createElement("circle", { cx: "9.5", cy: "6", r: "1.1" }))), menuOpen && /* @__PURE__ */ React.createElement("div", { className: "dc-menu", onPointerDown: (e) => e.stopPropagation() }, /* @__PURE__ */ React.createElement("button", { onClick: () => doExport("png") }, "Download PNG"), /* @__PURE__ */ React.createElement("button", { onClick: () => doExport("html") }, "Download HTML"), /* @__PURE__ */ React.createElement("hr", null), /* @__PURE__ */ React.createElement(
      "button",
      {
        className: "dc-danger",
        onClick: () => {
          if (confirming) {
            setMenuOpen(false);
            onDelete();
          } else setConfirming(true);
        }
      },
      confirming ? "Click again to delete" : "Delete"
    ))), /* @__PURE__ */ React.createElement("button", { className: "dc-expand", onClick: onFocus, title: "Focus" }, /* @__PURE__ */ React.createElement("svg", { width: "12", height: "12", viewBox: "0 0 12 12", fill: "none", stroke: "currentColor", strokeWidth: "1.6", strokeLinecap: "round" }, /* @__PURE__ */ React.createElement("path", { d: "M7 1h4v4M5 11H1V7M11 1L7.5 4.5M1 11l3.5-3.5" }))))), /* @__PURE__ */ React.createElement(
      "div",
      {
        ref: cardRef,
        className: "dc-card",
        style: { borderRadius: 2, boxShadow: "0 1px 3px rgba(0,0,0,.08),0 4px 16px rgba(0,0,0,.06)", overflow: "hidden", width, height, background: "#fff", ...style }
      },
      children || /* @__PURE__ */ React.createElement("div", { style: { height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "#bbb", fontSize: 13, fontFamily: DC.font } }, id)
    ));
  }
  function DCEditable({ value, onChange, style, tag = "span", onClick }) {
    const T = tag;
    return /* @__PURE__ */ React.createElement(
      T,
      {
        className: "dc-editable",
        contentEditable: true,
        suppressContentEditableWarning: true,
        onClick,
        onPointerDown: (e) => e.stopPropagation(),
        onBlur: (e) => onChange && onChange(e.currentTarget.textContent),
        onKeyDown: (e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            e.currentTarget.blur();
          }
        },
        style
      },
      value
    );
  }
  function DCFocusOverlay({ entry, sectionMeta, sectionOrder }) {
    const ctx = React.useContext(DCCtx);
    const { sectionId, artboard } = entry;
    const sec = ctx.section(sectionId);
    const meta = sectionMeta[sectionId];
    const peers = meta.slotIds;
    const aid = artboard.props.id ?? artboard.props.label;
    const idx = peers.indexOf(aid);
    const secIdx = sectionOrder.indexOf(sectionId);
    const go = (d) => {
      const n = peers[(idx + d + peers.length) % peers.length];
      if (n) ctx.setFocus(`${sectionId}/${n}`);
    };
    const goSection = (d) => {
      const n = sectionOrder.length;
      for (let i = 1; i < n; i++) {
        const ns = sectionOrder[((secIdx + d * i) % n + n) % n];
        const first = sectionMeta[ns] && sectionMeta[ns].slotIds[0];
        if (first) {
          ctx.setFocus(`${ns}/${first}`);
          return;
        }
      }
    };
    React.useEffect(() => {
      const k = (e) => {
        if (e.key === "ArrowLeft") {
          e.preventDefault();
          go(-1);
        }
        if (e.key === "ArrowRight") {
          e.preventDefault();
          go(1);
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          goSection(-1);
        }
        if (e.key === "ArrowDown") {
          e.preventDefault();
          goSection(1);
        }
      };
      document.addEventListener("keydown", k);
      return () => document.removeEventListener("keydown", k);
    });
    const { width = 260, height = 480, children } = artboard.props;
    const [vp, setVp] = React.useState({ w: window.innerWidth, h: window.innerHeight });
    React.useEffect(() => {
      const r = () => setVp({ w: window.innerWidth, h: window.innerHeight });
      window.addEventListener("resize", r);
      return () => window.removeEventListener("resize", r);
    }, []);
    const scale = Math.max(0.1, Math.min((vp.w - 200) / width, (vp.h - 260) / height, 2));
    const [ddOpen, setDd] = React.useState(false);
    const Arrow = ({ dir, onClick }) => /* @__PURE__ */ React.createElement(
      "button",
      {
        onClick: (e) => {
          e.stopPropagation();
          onClick();
        },
        style: {
          position: "absolute",
          top: "50%",
          [dir]: 28,
          transform: "translateY(-50%)",
          border: "none",
          background: "rgba(255,255,255,.08)",
          color: "rgba(255,255,255,.9)",
          width: 44,
          height: 44,
          borderRadius: 22,
          fontSize: 18,
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          transition: "background .15s"
        },
        onMouseEnter: (e) => e.currentTarget.style.background = "rgba(255,255,255,.18)",
        onMouseLeave: (e) => e.currentTarget.style.background = "rgba(255,255,255,.08)"
      },
      /* @__PURE__ */ React.createElement("svg", { width: "18", height: "18", viewBox: "0 0 18 18", fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round" }, /* @__PURE__ */ React.createElement("path", { d: dir === "left" ? "M11 3L5 9l6 6" : "M7 3l6 6-6 6" }))
    );
    return ReactDOM.createPortal(
      /* @__PURE__ */ React.createElement(
        "div",
        {
          onClick: () => ctx.setFocus(null),
          onWheel: (e) => e.preventDefault(),
          style: {
            position: "fixed",
            inset: 0,
            zIndex: 100,
            background: "rgba(24,20,16,.6)",
            backdropFilter: "blur(14px)",
            fontFamily: DC.font,
            color: "#fff"
          }
        },
        /* @__PURE__ */ React.createElement(
          "div",
          {
            onClick: (e) => e.stopPropagation(),
            style: { position: "absolute", top: 0, left: 0, right: 0, height: 72, display: "flex", alignItems: "flex-start", padding: "16px 20px 0", gap: 16 }
          },
          /* @__PURE__ */ React.createElement("div", { style: { position: "relative" } }, /* @__PURE__ */ React.createElement(
            "button",
            {
              onClick: () => setDd((o) => !o),
              style: {
                border: "none",
                background: "transparent",
                color: "#fff",
                cursor: "pointer",
                padding: "6px 8px",
                borderRadius: 6,
                textAlign: "left",
                fontFamily: "inherit"
              }
            },
            /* @__PURE__ */ React.createElement("span", { style: { display: "flex", alignItems: "center", gap: 8 } }, /* @__PURE__ */ React.createElement("span", { style: { fontSize: 18, fontWeight: 600, letterSpacing: -0.3 } }, meta.title), /* @__PURE__ */ React.createElement("svg", { width: "11", height: "11", viewBox: "0 0 11 11", fill: "none", stroke: "currentColor", strokeWidth: "1.8", strokeLinecap: "round", style: { opacity: 0.7 } }, /* @__PURE__ */ React.createElement("path", { d: "M2 4l3.5 3.5L9 4" }))),
            meta.subtitle && /* @__PURE__ */ React.createElement("span", { style: { display: "block", fontSize: 13, opacity: 0.6, fontWeight: 400, marginTop: 2 } }, meta.subtitle)
          ), ddOpen && /* @__PURE__ */ React.createElement("div", { style: {
            position: "absolute",
            top: "100%",
            left: 0,
            marginTop: 4,
            background: "#2a251f",
            borderRadius: 8,
            boxShadow: "0 8px 32px rgba(0,0,0,.4)",
            padding: 4,
            minWidth: 200,
            zIndex: 10
          } }, sectionOrder.filter((sid) => sectionMeta[sid].slotIds.length).map((sid) => /* @__PURE__ */ React.createElement(
            "button",
            {
              key: sid,
              onClick: () => {
                setDd(false);
                const f = sectionMeta[sid].slotIds[0];
                if (f) ctx.setFocus(`${sid}/${f}`);
              },
              style: {
                display: "block",
                width: "100%",
                textAlign: "left",
                border: "none",
                cursor: "pointer",
                background: sid === sectionId ? "rgba(255,255,255,.1)" : "transparent",
                color: "#fff",
                padding: "8px 12px",
                borderRadius: 5,
                fontSize: 14,
                fontWeight: sid === sectionId ? 600 : 400,
                fontFamily: "inherit"
              }
            },
            sectionMeta[sid].title
          )))),
          /* @__PURE__ */ React.createElement("div", { style: { flex: 1 } }),
          /* @__PURE__ */ React.createElement(
            "button",
            {
              onClick: () => ctx.setFocus(null),
              onMouseEnter: (e) => e.currentTarget.style.background = "rgba(255,255,255,.12)",
              onMouseLeave: (e) => e.currentTarget.style.background = "transparent",
              style: {
                border: "none",
                background: "transparent",
                color: "rgba(255,255,255,.7)",
                width: 32,
                height: 32,
                borderRadius: 16,
                fontSize: 20,
                cursor: "pointer",
                lineHeight: 1,
                transition: "background .12s"
              }
            },
            "\xD7"
          )
        ),
        /* @__PURE__ */ React.createElement(
          "div",
          {
            style: { position: "absolute", top: 64, bottom: 56, left: 100, right: 100, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 16 }
          },
          /* @__PURE__ */ React.createElement("div", { onClick: (e) => e.stopPropagation(), style: { width: width * scale, height: height * scale, position: "relative" } }, /* @__PURE__ */ React.createElement("div", { style: {
            width,
            height,
            transform: `scale(${scale})`,
            transformOrigin: "top left",
            background: "#fff",
            borderRadius: 2,
            overflow: "hidden",
            boxShadow: "0 20px 80px rgba(0,0,0,.4)"
          } }, children || /* @__PURE__ */ React.createElement("div", { style: { height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "#bbb" } }, aid))),
          /* @__PURE__ */ React.createElement("div", { onClick: (e) => e.stopPropagation(), style: { fontSize: 14, fontWeight: 500, opacity: 0.85, textAlign: "center" } }, (sec.labels || {})[aid] ?? artboard.props.label, /* @__PURE__ */ React.createElement("span", { style: { opacity: 0.5, marginLeft: 10, fontVariantNumeric: "tabular-nums" } }, idx + 1, " / ", peers.length))
        ),
        /* @__PURE__ */ React.createElement(Arrow, { dir: "left", onClick: () => go(-1) }),
        /* @__PURE__ */ React.createElement(Arrow, { dir: "right", onClick: () => go(1) }),
        /* @__PURE__ */ React.createElement(
          "div",
          {
            onClick: (e) => e.stopPropagation(),
            style: { position: "absolute", bottom: 20, left: "50%", transform: "translateX(-50%)", display: "flex", gap: 8 }
          },
          peers.map((p, i) => /* @__PURE__ */ React.createElement(
            "button",
            {
              key: p,
              onClick: () => ctx.setFocus(`${sectionId}/${p}`),
              style: {
                border: "none",
                padding: 0,
                cursor: "pointer",
                width: 6,
                height: 6,
                borderRadius: 3,
                background: i === idx ? "#fff" : "rgba(255,255,255,.3)"
              }
            }
          ))
        )
      ),
      document.body
    );
  }
  function DCPostIt({ children, top, left, right, bottom, rotate = -2, width = 180 }) {
    return /* @__PURE__ */ React.createElement("div", { className: "dc-postit", style: {
      position: "absolute",
      top,
      left,
      right,
      bottom,
      width,
      background: DC.postitBg,
      padding: "14px 16px",
      fontFamily: '"Comic Sans MS", "Marker Felt", "Segoe Print", cursive',
      fontSize: 14,
      lineHeight: 1.4,
      color: DC.postitText,
      boxShadow: "0 2px 8px rgba(0,0,0,0.12), 0 1px 2px rgba(0,0,0,0.08)",
      transform: `rotate(${rotate}deg)`,
      zIndex: 5
    } }, children);
  }
  Object.assign(window, { DesignCanvas, DCSection, DCArtboard, DCPostIt });

  // designs/ios-connection-feedback/constants/copy.js
  var copy = {
    pageTitle: "\u8FDE\u63A5\u72B6\u6001\uFF0C\u9000\u5230\u9700\u8981\u7684\u65F6\u5019",
    eyebrow: "SCRY / iOS \xB7 \u4EA4\u4E92\u8BBE\u8BA1\u63D0\u6848",
    lead: "\u4FDD\u7559\u4F1A\u8BDD\uFF0C\u6536\u8D77\u566A\u58F0\u3002\u6B63\u5E38\u4E0D\u6253\u6270\uFF0C\u5931\u8D25\u6709\u51FA\u53E3\u3002",
    prototypeNotice: "\u4EA4\u4E92\u539F\u578B \xB7 \u6240\u6709\u5237\u65B0\u7ED3\u679C\u5747\u4E3A\u6F14\u793A\uFF0C\u4E0D\u8FDE\u63A5\u771F\u5B9E Mac",
    section: "\u4E24\u79CD\u7ED3\u6784\uFF0C\u540C\u4E00\u7EC4\u4F1A\u8BDD",
    sectionNote: "A \u63A8\u8350\uFF1A\u7528\u64CD\u4F5C\u7ED3\u679C\u4EE3\u66FF\u5E38\u9A7B\u72B6\u6001\u3002B\uFF1A\u4FDD\u7559\u4E00\u884C\u66F4\u65B0\u65F6\u95F4\u3002\u53CC\u51FB\u753B\u677F\u6807\u9898\u53EF\u805A\u7126\u3002",
    boardA: "A / \u5B89\u9759\u9996\u9875 \xB7 \u63A8\u8350",
    boardError: "A / \u5237\u65B0\u5931\u8D25 \xB7 \u5355\u4E00\u63D0\u793A",
    boardB: "B / \u4FDD\u7559\u8F7B\u91CF\u66F4\u65B0\u65F6\u95F4",
    stableNote: "\u6B63\u5E38\u65F6\u6CA1\u6709\u8FDE\u63A5\u5FBD\u6807\uFF1B\u53CD\u9988\u53EA\u8DDF\u968F\u672C\u6B21\u64CD\u4F5C\u3002",
    failureNote: "\u4E0D\u6E05\u7A7A\u65E7\u5217\u8868\uFF0C\u4E0D\u53E0\u52A0\u8B66\u544A\uFF0C\u4E0D\u628A\u4F20\u8F93\u5931\u8D25\u8BF4\u6210\u79BB\u7EBF\u3002",
    alternateNote: "\u66F4\u5BB9\u6613\u77E5\u9053\u6570\u636E\u7684\u65B0\u65E7\uFF0C\u4F46\u6807\u9898\u59CB\u7EC8\u591A\u5360\u4E00\u884C\u3002",
    remote: "\u8FDC\u7A0B",
    time: "03:21",
    cellular: "5G",
    menu: "\u83DC\u5355",
    more: "\u66F4\u591A",
    refresh: "\u5237\u65B0",
    refreshing: "\u6B63\u5728\u5237\u65B0\u2026",
    refreshed: "\u5237\u65B0\u6210\u529F",
    updated: "\u5DF2\u66F4\u65B0",
    retry: "\u91CD\u8BD5",
    details: "\u8BE6\u60C5",
    dismiss: "\u5173\u95ED",
    done: "\u5B8C\u6210",
    failed: "\u4F1A\u8BDD\u5217\u8868\u5237\u65B0\u5931\u8D25",
    stale: (time) => `\u5217\u8868\u672A\u66F4\u65B0 \xB7 \u4E0A\u6B21\u66F4\u65B0 ${time}`,
    lastUpdated: (time) => `\u4E0A\u6B21\u66F4\u65B0 ${time}`,
    unverified: "\u5C1A\u672A\u6838\u5BF9 \xB7 \u4E0B\u62C9\u5237\u65B0",
    pinned: "\u5DF2\u7F6E\u9876",
    projects: "\u9879\u76EE",
    running: "\u8FD0\u884C\u4E2D",
    lastRunning: "\u4E0A\u6B21\uFF1A\u8FD0\u884C\u4E2D",
    search: "\u641C\u7D22\u4F1A\u8BDD",
    newTask: "\u65B0\u5EFA\u4EFB\u52A1",
    compose: (name) => `\u5728 ${name} \u4E2D\u65B0\u5EFA\u4EFB\u52A1`,
    pinOne: "ICTRL",
    pinTwo: "\u5F92\u6B65",
    projectOne: "scry",
    projectTwo: "pi",
    taskOne: "\u722C\u5761\u4F18\u5316",
    taskTwo: "t3 code \u529F\u80FD",
    taskThree: "\u8FD9\u662F pi \u7684\u4EE3\u7801\u8BB2\u89E3\u9879\u76EE https://github.com\u2026",
    noResults: "\u6CA1\u6709\u5339\u914D\u7684\u4F1A\u8BDD",
    expand: "\u5C55\u5F00\u5DF2\u7F6E\u9876",
    collapse: "\u6536\u8D77\u5DF2\u7F6E\u9876",
    scenario: "\u6F14\u793A\u7ED3\u679C",
    scenarioSuccess: "\u5237\u65B0\u6210\u529F",
    scenarioFailure: "\u4F20\u8F93\u5931\u8D25",
    scenarioUnverified: "\u5C1A\u672A\u6838\u5BF9",
    trigger: "\u6F14\u793A\u5237\u65B0",
    pull: "\u677E\u5F00\u4EE5\u5237\u65B0",
    connectionTitle: "\u8FDE\u63A5\u8BE6\u60C5",
    paired: "\u5DF2\u914D\u5BF9",
    pairingLabel: "\u914D\u5BF9",
    hostLabel: "\u8BBE\u5907",
    hostName: "\u6211\u7684 Mac",
    requestLabel: "\u672C\u6B21\u5237\u65B0",
    refreshTimeLabel: "\u4E0A\u6B21\u5B8C\u6574\u66F4\u65B0",
    requestFailed: "\u672A\u5B8C\u6210",
    requestUnverified: "\u5C1A\u672A\u6838\u5BF9",
    requestSuccess: "\u6210\u529F",
    failureExplanation: "\u4F20\u8F93\u63E1\u624B\u672A\u5B8C\u6210\uFF0C\u65E0\u6CD5\u786E\u8BA4 Mac \u5F53\u524D\u72B6\u6001\u3002\u53EF\u4EE5\u91CD\u8BD5\uFF0C\u6216\u68C0\u67E5 Mac \u4E0A\u7684 Scry \u662F\u5426\u53EF\u7528\u3002",
    successExplanation: "\u4E0A\u6B21\u5237\u65B0\u5DF2\u5B8C\u6210\u3002\u8FD9\u4E0D\u4EE3\u8868 Mac \u6301\u7EED\u5728\u7EBF\u3002",
    unverifiedExplanation: "\u4FDD\u7559\u4E86\u4E0A\u6B21\u7684\u4F1A\u8BDD\u5217\u8868\u3002\u5237\u65B0\u540E\u6838\u5BF9\u6700\u65B0\u5185\u5BB9\u3002",
    technical: "\u6280\u672F\u8BE6\u60C5",
    rawError: "handshakeFailed\nNIOSSL.BoringSSLError.sslError\nEOF during handshake",
    source: "\u9519\u8BEF\u6765\u6E90\uFF1A\u4F1A\u8BDD\u5217\u8868\u8BF7\u6C42",
    menuConnection: "\u8FDE\u63A5\u8BE6\u60C5",
    menuRefresh: "\u5237\u65B0\u4F1A\u8BDD",
    menuCancel: "\u53D6\u6D88",
    taskPreview: "\u672C\u8BBE\u8BA1\u7A3F\u53EA\u6F14\u793A\u5237\u65B0\u4E0E\u8FDE\u63A5\u53CD\u9988\u3002",
    rulesTitle: "\u5B89\u9759\uFF0C\u4E0D\u7B49\u4E8E\u9690\u7792",
    rules: [
      ["\u6B63\u5E38", "\u4E0D\u663E\u793A\u201C\u5DF2\u914D\u5BF9 / \u5DF2\u8FDE\u63A5\u201D\u3002\u914D\u5BF9\u4FE1\u606F\u653E\u8FDB\u201C\u66F4\u591A \u2192 \u8FDE\u63A5\u8BE6\u60C5\u201D\u3002"],
      ["\u5237\u65B0", "\u4E0B\u62C9\u65F6\u53EA\u663E\u793A\u8FDB\u5EA6\uFF1B\u6210\u529F\u63D0\u793A\u6D6E\u73B0 2.6 \u79D2\uFF0C\u81EA\u52A8\u6536\u8D77\uFF0C\u4E0D\u6324\u5360\u5217\u8868\u7A7A\u95F4\u3002"],
      ["\u5931\u8D25", "\u53EA\u7559\u4E00\u6761\u53EF\u64CD\u4F5C\u63D0\u793A\u3002\u4FDD\u7559\u7F13\u5B58\uFF0C\u6807\u6CE8\u4E0A\u6B21\u66F4\u65B0\u65F6\u95F4\uFF0C\u6536\u8D77\u6280\u672F\u9519\u8BEF\u3002"],
      ["\u6062\u590D", "\u91CD\u8BD5\u6210\u529F\uFF0C\u65E7\u63D0\u793A\u6D88\u5931\uFF1B\u518D\u6B21\u5931\u8D25\u5219\u66F4\u65B0\u539F\u63D0\u793A\uFF0C\u4E0D\u53E0\u52A0\u3002"]
    ],
    boundary: "\u914D\u5BF9\u5931\u6548\u548C\u6743\u9650\u64A4\u9500\u4E0D\u80FD\u5F53\u666E\u901A\u65AD\u7F51\u5904\u7406\uFF1A\u4FDD\u7559\u201C\u91CD\u65B0\u914D\u5BF9\u201D\u5165\u53E3\u3002\u53D1\u9001\u7ED3\u679C\u672A\u77E5\u65F6\uFF0C\u5FC5\u987B\u4FDD\u7559\u6D88\u606F\u7EA7\u63D0\u793A\uFF0C\u4E0D\u81EA\u52A8\u91CD\u53D1\u3002",
    approval: "\u5F85\u786E\u8BA4\uFF1A\u63A8\u8350 A\u3002\u6B64\u7A3F\u4E0D\u6539\u539F\u751F App\uFF0C\u4E0D\u4EE3\u8868\u771F\u673A\u9A8C\u6536\u3002"
  };

  // designs/ios-connection-feedback/prototype.jsx
  var { useState, useEffect, useRef } = React;
  var { DesignCanvas: DesignCanvas2, DCSection: DCSection2, DCArtboard: DCArtboard2 } = window;
  document.title = copy.pageTitle;
  function Icon({ name, size = 22 }) {
    const paths = {
      menu: /* @__PURE__ */ React.createElement("path", { d: "M4 7h16M4 12h16M4 17h16" }),
      more: /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement("circle", { cx: "5", cy: "12", r: "1" }), /* @__PURE__ */ React.createElement("circle", { cx: "12", cy: "12", r: "1" }), /* @__PURE__ */ React.createElement("circle", { cx: "19", cy: "12", r: "1" })),
      refresh: /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement("path", { d: "M20 7v5h-5M4 17v-5h5" }), /* @__PURE__ */ React.createElement("path", { d: "M6.1 7a7 7 0 0 1 11.6-1L20 9M4 15l2.3 3A7 7 0 0 0 18 17" })),
      plus: /* @__PURE__ */ React.createElement("path", { d: "M12 5v14M5 12h14" }),
      search: /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement("circle", { cx: "10.5", cy: "10.5", r: "6.5" }), /* @__PURE__ */ React.createElement("path", { d: "m16 16 4 4" })),
      folder: /* @__PURE__ */ React.createElement("path", { d: "M3 8V6a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v10H3V8h18" }),
      compose: /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement("path", { d: "M20 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h7M15 4l4 4M10 13l-1 4 4-1L22 7l-4-4z" })),
      down: /* @__PURE__ */ React.createElement("path", { d: "m7 9 5 5 5-5" }),
      check: /* @__PURE__ */ React.createElement("path", { d: "m5 12 4 4L19 6" }),
      info: /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement("circle", { cx: "12", cy: "12", r: "9" }), /* @__PURE__ */ React.createElement("path", { d: "M12 11v6M12 7v.2" })),
      close: /* @__PURE__ */ React.createElement("path", { d: "m6 6 12 12M18 6 6 18" }),
      laptop: /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement("rect", { x: "4", y: "4", width: "16", height: "12", rx: "2" }), /* @__PURE__ */ React.createElement("path", { d: "M2 20h20" }))
    };
    return /* @__PURE__ */ React.createElement("svg", { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.65", strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true" }, paths[name]);
  }
  function IconButton({ icon, label, onClick, className = "" }) {
    return /* @__PURE__ */ React.createElement("button", { className: `icon-button ${className}`, "aria-label": label, onClick }, /* @__PURE__ */ React.createElement(Icon, { name: icon }));
  }
  function Phone({ alternative = false, initialFailure = false, note }) {
    const [state, setState] = useState(initialFailure ? "failure" : "success");
    const [scenario, setScenario] = useState(initialFailure ? "failure" : "success");
    const [busy, setBusy] = useState(false);
    const [toast, setToast] = useState(false);
    const [sheet, setSheet] = useState(null);
    const [technical, setTechnical] = useState(false);
    const [query, setQuery] = useState("");
    const [expanded, setExpanded] = useState(true);
    const [lastUpdated, setLastUpdated] = useState(initialFailure ? "03:16" : "03:21");
    const [pull, setPull] = useState(0);
    const start = useRef(null);
    const content = useRef(null);
    const refreshTimer = useRef(null);
    const toastTimer = useRef(null);
    const sheetRef = useRef(null);
    useEffect(() => () => {
      clearTimeout(refreshTimer.current);
      clearTimeout(toastTimer.current);
    }, []);
    useEffect(() => {
      if (!sheet) return;
      const previous = document.activeElement;
      sheetRef.current?.querySelector("button")?.focus();
      return () => previous?.focus();
    }, [sheet]);
    function refresh() {
      if (busy) return;
      setSheet(null);
      setToast(false);
      setBusy(true);
      clearTimeout(toastTimer.current);
      refreshTimer.current = setTimeout(() => {
        setBusy(false);
        const outcome = scenario === "unverified" ? "success" : scenario;
        setState(outcome);
        if (outcome === "success") {
          setLastUpdated("03:21");
          setToast(true);
          toastTimer.current = setTimeout(() => setToast(false), 2600);
        }
      }, 850);
    }
    function chooseScenario(value) {
      setScenario(value);
      if (value === "unverified") {
        setState("unverified");
        setToast(false);
        setLastUpdated("03:16");
      }
    }
    const stale = state !== "success";
    const rows = [copy.pinOne, copy.pinTwo, copy.taskOne, copy.taskTwo, copy.taskThree];
    const visible = (title) => title.toLowerCase().includes(query.toLowerCase());
    const openTask = () => setSheet("preview");
    function trapFocus(e) {
      if (e.key === "Escape") {
        setSheet(null);
        return;
      }
      if (e.key !== "Tab") return;
      const nodes = [...sheetRef.current.querySelectorAll("button, summary, [href], input, select")].filter((n) => n.getClientRects().length);
      const first = nodes[0], last = nodes[nodes.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
    return /* @__PURE__ */ React.createElement("div", { className: "specimen" }, /* @__PURE__ */ React.createElement("div", { className: "phone" }, /* @__PURE__ */ React.createElement("div", { className: "phone-content", inert: sheet ? "" : void 0 }, /* @__PURE__ */ React.createElement("div", { className: "statusbar" }, /* @__PURE__ */ React.createElement("strong", null, copy.time), /* @__PURE__ */ React.createElement("div", { className: "island" }), /* @__PURE__ */ React.createElement("span", { className: "signal" }, /* @__PURE__ */ React.createElement("i", null), /* @__PURE__ */ React.createElement("i", null), /* @__PURE__ */ React.createElement("i", null), /* @__PURE__ */ React.createElement("i", null)), /* @__PURE__ */ React.createElement("b", null, copy.cellular), /* @__PURE__ */ React.createElement("span", { className: "battery" })), /* @__PURE__ */ React.createElement("header", { className: `app-header ${alternative ? "has-subtitle" : ""}` }, /* @__PURE__ */ React.createElement(IconButton, { icon: "menu", label: copy.menu, onClick: () => setSheet("menu") }), /* @__PURE__ */ React.createElement("div", { className: "header-title" }, /* @__PURE__ */ React.createElement("h2", null, copy.remote), alternative && /* @__PURE__ */ React.createElement("span", null, copy.lastUpdated(lastUpdated))), /* @__PURE__ */ React.createElement(IconButton, { icon: "refresh", label: busy ? copy.refreshing : copy.refresh, className: busy ? "rotating" : "", onClick: refresh }), /* @__PURE__ */ React.createElement(IconButton, { icon: "more", label: copy.more, onClick: () => setSheet("menu") })), /* @__PURE__ */ React.createElement("div", { className: "notice-slot", "aria-live": "polite" }, state === "failure" && /* @__PURE__ */ React.createElement("div", { className: "failure-notice" }, /* @__PURE__ */ React.createElement(Icon, { name: "info", size: 19 }), /* @__PURE__ */ React.createElement("div", { className: "failure-copy" }, /* @__PURE__ */ React.createElement("strong", null, copy.failed), /* @__PURE__ */ React.createElement("span", null, copy.stale(lastUpdated))), /* @__PURE__ */ React.createElement("button", { className: "text-button", disabled: busy, onClick: refresh }, busy ? copy.refreshing : copy.retry), /* @__PURE__ */ React.createElement("button", { className: "detail-hit", "aria-label": copy.details, onClick: () => setSheet("connection") }, /* @__PURE__ */ React.createElement(Icon, { name: "more", size: 20 }))), state === "unverified" && /* @__PURE__ */ React.createElement("button", { className: "unverified", onClick: refresh }, /* @__PURE__ */ React.createElement(Icon, { name: "refresh", size: 14 }), copy.unverified)), /* @__PURE__ */ React.createElement(
      "div",
      {
        className: "list",
        ref: content,
        onTouchStart: (e) => {
          start.current = content.current.scrollTop === 0 ? e.touches[0].clientY : null;
        },
        onTouchMove: (e) => {
          if (start.current !== null) setPull(Math.min(72, Math.max(0, e.touches[0].clientY - start.current)));
        },
        onTouchEnd: () => {
          if (pull > 52) refresh();
          setPull(0);
          start.current = null;
        }
      },
      (busy || pull > 16) && state !== "failure" && /* @__PURE__ */ React.createElement("div", { className: "refresh-progress", role: "status" }, /* @__PURE__ */ React.createElement(Icon, { name: "refresh", size: 16 }), /* @__PURE__ */ React.createElement("span", null, busy ? copy.refreshing : copy.pull)),
      (!query || [copy.pinOne, copy.pinTwo].some(visible)) && /* @__PURE__ */ React.createElement("section", null, /* @__PURE__ */ React.createElement("button", { className: "section-title disclosure", "aria-expanded": expanded, "aria-label": expanded ? copy.collapse : copy.expand, onClick: () => setExpanded(!expanded) }, copy.pinned, /* @__PURE__ */ React.createElement("span", { className: expanded ? "" : "collapsed" }, /* @__PURE__ */ React.createElement(Icon, { name: "down", size: 15 }))), expanded && [copy.pinOne, copy.pinTwo].filter(visible).map((title) => /* @__PURE__ */ React.createElement("button", { key: title, className: "session-row", onClick: openTask }, title))),
      (!query || [copy.taskOne, copy.taskTwo, copy.taskThree].some(visible)) && /* @__PURE__ */ React.createElement("section", { className: "projects" }, /* @__PURE__ */ React.createElement("h3", { className: "section-title" }, copy.projects), (!query || [copy.taskOne, copy.taskTwo].some(visible)) && /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement("div", { className: "project-row" }, /* @__PURE__ */ React.createElement(Icon, { name: "folder", size: 23 }), /* @__PURE__ */ React.createElement("strong", null, copy.projectOne), /* @__PURE__ */ React.createElement(IconButton, { icon: "compose", label: copy.compose(copy.projectOne), onClick: openTask })), [copy.taskOne, copy.taskTwo].filter(visible).map((title) => /* @__PURE__ */ React.createElement("button", { key: title, className: "session-row indented", onClick: openTask }, /* @__PURE__ */ React.createElement("span", null, title), title === copy.taskTwo && /* @__PURE__ */ React.createElement("small", { className: stale ? "stale-state" : "" }, stale ? copy.lastRunning : copy.running)))), (!query || visible(copy.taskThree)) && /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement("div", { className: "project-row second" }, /* @__PURE__ */ React.createElement(Icon, { name: "folder", size: 23 }), /* @__PURE__ */ React.createElement("strong", null, copy.projectTwo), /* @__PURE__ */ React.createElement(IconButton, { icon: "compose", label: copy.compose(copy.projectTwo), onClick: openTask })), /* @__PURE__ */ React.createElement("button", { className: "session-row indented long", onClick: openTask }, copy.taskThree))),
      query && !rows.some(visible) && /* @__PURE__ */ React.createElement("p", { className: "empty" }, copy.noResults)
    ), toast && /* @__PURE__ */ React.createElement("div", { className: "toast", role: "status" }, /* @__PURE__ */ React.createElement("span", { className: "success-icon" }, /* @__PURE__ */ React.createElement(Icon, { name: "check", size: 14 })), copy.refreshed), /* @__PURE__ */ React.createElement("div", { className: "dock" }, /* @__PURE__ */ React.createElement("label", { className: "search" }, /* @__PURE__ */ React.createElement(Icon, { name: "search" }), /* @__PURE__ */ React.createElement("input", { placeholder: copy.search, "aria-label": copy.search, value: query, onChange: (e) => setQuery(e.target.value) })), /* @__PURE__ */ React.createElement("button", { className: "new-task", "aria-label": copy.newTask, onClick: openTask }, /* @__PURE__ */ React.createElement(Icon, { name: "plus", size: 28 }))), /* @__PURE__ */ React.createElement("div", { className: "home-indicator" })), sheet && /* @__PURE__ */ React.createElement("div", { className: "scrim", onClick: () => setSheet(null) }, /* @__PURE__ */ React.createElement("div", { className: "sheet", ref: sheetRef, role: "dialog", "aria-modal": "true", "aria-label": sheet === "connection" ? copy.connectionTitle : copy.menu, onKeyDown: trapFocus, onClick: (e) => e.stopPropagation() }, /* @__PURE__ */ React.createElement("div", { className: "grabber" }), sheet === "menu" ? /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement("button", { className: "menu-row", onClick: refresh }, /* @__PURE__ */ React.createElement(Icon, { name: "refresh" }), copy.menuRefresh), /* @__PURE__ */ React.createElement("button", { className: "menu-row", onClick: () => setSheet("connection") }, /* @__PURE__ */ React.createElement(Icon, { name: "laptop" }), copy.menuConnection, /* @__PURE__ */ React.createElement("span", null, copy.paired)), /* @__PURE__ */ React.createElement("button", { className: "menu-row cancel", onClick: () => setSheet(null) }, copy.menuCancel)) : /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement("div", { className: "sheet-heading" }, /* @__PURE__ */ React.createElement("h3", null, sheet === "preview" ? copy.remote : copy.connectionTitle), /* @__PURE__ */ React.createElement(IconButton, { icon: "close", label: copy.dismiss, onClick: () => setSheet(null) })), sheet === "preview" ? /* @__PURE__ */ React.createElement("p", { className: "explanation" }, copy.taskPreview) : /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement("dl", null, /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("dt", null, copy.hostLabel), /* @__PURE__ */ React.createElement("dd", null, copy.hostName)), /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("dt", null, copy.pairingLabel), /* @__PURE__ */ React.createElement("dd", null, copy.paired)), /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("dt", null, copy.refreshTimeLabel), /* @__PURE__ */ React.createElement("dd", null, lastUpdated)), /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("dt", null, copy.requestLabel), /* @__PURE__ */ React.createElement("dd", null, busy ? copy.refreshing : state === "failure" ? copy.requestFailed : state === "unverified" ? copy.requestUnverified : copy.requestSuccess))), /* @__PURE__ */ React.createElement("p", { className: "explanation" }, state === "failure" ? copy.failureExplanation : state === "unverified" ? copy.unverifiedExplanation : copy.successExplanation), state === "failure" && /* @__PURE__ */ React.createElement("div", { className: "technical" }, /* @__PURE__ */ React.createElement("button", { className: "technical-toggle", "aria-expanded": technical, onClick: () => setTechnical(!technical) }, copy.technical, /* @__PURE__ */ React.createElement(Icon, { name: "down", size: 15 })), technical && /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement("pre", null, copy.rawError), /* @__PURE__ */ React.createElement("small", null, copy.source))), /* @__PURE__ */ React.createElement("button", { className: "sheet-primary", disabled: busy, onClick: refresh }, state === "failure" ? copy.retry : copy.refresh)))))), /* @__PURE__ */ React.createElement("div", { className: "demo-controls" }, /* @__PURE__ */ React.createElement("label", null, /* @__PURE__ */ React.createElement("span", null, copy.scenario), /* @__PURE__ */ React.createElement("select", { "aria-label": copy.scenario, value: scenario, disabled: busy, onChange: (e) => chooseScenario(e.target.value) }, /* @__PURE__ */ React.createElement("option", { value: "success" }, copy.scenarioSuccess), /* @__PURE__ */ React.createElement("option", { value: "failure" }, copy.scenarioFailure), /* @__PURE__ */ React.createElement("option", { value: "unverified" }, copy.scenarioUnverified))), /* @__PURE__ */ React.createElement("button", { disabled: busy, onClick: refresh }, busy ? copy.refreshing : copy.trigger)), /* @__PURE__ */ React.createElement("p", { className: "board-note" }, note));
  }
  function App() {
    return /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement("div", { className: "page-heading" }, /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("p", { className: "eyebrow" }, copy.eyebrow), /* @__PURE__ */ React.createElement("h1", null, copy.pageTitle), /* @__PURE__ */ React.createElement("p", { className: "lead" }, copy.lead)), /* @__PURE__ */ React.createElement("div", { className: "prototype-badge" }, /* @__PURE__ */ React.createElement("span", null), copy.prototypeNotice)), /* @__PURE__ */ React.createElement("main", null, /* @__PURE__ */ React.createElement(DesignCanvas2, { style: { background: "#e9e8e3", height: "100%", width: "100%" } }, /* @__PURE__ */ React.createElement(DCSection2, { id: "connection-directions", title: copy.section, subtitle: copy.sectionNote, gap: 46 }, /* @__PURE__ */ React.createElement(DCArtboard2, { id: "quiet", label: copy.boardA, width: 390, height: 944 }, /* @__PURE__ */ React.createElement(Phone, { note: copy.stableNote })), /* @__PURE__ */ React.createElement(DCArtboard2, { id: "failure", label: copy.boardError, width: 390, height: 944 }, /* @__PURE__ */ React.createElement(Phone, { initialFailure: true, note: copy.failureNote })), /* @__PURE__ */ React.createElement(DCArtboard2, { id: "timestamp", label: copy.boardB, width: 390, height: 944 }, /* @__PURE__ */ React.createElement(Phone, { alternative: true, note: copy.alternateNote }))))), /* @__PURE__ */ React.createElement("footer", null, /* @__PURE__ */ React.createElement("strong", null, copy.rulesTitle), /* @__PURE__ */ React.createElement("div", { className: "rule-grid" }, copy.rules.map(([title, body]) => /* @__PURE__ */ React.createElement("p", { key: title }, /* @__PURE__ */ React.createElement("b", null, title), /* @__PURE__ */ React.createElement("span", null, body)))), /* @__PURE__ */ React.createElement("p", { className: "boundary" }, copy.boundary), /* @__PURE__ */ React.createElement("small", null, copy.approval)));
  }
  ReactDOM.createRoot(document.getElementById("root")).render(/* @__PURE__ */ React.createElement(App, null));
})();
