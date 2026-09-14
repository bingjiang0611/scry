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

  // designs/scry-ios-remote/v5-canvas.jsx
  var { useState } = React;
  var { DesignCanvas: DesignCanvas2, DCSection: DCSection2, DCArtboard: DCArtboard2, DCPostIt: DCPostIt2 } = window;
  var sessions = [
    { project: "vibecoding", title: "\u4FEE\u590D\u8FDC\u7A0B\u4F1A\u8BDD\u5F52\u6863", time: "\u521A\u521A", state: "done", provider: "Qoder" },
    { project: "storefront", title: "\u68C0\u67E5\u7ED3\u7B97\u9875\u56DE\u5F52", time: "12m", state: "running", provider: "Codex" },
    { project: "notes", title: "\u6574\u7406\u53D1\u5E03\u8BF4\u660E", time: "2h", state: "idle", provider: "Claude" }
  ];
  function Icon({ name, size = 20 }) {
    const paths = {
      menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
      more: '<circle cx="5" cy="12" r="1" fill="currentColor"/><circle cx="12" cy="12" r="1" fill="currentColor"/><circle cx="19" cy="12" r="1" fill="currentColor"/>',
      plus: '<path d="M12 5v14M5 12h14"/>',
      arrow: '<path d="m5 12 7-7 7 7M12 5v14"/>',
      back: '<path d="m15 18-6-6 6-6"/>',
      search: '<circle cx="11" cy="11" r="6"/><path d="m16 16 4 4"/>',
      folder: '<path d="M3 7.5h7l2 2h9v9.5H3z"/>',
      laptop: '<rect x="4" y="5" width="16" height="11" rx="2"/><path d="M2 19h20"/>',
      shield: '<path d="M12 3 5 6v5c0 4.5 2.9 8 7 10 4.1-2 7-5.5 7-10V6z"/><path d="m9 12 2 2 4-4"/>',
      bolt: '<path d="m13 2-8 12h7l-1 8 8-12h-7z"/>',
      check: '<path d="m5 12 4 4L19 6"/>',
      device: '<rect x="7" y="2" width="10" height="20" rx="2"/><path d="M11 18h2"/>',
      gear: '<circle cx="12" cy="12" r="3"/><path d="M19 13.5v-3l-2-.7-.5-1.2.9-1.9-2.1-2.1-1.9.9-1.2-.5-.7-2h-3l-.7 2-1.2.5-1.9-.9-2.1 2.1.9 1.9-.5 1.2-2 .7v3l2 .7.5 1.2-.9 1.9 2.1 2.1 1.9-.9 1.2.5.7 2h3l.7-2 1.2-.5 1.9.9 2.1-2.1-.9-1.9.5-1.2z"/>',
      chat: '<path d="M4 5h16v11H9l-5 4z"/>',
      inbox: '<path d="M4 4h16v16H4zM4 14h5l2 2h2l2-2h5"/>',
      link: '<path d="M10 13a4 4 0 0 0 5.7.1l2.2-2.2a4 4 0 0 0-5.7-5.7L11 6.4M14 11a4 4 0 0 0-5.7-.1l-2.2 2.2a4 4 0 0 0 5.7 5.7l1.2-1.2"/>',
      doc: '<path d="M6 3h8l4 4v14H6zM14 3v5h5"/>',
      chevron: '<path d="m9 18 6-6-6-6"/>'
    };
    return /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", width: size, height: size, "aria-hidden": "true", dangerouslySetInnerHTML: { __html: paths[name] || paths.more } });
  }
  function Dot({ state }) {
    return /* @__PURE__ */ React.createElement("span", { className: `state-dot ${state}` });
  }
  function IconButton({ icon, label, onClick, primary = false }) {
    return /* @__PURE__ */ React.createElement("button", { className: `icon-btn ${primary ? "primary" : ""}`, "aria-label": label, onClick }, /* @__PURE__ */ React.createElement(Icon, { name: icon }));
  }
  function Provider({ children }) {
    return /* @__PURE__ */ React.createElement("span", { className: "provider" }, children);
  }
  function Shell({ direction, children, route, setRoute }) {
    return /* @__PURE__ */ React.createElement("div", { className: `phone dir-${direction.toLowerCase()}` }, /* @__PURE__ */ React.createElement("div", { className: "safe-cap" }), children, route === "menu" && /* @__PURE__ */ React.createElement(MenuSheet, { setRoute }));
  }
  function MenuSheet({ setRoute }) {
    return /* @__PURE__ */ React.createElement("div", { className: "overlay", onClick: () => setRoute("home") }, /* @__PURE__ */ React.createElement("div", { className: "sheet", onClick: (e) => e.stopPropagation() }, /* @__PURE__ */ React.createElement("div", { className: "grabber" }), /* @__PURE__ */ React.createElement("button", { className: "sheet-row", onClick: () => setRoute("pair") }, /* @__PURE__ */ React.createElement(Icon, { name: "link" }), "\u8FDE\u63A5 Mac", /* @__PURE__ */ React.createElement("span", null, "\u5DF2\u914D\u5BF9"), /* @__PURE__ */ React.createElement(Icon, { name: "chevron" })), /* @__PURE__ */ React.createElement("button", { className: "sheet-row", onClick: () => setRoute("settings") }, /* @__PURE__ */ React.createElement(Icon, { name: "gear" }), "\u8BBE\u7F6E", /* @__PURE__ */ React.createElement("span", null), /* @__PURE__ */ React.createElement(Icon, { name: "chevron" })), /* @__PURE__ */ React.createElement("div", { className: "sheet-foot" }, "\u51ED\u636E\u4E0E\u6267\u884C\u4FDD\u7559\u5728\u4F60\u7684 Mac")));
  }
  function Header({ title, subtitle, back, onBack, onMenu, action }) {
    return /* @__PURE__ */ React.createElement("header", { className: "topbar" }, back ? /* @__PURE__ */ React.createElement(IconButton, { icon: "back", label: "\u8FD4\u56DE", onClick: onBack }) : /* @__PURE__ */ React.createElement(IconButton, { icon: "menu", label: "\u83DC\u5355", onClick: onMenu }), /* @__PURE__ */ React.createElement("div", { className: "title-block" }, /* @__PURE__ */ React.createElement("strong", null, title), subtitle && /* @__PURE__ */ React.createElement("span", null, subtitle)), action || /* @__PURE__ */ React.createElement(IconButton, { icon: "more", label: "\u66F4\u591A", onClick: onMenu }));
  }
  function Composer({ compact = false, placeholder = "\u7ED9 Mac \u4E00\u9879\u4EFB\u52A1\u2026", showProvider = true }) {
    const [text, setText] = useState("");
    const [showAttach, setShowAttach] = useState(false);
    const [files, setFiles] = useState([]);
    const [control, setControl] = useState(null);
    const [permission, setPermission] = useState("\u9ED8\u8BA4\u5BA1\u6279");
    const [effort, setEffort] = useState("\u9AD8");
    const addFiles = (event) => {
      setFiles([...files, ...Array.from(event.target.files || []).map((file) => file.name)].slice(0, 4));
      setShowAttach(false);
    };
    return /* @__PURE__ */ React.createElement("div", { className: `composer ${compact ? "compact" : ""}` }, files.length > 0 && /* @__PURE__ */ React.createElement("div", { className: "attachment-chips" }, files.map((name) => /* @__PURE__ */ React.createElement("span", { key: name }, /* @__PURE__ */ React.createElement(Icon, { name: "doc", size: 13 }), name, /* @__PURE__ */ React.createElement("button", { onClick: () => setFiles(files.filter((f) => f !== name)) }, "\xD7")))), /* @__PURE__ */ React.createElement("textarea", { value: text, onChange: (e) => setText(e.target.value), placeholder }), /* @__PURE__ */ React.createElement("div", { className: "composer-actions" }, /* @__PURE__ */ React.createElement(IconButton, { icon: "plus", label: "\u6DFB\u52A0\u56FE\u7247\u6216\u6587\u4EF6", onClick: () => setShowAttach(!showAttach) }), /* @__PURE__ */ React.createElement("button", { className: "access", onClick: () => setControl(control === "permission" ? null : "permission") }, /* @__PURE__ */ React.createElement(Icon, { name: "shield", size: 16 }), " ", permission), /* @__PURE__ */ React.createElement("span", { className: "grow" }), /* @__PURE__ */ React.createElement("button", { className: "effort", onClick: () => setControl(control === "effort" ? null : "effort") }, "\u25C9 ", effort), showProvider && /* @__PURE__ */ React.createElement(Provider, null, "Qoder"), /* @__PURE__ */ React.createElement(IconButton, { icon: "arrow", label: "\u53D1\u9001", primary: true, onClick: () => setText("") })), control === "permission" && /* @__PURE__ */ React.createElement("div", { className: "control-menu permission-menu" }, /* @__PURE__ */ React.createElement("b", null, "\u6743\u9650"), ["\u9ED8\u8BA4\u5BA1\u6279", "\u81EA\u52A8\u5BA1\u67E5", "\u5B8C\u5168\u8BBF\u95EE"].map((item) => /* @__PURE__ */ React.createElement("button", { key: item, onClick: () => {
      setPermission(item);
      setControl(null);
    } }, /* @__PURE__ */ React.createElement("span", null, item), permission === item && /* @__PURE__ */ React.createElement(Icon, { name: "check" })))), control === "effort" && /* @__PURE__ */ React.createElement("div", { className: "control-menu effort-menu" }, /* @__PURE__ */ React.createElement("b", null, "Effort"), ["\u4F4E", "\u4E2D", "\u9AD8", "\u6781\u9AD8"].map((item) => /* @__PURE__ */ React.createElement("button", { key: item, onClick: () => {
      setEffort(item);
      setControl(null);
    } }, /* @__PURE__ */ React.createElement("span", null, item), effort === item && /* @__PURE__ */ React.createElement(Icon, { name: "check" })))), showAttach && /* @__PURE__ */ React.createElement("div", { className: "attach-menu" }, /* @__PURE__ */ React.createElement("label", null, /* @__PURE__ */ React.createElement(Icon, { name: "plus" }), /* @__PURE__ */ React.createElement("span", null, /* @__PURE__ */ React.createElement("b", null, "\u7167\u7247\u56FE\u5E93"), /* @__PURE__ */ React.createElement("small", null, "\u4E0A\u4F20 JPG\u3001PNG\u3001GIF \u6216 WebP")), /* @__PURE__ */ React.createElement("input", { type: "file", accept: "image/png,image/jpeg,image/gif,image/webp", multiple: true, onChange: addFiles })), /* @__PURE__ */ React.createElement("label", null, /* @__PURE__ */ React.createElement(Icon, { name: "doc" }), /* @__PURE__ */ React.createElement("span", null, /* @__PURE__ */ React.createElement("b", null, "\u9009\u62E9\u6587\u4EF6"), /* @__PURE__ */ React.createElement("small", null, "\u4E0A\u4F20\u6587\u672C\u3001\u4EE3\u7801\u6216\u6587\u6863")), /* @__PURE__ */ React.createElement("input", { type: "file", multiple: true, onChange: addFiles }))));
  }
  function Conversation({ direction, setRoute }) {
    return /* @__PURE__ */ React.createElement("div", { className: "screen" }, /* @__PURE__ */ React.createElement(Header, { title: "\u4FEE\u590D\u8FDC\u7A0B\u4F1A\u8BDD\u5F52\u6863", subtitle: "vibecoding \xB7 Qoder", back: true, onBack: () => setRoute("home"), action: /* @__PURE__ */ React.createElement(IconButton, { icon: "more", label: "\u4F1A\u8BDD\u9009\u9879", onClick: () => setRoute("menu") }) }), /* @__PURE__ */ React.createElement("main", { className: "conversation" }, /* @__PURE__ */ React.createElement("div", { className: "message user" }, "\u624B\u673A\u53D1\u8D77\u7684\u5BF9\u8BDD\uFF0C\u5728 Mac \u4E0A\u770B\u4E0D\u5230\u5185\u5BB9\u3002\u8BF7\u5B9A\u4F4D\u5E76\u4FEE\u590D\u3002"), /* @__PURE__ */ React.createElement("div", { className: "agent-head" }, /* @__PURE__ */ React.createElement(Dot, { state: "done" }), /* @__PURE__ */ React.createElement("b", null, "Qoder"), /* @__PURE__ */ React.createElement("span", null, "\u5DF2\u5B8C\u6210 \xB7 8 \u79D2")), /* @__PURE__ */ React.createElement("div", { className: "answer" }, /* @__PURE__ */ React.createElement("p", null, "\u5DF2\u627E\u5230\u539F\u56E0\uFF1A\u7EED\u804A\u65F6 Provider \u4E0D\u4F1A\u518D\u6B21\u4E0A\u62A5\u4F1A\u8BDD ID\uFF0C\u65E7\u903B\u8F91\u56E0\u6B64\u7559\u4E0B\u4E86\u65E0\u6CD5\u6253\u5F00\u7684\u4E34\u65F6\u4F1A\u8BDD\u3002"), /* @__PURE__ */ React.createElement("p", null, "\u73B0\u5728\u4F1A\u76F4\u63A5\u590D\u7528\u771F\u5B9E\u4F1A\u8BDD\u8EAB\u4EFD\uFF0C\u5E76\u628A\u672C\u8F6E\u5185\u5BB9\u5F52\u6863\u5230\u540C\u4E00\u6BB5\u5BF9\u8BDD\u3002")), /* @__PURE__ */ React.createElement("button", { className: "evidence-row" }, /* @__PURE__ */ React.createElement(Icon, { name: "check", size: 16 }), /* @__PURE__ */ React.createElement("span", null, "\u8FD0\u884C\u8BC1\u636E"), /* @__PURE__ */ React.createElement("b", null, "\u5DF2\u5F52\u6863"), /* @__PURE__ */ React.createElement(Icon, { name: "chevron", size: 16 })), direction === "C" && /* @__PURE__ */ React.createElement("div", { className: "run-card" }, /* @__PURE__ */ React.createElement("span", { className: "eyebrow" }, "RUN RECEIPT"), /* @__PURE__ */ React.createElement("b", null, "recorded \u2192 dispatched \u2192 settled"), /* @__PURE__ */ React.createElement("span", null, "2,041 tokens \xB7 0 tools \xB7 Mac verified"))), /* @__PURE__ */ React.createElement("footer", { className: "bottom-compose" }, /* @__PURE__ */ React.createElement(Composer, { compact: true, placeholder: "\u7EE7\u7EED\u8FD9\u6BB5\u5BF9\u8BDD\u2026" })));
  }
  function NewTask({ direction, setRoute, initialProject = "vibecoding" }) {
    const [picker, setPicker] = useState(null);
    const [project, setProject] = useState(initialProject);
    const [provider, setProvider] = useState("Qoder \xB7 Ultimate");
    const [folderPath, setFolderPath] = useState(null);
    const providers = ["Qoder \xB7 Ultimate", "Codex \xB7 GPT-5", "Claude \xB7 Sonnet"];
    const folders = !folderPath ? ["vibecoding", "storefront", "notes"] : folderPath === "vibecoding" ? ["apps", "designs", "src"] : folderPath === "vibecoding/src" ? ["main", "renderer", "shared"] : [];
    const parentFolder = folderPath?.includes("/") ? folderPath.split("/").slice(0, -1).join("/") : null;
    return /* @__PURE__ */ React.createElement("div", { className: "screen" }, /* @__PURE__ */ React.createElement(Header, { title: "\u65B0\u4EFB\u52A1", subtitle: direction === "C" ? "\u914D\u7F6E\u4E0E\u6D3E\u53D1" : "Studio Mac", back: true, onBack: () => setRoute("home") }), /* @__PURE__ */ React.createElement("main", { className: `new-task ${direction === "C" ? "form" : ""}` }, /* @__PURE__ */ React.createElement("div", { className: "context-stack" }, /* @__PURE__ */ React.createElement("button", null, /* @__PURE__ */ React.createElement(Icon, { name: "laptop" }), /* @__PURE__ */ React.createElement("span", null, /* @__PURE__ */ React.createElement("small", null, "\u4E3B\u673A"), "Studio Mac"), /* @__PURE__ */ React.createElement(Dot, { state: "done" })), /* @__PURE__ */ React.createElement("button", { onClick: () => {
      setFolderPath(project);
      setPicker("project");
    } }, /* @__PURE__ */ React.createElement(Icon, { name: "folder" }), /* @__PURE__ */ React.createElement("span", null, /* @__PURE__ */ React.createElement("small", null, "\u5DE5\u4F5C\u76EE\u5F55"), project), /* @__PURE__ */ React.createElement(Icon, { name: "chevron" })), /* @__PURE__ */ React.createElement("button", { onClick: () => setPicker("provider") }, /* @__PURE__ */ React.createElement(Icon, { name: "bolt" }), /* @__PURE__ */ React.createElement("span", null, /* @__PURE__ */ React.createElement("small", null, "Provider"), provider), /* @__PURE__ */ React.createElement(Icon, { name: "chevron" })))), /* @__PURE__ */ React.createElement("footer", { className: "bottom-compose" }, /* @__PURE__ */ React.createElement(Composer, { placeholder: "\u63CF\u8FF0\u4EFB\u52A1\uFF0C\u6216\u7C98\u8D34\u9519\u8BEF\u4FE1\u606F\u2026", showProvider: false })), picker && /* @__PURE__ */ React.createElement("div", { className: "overlay", onClick: () => setPicker(null) }, /* @__PURE__ */ React.createElement("div", { className: "sheet picker-sheet", onClick: (e) => e.stopPropagation() }, /* @__PURE__ */ React.createElement("div", { className: "grabber" }), /* @__PURE__ */ React.createElement("h3", null, picker === "project" ? "\u9009\u62E9\u6587\u4EF6\u5939" : "\u9009\u62E9 Provider"), /* @__PURE__ */ React.createElement("p", null, picker === "project" ? "\u53EF\u6D4F\u89C8 Mac \u5DF2\u6388\u6743\u9879\u76EE\u5185\u7684\u4EFB\u610F\u6587\u4EF6\u5939" : "\u4EC5\u663E\u793A\u4E3B\u673A\u5F53\u524D\u53EF\u7528\u7684 Provider"), picker === "project" ? /* @__PURE__ */ React.createElement(React.Fragment, null, folderPath && /* @__PURE__ */ React.createElement("button", { className: "folder-back", onClick: () => setFolderPath(parentFolder) }, "\u2039 ", parentFolder?.split("/").at(-1) || "\u5DF2\u6388\u6743\u9879\u76EE"), folderPath && /* @__PURE__ */ React.createElement("div", { className: "folder-current" }, /* @__PURE__ */ React.createElement("b", null, folderPath.split("/").at(-1)), /* @__PURE__ */ React.createElement("small", null, "/", folderPath), /* @__PURE__ */ React.createElement("button", { onClick: () => {
      setProject(folderPath);
      setPicker(null);
    } }, "\u9009\u62E9\u6B64\u6587\u4EF6\u5939")), /* @__PURE__ */ React.createElement("small", { className: "folder-label" }, folderPath ? "\u5B50\u6587\u4EF6\u5939" : "\u5DF2\u6388\u6743\u9879\u76EE"), folders.length ? folders.map((choice) => {
      const path = folderPath ? `${folderPath}/${choice}` : choice;
      return /* @__PURE__ */ React.createElement("button", { key: path, className: "picker-row folder-row", onClick: () => setFolderPath(path) }, /* @__PURE__ */ React.createElement(Icon, { name: "folder" }), /* @__PURE__ */ React.createElement("span", null, choice, /* @__PURE__ */ React.createElement("small", null, "/", path)), project === path && /* @__PURE__ */ React.createElement(Icon, { name: "check" }), /* @__PURE__ */ React.createElement(Icon, { name: "chevron" }));
    }) : /* @__PURE__ */ React.createElement("div", { className: "folder-empty" }, "\u6B64\u6587\u4EF6\u5939\u6CA1\u6709\u5B50\u6587\u4EF6\u5939")) : providers.map((choice) => /* @__PURE__ */ React.createElement("button", { key: choice, className: "picker-row", onClick: () => {
      setProvider(choice);
      setPicker(null);
    } }, /* @__PURE__ */ React.createElement("span", null, choice), provider === choice && /* @__PURE__ */ React.createElement(Icon, { name: "check" }))))));
  }
  function Pair({ setRoute }) {
    return /* @__PURE__ */ React.createElement("div", { className: "screen quiet-screen" }, /* @__PURE__ */ React.createElement(Header, { title: "\u8FDE\u63A5 Mac", back: true, onBack: () => setRoute("home") }), /* @__PURE__ */ React.createElement("main", { className: "pair-body" }, /* @__PURE__ */ React.createElement("div", { className: "pair-mark" }, /* @__PURE__ */ React.createElement(Icon, { name: "laptop", size: 34 }), /* @__PURE__ */ React.createElement("span", null, /* @__PURE__ */ React.createElement(Icon, { name: "device", size: 26 }))), /* @__PURE__ */ React.createElement("h2", null, "\u8BA9 iPhone \u5B89\u5168\u8FDE\u63A5 Scry"), /* @__PURE__ */ React.createElement("p", null, "\u5728 Mac \u7684 Scry \u4E2D\u6253\u5F00\u201C\u8FDE\u63A5 iPhone\u201D\uFF0C\u7136\u540E\u626B\u63CF\u4E00\u6B21\u6027\u914D\u5BF9\u7801\u3002"), /* @__PURE__ */ React.createElement("ol", null, /* @__PURE__ */ React.createElement("li", null, /* @__PURE__ */ React.createElement("b", null, "1"), /* @__PURE__ */ React.createElement("span", null, "\u626B\u63CF Mac \u4E0A\u663E\u793A\u7684\u4E8C\u7EF4\u7801")), /* @__PURE__ */ React.createElement("li", null, /* @__PURE__ */ React.createElement("b", null, "2"), /* @__PURE__ */ React.createElement("span", null, "\u6838\u5BF9\u4E24\u7AEF\u8BBE\u5907\u6307\u7EB9")), /* @__PURE__ */ React.createElement("li", null, /* @__PURE__ */ React.createElement("b", null, "3"), /* @__PURE__ */ React.createElement("span", null, "\u5728 Mac \u4E0A\u786E\u8BA4\u8BBF\u95EE\u6743\u9650"))), /* @__PURE__ */ React.createElement("div", { className: "privacy-note" }, /* @__PURE__ */ React.createElement(Icon, { name: "shield", size: 18 }), "\u4E2D\u7EE7\u53EA\u4F20\u8F93\u7AEF\u5230\u7AEF\u52A0\u5BC6\u5B57\u8282\uFF0C\u51ED\u636E\u4E0D\u4F1A\u79BB\u5F00\u4F60\u7684\u8BBE\u5907\u3002")), /* @__PURE__ */ React.createElement("footer", { className: "pair-actions" }, /* @__PURE__ */ React.createElement("button", { className: "primary-wide" }, "\u626B\u63CF\u914D\u5BF9\u7801"), /* @__PURE__ */ React.createElement("button", { onClick: () => setRoute("home") }, "\u7A0D\u540E\u8FDE\u63A5")));
  }
  function Settings({ setRoute }) {
    return /* @__PURE__ */ React.createElement("div", { className: "screen" }, /* @__PURE__ */ React.createElement(Header, { title: "\u8BBE\u7F6E", back: true, onBack: () => setRoute("home") }), /* @__PURE__ */ React.createElement("main", { className: "settings" }, /* @__PURE__ */ React.createElement("section", null, /* @__PURE__ */ React.createElement("h3", null, "\u8FDE\u63A5"), /* @__PURE__ */ React.createElement("button", null, /* @__PURE__ */ React.createElement(Icon, { name: "laptop" }), /* @__PURE__ */ React.createElement("span", null, /* @__PURE__ */ React.createElement("b", null, "Studio Mac"), /* @__PURE__ */ React.createElement("small", null, "\u5DF2\u914D\u5BF9 \xB7 \u5F53\u524D\u53EF\u8FBE")), /* @__PURE__ */ React.createElement(Dot, { state: "done" }), /* @__PURE__ */ React.createElement(Icon, { name: "chevron" }))), /* @__PURE__ */ React.createElement("section", null, /* @__PURE__ */ React.createElement("h3", null, "\u8FDC\u7A0B\u4F53\u9A8C"), /* @__PURE__ */ React.createElement("button", null, /* @__PURE__ */ React.createElement(Icon, { name: "shield" }), /* @__PURE__ */ React.createElement("span", null, /* @__PURE__ */ React.createElement("b", null, "\u9ED8\u8BA4\u6743\u9650"), /* @__PURE__ */ React.createElement("small", null, "\u5B8C\u5168\u8BBF\u95EE")), /* @__PURE__ */ React.createElement(Icon, { name: "chevron" })), /* @__PURE__ */ React.createElement("button", null, /* @__PURE__ */ React.createElement(Icon, { name: "inbox" }), /* @__PURE__ */ React.createElement("span", null, /* @__PURE__ */ React.createElement("b", null, "\u540E\u53F0\u901A\u77E5"), /* @__PURE__ */ React.createElement("small", null, "\u8FD0\u884C\u5B8C\u6210\u4E0E\u9700\u8981\u64CD\u4F5C\u65F6\u63D0\u9192")), /* @__PURE__ */ React.createElement("span", { className: "toggle on" }))), /* @__PURE__ */ React.createElement("section", null, /* @__PURE__ */ React.createElement("h3", null, "\u5173\u4E8E"), /* @__PURE__ */ React.createElement("button", null, /* @__PURE__ */ React.createElement(Icon, { name: "doc" }), /* @__PURE__ */ React.createElement("span", null, /* @__PURE__ */ React.createElement("b", null, "\u9690\u79C1\u4E0E\u5B89\u5168"), /* @__PURE__ */ React.createElement("small", null, "\u7AEF\u5230\u7AEF\u52A0\u5BC6\u4E0E\u8BBE\u5907\u6743\u9650")), /* @__PURE__ */ React.createElement(Icon, { name: "chevron" })))));
  }
  function HomeA({ setRoute }) {
    const [pinnedOpen, setPinnedOpen] = useState(true);
    return /* @__PURE__ */ React.createElement("div", { className: "screen" }, /* @__PURE__ */ React.createElement(Header, { title: "\u8FDC\u7A0B", subtitle: /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement(Dot, { state: "done" }), " Studio Mac"), onMenu: () => setRoute("menu") }), /* @__PURE__ */ React.createElement("main", { className: "home home-a reference-list" }, /* @__PURE__ */ React.createElement("button", { className: "list-heading collapsible", onClick: () => setPinnedOpen(!pinnedOpen) }, "\u5DF2\u7F6E\u9876 ", /* @__PURE__ */ React.createElement("span", null, pinnedOpen ? "\u2304" : "\u203A")), pinnedOpen && /* @__PURE__ */ React.createElement("div", { className: "plain-sessions" }, /* @__PURE__ */ React.createElement("button", { onClick: () => setRoute("chat") }, "Run ai-radar scrape"), /* @__PURE__ */ React.createElement("button", { onClick: () => setRoute("chat") }, "\u8BBE\u8BA1 AI \u8BC4\u4EF7\u6298\u53E0\u6C89\u5E95\u6807\u8BB0"), /* @__PURE__ */ React.createElement("button", { onClick: () => setRoute("chat") }, "\u5B8C\u6210\u9700\u6C42 84850862 \u5F00\u53D1"), /* @__PURE__ */ React.createElement("button", { onClick: () => setRoute("chat") }, "\u5B9A\u4F4D\u8BC4\u4EF7\u9700\u6C42\u63A5\u53E3\u53CA\u7F3A\u5931\u6570\u636E"), /* @__PURE__ */ React.createElement("button", { onClick: () => setRoute("chat") }, "\u6392\u67E5\u5546\u5BB6\u540E\u53F0"), /* @__PURE__ */ React.createElement("button", { onClick: () => setRoute("chat") }, "88vip"), /* @__PURE__ */ React.createElement("button", { onClick: () => setRoute("chat") }, "\u589E\u52A0\u5929\u732B\u5546\u5BB6\u661F\u7EA7\u7B5B\u9009")), /* @__PURE__ */ React.createElement("div", { className: "list-heading" }, "\u9879\u76EE"), /* @__PURE__ */ React.createElement("div", { className: "project-group" }, /* @__PURE__ */ React.createElement("div", { className: "project-title" }, /* @__PURE__ */ React.createElement(Icon, { name: "folder" }), /* @__PURE__ */ React.createElement("b", null, "rate-native"), /* @__PURE__ */ React.createElement("button", { "aria-label": "\u5728 rate-native \u65B0\u5EFA\u4EFB\u52A1", onClick: () => setRoute("new-rate") }, /* @__PURE__ */ React.createElement(Icon, { name: "doc" }))), /* @__PURE__ */ React.createElement("button", { className: "project-session", onClick: () => setRoute("chat") }, "$rate-workflow https://project.aone.alib..."), /* @__PURE__ */ React.createElement("button", { className: "project-session", onClick: () => setRoute("chat") }, "\u5F00\u59CB\u5904\u7406 Aone \u5DE5\u5355 85591443"), /* @__PURE__ */ React.createElement("button", { className: "project-session", onClick: () => setRoute("chat") }, "\u590D\u76D8\u6280\u672F\u65B9\u6848\u6307\u6807")), /* @__PURE__ */ React.createElement("div", { className: "project-group compact-project" }, /* @__PURE__ */ React.createElement("div", { className: "project-title" }, /* @__PURE__ */ React.createElement(Icon, { name: "folder" }), /* @__PURE__ */ React.createElement("b", null, "vibecoding"), /* @__PURE__ */ React.createElement("button", { onClick: () => setRoute("new") }, /* @__PURE__ */ React.createElement(Icon, { name: "doc" }))))), /* @__PURE__ */ React.createElement("footer", { className: "home-dock" }, /* @__PURE__ */ React.createElement("button", { className: "search-pill" }, /* @__PURE__ */ React.createElement(Icon, { name: "search" }), "\u641C\u7D22\u4F1A\u8BDD"), /* @__PURE__ */ React.createElement(IconButton, { icon: "plus", label: "\u65B0\u4EFB\u52A1", primary: true, onClick: () => setRoute("new") })));
  }
  function HomeB({ setRoute }) {
    return /* @__PURE__ */ React.createElement("div", { className: "screen" }, /* @__PURE__ */ React.createElement(Header, { title: "Scry", subtitle: /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement(Dot, { state: "done" }), " Studio Mac"), onMenu: () => setRoute("menu"), action: /* @__PURE__ */ React.createElement("button", { className: "avatar", onClick: () => setRoute("settings") }, "B") }), /* @__PURE__ */ React.createElement("main", { className: "home home-b" }, /* @__PURE__ */ React.createElement("div", { className: "welcome" }, /* @__PURE__ */ React.createElement("span", { className: "eyebrow" }, "MAC IS READY"), /* @__PURE__ */ React.createElement("h2", null, "\u4E0B\u4E00\u6B65\u505A\u4EC0\u4E48\uFF1F"), /* @__PURE__ */ React.createElement(Composer, { compact: true, placeholder: "\u7ED9 Studio Mac \u4E00\u9879\u4EFB\u52A1\u2026" })), /* @__PURE__ */ React.createElement("div", { className: "section-heading" }, /* @__PURE__ */ React.createElement("span", null, "\u6700\u8FD1"), /* @__PURE__ */ React.createElement("button", null, "\u67E5\u770B\u5168\u90E8")), /* @__PURE__ */ React.createElement("div", { className: "recent-list" }, sessions.map((s) => /* @__PURE__ */ React.createElement("button", { key: s.title, onClick: () => setRoute("chat") }, /* @__PURE__ */ React.createElement("span", { className: "mini-icon" }, /* @__PURE__ */ React.createElement(Icon, { name: "chat", size: 17 })), /* @__PURE__ */ React.createElement("span", null, /* @__PURE__ */ React.createElement("b", null, s.title), /* @__PURE__ */ React.createElement("small", null, s.project, " \xB7 ", s.time)), /* @__PURE__ */ React.createElement(Icon, { name: "chevron", size: 17 }))))));
  }
  function HomeC({ setRoute }) {
    return /* @__PURE__ */ React.createElement("div", { className: "screen with-tabs" }, /* @__PURE__ */ React.createElement(Header, { title: "\u5DE5\u4F5C\u961F\u5217", subtitle: "Studio Mac", onMenu: () => setRoute("menu"), action: /* @__PURE__ */ React.createElement(IconButton, { icon: "plus", label: "\u65B0\u4EFB\u52A1", primary: true, onClick: () => setRoute("new") }) }), /* @__PURE__ */ React.createElement("main", { className: "home home-c" }, /* @__PURE__ */ React.createElement("div", { className: "metrics" }, /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("b", null, "1"), /* @__PURE__ */ React.createElement("span", null, "\u9700\u8981\u5904\u7406")), /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("b", null, "1"), /* @__PURE__ */ React.createElement("span", null, "\u8FD0\u884C\u4E2D")), /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("b", null, "12"), /* @__PURE__ */ React.createElement("span", null, "\u672C\u5468\u5B8C\u6210"))), /* @__PURE__ */ React.createElement("div", { className: "queue-group attention" }, /* @__PURE__ */ React.createElement("h3", null, /* @__PURE__ */ React.createElement(Dot, { state: "attention" }), "\u9700\u8981\u5904\u7406"), /* @__PURE__ */ React.createElement("button", { onClick: () => setRoute("chat") }, /* @__PURE__ */ React.createElement("span", null, /* @__PURE__ */ React.createElement("b", null, "\u68C0\u67E5\u7ED3\u7B97\u9875\u56DE\u5F52"), /* @__PURE__ */ React.createElement("small", null, "storefront \xB7 \u7B49\u5F85\u6279\u51C6")), /* @__PURE__ */ React.createElement("time", null, "12m"))), /* @__PURE__ */ React.createElement("div", { className: "queue-group" }, /* @__PURE__ */ React.createElement("h3", null, /* @__PURE__ */ React.createElement(Dot, { state: "running" }), "\u6B63\u5728\u8FD0\u884C"), /* @__PURE__ */ React.createElement("button", { onClick: () => setRoute("chat") }, /* @__PURE__ */ React.createElement("span", null, /* @__PURE__ */ React.createElement("b", null, "\u751F\u6210\u53D1\u5E03\u8BF4\u660E"), /* @__PURE__ */ React.createElement("small", null, "notes \xB7 Qoder")), /* @__PURE__ */ React.createElement("time", null, "2m"))), /* @__PURE__ */ React.createElement("div", { className: "queue-group" }, /* @__PURE__ */ React.createElement("h3", null, "\u6700\u8FD1\u5B8C\u6210"), /* @__PURE__ */ React.createElement("button", { onClick: () => setRoute("chat") }, /* @__PURE__ */ React.createElement("span", null, /* @__PURE__ */ React.createElement("b", null, "\u4FEE\u590D\u8FDC\u7A0B\u4F1A\u8BDD\u5F52\u6863"), /* @__PURE__ */ React.createElement("small", null, "vibecoding \xB7 \u5DF2\u9A8C\u8BC1")), /* @__PURE__ */ React.createElement("time", null, "\u521A\u521A")))), /* @__PURE__ */ React.createElement("nav", { className: "tabs" }, /* @__PURE__ */ React.createElement("button", { className: "active" }, /* @__PURE__ */ React.createElement(Icon, { name: "chat" }), /* @__PURE__ */ React.createElement("span", null, "\u4F1A\u8BDD")), /* @__PURE__ */ React.createElement("button", null, /* @__PURE__ */ React.createElement(Icon, { name: "inbox" }), /* @__PURE__ */ React.createElement("span", null, "\u8FD0\u884C")), /* @__PURE__ */ React.createElement("button", { onClick: () => setRoute("settings") }, /* @__PURE__ */ React.createElement(Icon, { name: "device" }), /* @__PURE__ */ React.createElement("span", null, "\u8BBE\u5907"))));
  }
  function DirectionPhone({ direction }) {
    const [route, setRoute] = useState("home");
    let content;
    if (route === "chat") content = /* @__PURE__ */ React.createElement(Conversation, { direction, setRoute });
    else if (route === "new" || route === "new-rate") content = /* @__PURE__ */ React.createElement(NewTask, { direction, setRoute, initialProject: route === "new-rate" ? "rate-native" : "vibecoding" });
    else if (route === "pair") content = /* @__PURE__ */ React.createElement(Pair, { setRoute });
    else if (route === "settings") content = /* @__PURE__ */ React.createElement(Settings, { setRoute });
    else if (direction === "A") content = /* @__PURE__ */ React.createElement(HomeA, { setRoute });
    else if (direction === "B") content = /* @__PURE__ */ React.createElement(HomeB, { setRoute });
    else content = /* @__PURE__ */ React.createElement(HomeC, { setRoute });
    return /* @__PURE__ */ React.createElement(Shell, { direction, route, setRoute }, content);
  }
  function DecisionCard({ title, accent, points, risk }) {
    return /* @__PURE__ */ React.createElement("div", { className: "decision-card", style: { "--accent": accent } }, /* @__PURE__ */ React.createElement("span", { className: "eyebrow" }, "DIRECTION"), /* @__PURE__ */ React.createElement("h2", null, title), /* @__PURE__ */ React.createElement("ul", null, points.map((p) => /* @__PURE__ */ React.createElement("li", { key: p }, p))), /* @__PURE__ */ React.createElement("div", { className: "tradeoff" }, /* @__PURE__ */ React.createElement("b", null, "\u53D6\u820D"), risk));
  }
  function App() {
    return /* @__PURE__ */ React.createElement(DesignCanvas2, null, /* @__PURE__ */ React.createElement(DCSection2, { id: "directions", title: "Scry Remote v5 \xB7 \u4E09\u4E2A\u7ED3\u6784\u65B9\u5411", subtitle: "\u540C\u4E00\u4EFB\u52A1\u3001\u540C\u4E00\u72B6\u6001\uFF0C\u6BD4\u8F83\u4FE1\u606F\u7ED3\u6784\u800C\u4E0D\u662F\u6362\u76AE\u3002\u70B9\u5F00\u4EFB\u4E00\u4F1A\u8BDD\u3001\u65B0\u5EFA\u6309\u94AE\u6216\u83DC\u5355\u53EF\u67E5\u770B\u6D41\u7A0B\u3002" }, /* @__PURE__ */ React.createElement(DCArtboard2, { id: "codex-refined", label: "A \xB7 Codex Refined \xB7 \u63A8\u8350", width: 390, height: 844 }, /* @__PURE__ */ React.createElement(DirectionPhone, { direction: "A" })), /* @__PURE__ */ React.createElement(DCArtboard2, { id: "chat-first", label: "B \xB7 Chat First", width: 390, height: 844 }, /* @__PURE__ */ React.createElement(DirectionPhone, { direction: "B" })), /* @__PURE__ */ React.createElement(DCArtboard2, { id: "work-queue", label: "C \xB7 Work Queue", width: 390, height: 844 }, /* @__PURE__ */ React.createElement(DirectionPhone, { direction: "C" })), /* @__PURE__ */ React.createElement(DCPostIt2, { top: 110, left: 1325, width: 220, rotate: 1 }, "\u5148\u770B\u7ED3\u6784\uFF1AA \u6700\u8D34\u8FD1 Codex\uFF1BB \u53D1\u8D77\u4EFB\u52A1\u6700\u5FEB\uFF1BC \u6700\u9002\u5408\u9AD8\u9891\u5BA1\u6279\u548C\u8FD0\u884C\u7BA1\u7406\u3002")), /* @__PURE__ */ React.createElement(DCSection2, { id: "decision", title: "\u51B3\u7B56\u6458\u8981", subtitle: "\u4E09\u5957\u90FD\u4FDD\u7559\u771F\u5B9E\u8FDE\u63A5\u4E0E\u8FD0\u884C\u8BED\u4E49\uFF1B\u9009\u5B9A\u540E\u518D\u8865\u9F50\u5168\u91CF\u72B6\u6001\u5E76\u843D\u5730 SwiftUI\u3002" }, /* @__PURE__ */ React.createElement(DCArtboard2, { id: "a-notes", label: "A \xB7 \u4E3A\u4EC0\u4E48\u63A8\u8350", width: 340, height: 360 }, /* @__PURE__ */ React.createElement(DecisionCard, { title: "Codex Refined", accent: "#2867e8", points: ["\u65E0\u5E95\u680F\uFF0C\u5185\u5BB9\u6700\u5B89\u9759", "\u9879\u76EE\u6210\u4E3A\u4E0A\u4E0B\u6587\uFF0C\u4E0D\u518D\u91CD\u590D\u4F1A\u8BDD", "\u8BC1\u636E\u6298\u53E0\u5728\u56DE\u590D\u4E0B\u65B9", "\u65B0\u4EFB\u52A1\u4E0A\u4E0B\u6587\u9760\u8FD1\u8F93\u5165"], risk: "\u591A\u4E3B\u673A\u4E0E\u5BA1\u6279\u5165\u53E3\u9700\u8981\u653E\u8FDB\u83DC\u5355\u6216\u72B6\u6001\u7B5B\u9009\u3002" })), /* @__PURE__ */ React.createElement(DCArtboard2, { id: "b-notes", label: "B \xB7 \u6700\u77ED\u8DEF\u5F84", width: 340, height: 360 }, /* @__PURE__ */ React.createElement(DecisionCard, { title: "Chat First", accent: "#111827", points: ["\u9996\u9875\u5373\u8F93\u5165", "\u5386\u53F2\u7ED3\u6784\u6781\u7B80", "\u6700\u63A5\u8FD1\u901A\u7528 AI \u5BF9\u8BDD\u4E60\u60EF", "\u9996\u6B21\u4F7F\u7528\u5B66\u4E60\u6210\u672C\u4F4E"], risk: "\u9879\u76EE\u4E0E\u8FD0\u884C\u72B6\u6001\u88AB\u5F31\u5316\uFF0C\u4E0D\u5229\u4E8E\u8FDC\u7A0B\u7BA1\u7406\u591A\u4E2A\u4EFB\u52A1\u3002" })), /* @__PURE__ */ React.createElement(DCArtboard2, { id: "c-notes", label: "C \xB7 \u6700\u5F3A\u63A7\u5236", width: 340, height: 360 }, /* @__PURE__ */ React.createElement(DecisionCard, { title: "Work Queue", accent: "#6d4aff", points: ["\u5F85\u5904\u7406\u4F18\u5148", "\u8FD0\u884C\u4E0E\u8BBE\u5907\u72EC\u7ACB\u5165\u53E3", "\u72B6\u6001\u626B\u63CF\u6548\u7387\u6700\u9AD8", "\u9002\u5408\u91CD\u5EA6\u8FDC\u7A0B\u7528\u6237"], risk: "\u5BFC\u822A\u66F4\u91CD\uFF0C\u66F4\u50CF\u5DE5\u7A0B\u63A7\u5236\u53F0\uFF0C\u548C Codex \u7684\u8F7B\u91CF\u611F\u8DDD\u79BB\u6700\u5927\u3002" }))));
  }
  ReactDOM.createRoot(document.getElementById("root")).render(/* @__PURE__ */ React.createElement(App, null));
})();
