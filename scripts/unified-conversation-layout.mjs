import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

const json = JSON.stringify

export async function checkConversationLayout(evaluate, screenshots, name) {
  // This capture helper also serves management/fork fixtures with different content.
  if (['preview', 'preview-narrow', 'timeline', 'timeline-narrow'].includes(name)) {
    const layout = await evaluate(`(() => {
      const node = selector => {
        const el = document.querySelector(selector);
        if (!el) throw new Error('Missing layout target: ' + selector);
        return el;
      };
      const style = selector => getComputedStyle(node(selector));
      const label = node('.conversation-chat .clibtn > span:not(.agicon)');
      const color = token => {
        const probe = document.createElement('span');
        probe.style.color = 'var(' + token + ')'; document.body.append(probe);
        const value = getComputedStyle(probe).color; probe.remove(); return value;
      };
      const who = style('.conversation-chat .who');
      const files = style('.conversation-chat .files-summary');
      const summary = style('.conversation-chat .files-summary > summary');
      const assistant = style('.conversation-chat .turn-assistant');
      const controls = ['.clibtn', '.model-effort-trigger', '.send'].map(selector => {
        const rect = node('.conversation-chat ' + selector).getBoundingClientRect();
        return {selector, left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom};
      });
      const shell = node('.conversation-chat .composer-shell').getBoundingClientRect();
      return {
        width: innerWidth, theme: document.documentElement.dataset.theme,
        profile: {name: label.textContent, title: label.title, width: label.clientWidth, contentWidth: label.scrollWidth,
          overflow: getComputedStyle(label).textOverflow, fontSize: getComputedStyle(label).fontSize},
        reading: ['.model-text:not(.thinking)', '.bubble-user', 'textarea'].map(selector => style('.conversation-chat ' + selector).fontSize),
        who: {fontSize: who.fontSize, lineHeight: who.lineHeight, color: who.color},
        runId: {fontSize: style('.conversation-chat .who .runid').fontSize, color: style('.conversation-chat .who .runid').color},
        mini: {fontSize: style('.conversation-chat .who .mini').fontSize, color: style('.conversation-chat .who .mini').color},
        footer: style('.conversation-chat .turn-footer').fontSize,
        footerValue: style('.conversation-chat .turn-footer .stat b').fontSize,
        footerValueWeight: style('.conversation-chat .turn-footer .stat b').fontWeight,
        footerValueSpacing: style('.conversation-chat .turn-footer .stat b').letterSpacing,
        footerLabel: {fontSize: style('.conversation-chat .turn-footer .lbl').fontSize, color: style('.conversation-chat .turn-footer .lbl').color,
          fontWeight: style('.conversation-chat .turn-footer .lbl').fontWeight, letterSpacing: style('.conversation-chat .turn-footer .lbl').letterSpacing,
          textTransform: style('.conversation-chat .turn-footer .lbl').textTransform},
        turnMarginBottom: style('.conversation-chat .transcript-turn').marginBottom,
        editorHeight: node('.conversation-chat textarea').getBoundingClientRect().height,
        turnBottom: style('.conversation-chat .transcript-turn').paddingBottom,
        nextTurnTop: style('.conversation-chat .transcript-turn + .transcript-turn').paddingTop,
        flowGap: style('.conversation-chat .turn-flow').gap,
        files: {marginTop: files.marginTop, radius: files.borderRadius, borderWidth: files.borderTopWidth,
          minHeight: summary.minHeight, paddingLeft: summary.paddingLeft, paddingRight: summary.paddingRight},
        assistantPadding: assistant.padding,
        sidebar: {marginTop: style('.sb-section').marginTop, sessionHeight: style('.sb-sess').height, projectHeight: style('.sb-proj-head').height},
        dim: color('--dim'), dim2: color('--dim2'), controls,
        shell: {left: shell.left, right: shell.right}
      };
    })()`)
    const context = `${name}/${layout.theme}/${layout.width}px`
    writeFileSync(join(screenshots, `${name}-${layout.theme}-layout.json`), json(layout))
    assert.ok(layout.profile.width >= layout.profile.contentWidth, `current Agent Profile is needlessly truncated: ${context}: ${json(layout.profile)}`)
    assert.equal(layout.profile.title, layout.profile.name, `full Profile tooltip: ${context}`)
    assert.equal(layout.profile.overflow, 'ellipsis', `long Profile overflow protection: ${context}`)
    assert.equal(layout.profile.fontSize, '12px', `Profile text must not shrink: ${context}`)
    assert.deepEqual(layout.reading, ['15px', '15px', '15px'], `reading text stays --text-reading: ${context}`)
    assert.deepEqual(layout.who, {fontSize: '12px', lineHeight: '16.8px', color: layout.dim2}, context)
    for (const metadata of [layout.runId, layout.mini]) assert.deepEqual(metadata, {fontSize: '12px', color: layout.dim2}, context)
    assert.equal(layout.footer, '12px', context)
    assert.equal(layout.footerValue, '12px', context)
    assert.equal(layout.footerValueWeight, '500', `footer stat value weight: ${context}`)
    assert.equal(layout.footerValueSpacing, 'normal', `footer stat value spacing: ${context}`)
    assert.deepEqual(layout.footerLabel, {fontSize: '11px', color: layout.dim, fontWeight: '400', letterSpacing: 'normal', textTransform: 'uppercase'}, context)
    assert.equal(layout.turnMarginBottom, '0px', `no inherited turn margin: ${context}`)
    assert.equal(layout.editorHeight, 64, `preserve composer editing area: ${context}`)
    assert.equal(layout.turnBottom, '12px', context)
    assert.equal(layout.nextTurnTop, '16px', context)
    assert.equal(layout.flowGap, '8px', context)
    assert.deepEqual(layout.files, {marginTop: '8px', radius: '8px', borderWidth: '0px', minHeight: '36px', paddingLeft: '12px', paddingRight: '12px'}, context)
    assert.equal(layout.assistantPadding, '16px', context)
    assert.deepEqual(layout.sidebar, {marginTop: '12px', sessionHeight: '36px', projectHeight: '32px'}, context)
    for (const control of layout.controls) assert.ok(control.left >= layout.shell.left && control.right <= layout.shell.right,
      `composer control overflows its shell: ${context}: ${json(control)}`)
    for (let index = 1; index < layout.controls.length; index++) {
      assert.ok(layout.controls[index - 1].right <= layout.controls[index].left,
        `composer controls overlap: ${context}: ${json(layout.controls)}`)
    }
  }
}
