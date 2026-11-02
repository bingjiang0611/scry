import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync, symlinkSync, copyFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir, loadavg, cpus } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import electron from 'electron'
import { stopOwnedApp } from './owned-app-processes.mjs'
import { nativeUiPointer } from './native-ui-pointer.mjs'
import { connectConcurrentApp } from './concurrent-performance-cdp.mjs'
import { summarizeHookTrees, assertScopedDelivery } from './concurrent-performance-summary.mjs'
import { exerciseConcurrentDiffDemand } from './concurrent-diff-demand-ui.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const count = Number(process.argv[2] ?? 1)
assert.ok([1, 3, 5].includes(count), 'Expected N=1/3/5')
const expectedHookStartsPerSession = Number(process.argv[3] ?? 42)
assert.ok([2, 42].includes(expectedHookStartsPerSession), 'Expected 2 lifecycle-only or 42 full CLI receipts/session')
const temp = mkdtempSync(join(tmpdir(), `scry-concurrent-n${count}-`))
const home = join(temp, 'home')
const userData = join(temp, 'userData')
const workspaces = Array.from({ length: count }, (_, index) => join(home, `workspace-${index}`))
for (const dir of [home, userData, ...workspaces]) mkdirSync(dir, { recursive: true })
for (let index = 0; index < workspaces.length; index++) workspaces[index] = realpathSync(workspaces[index])
const cwd = workspaces[0]
const probe = join(root, 'scripts/concurrent-performance-probe.cjs')
const probeLog = join(temp, 'probe.jsonl')
const appLog = join(temp, 'app.log')
const initialLoad = loadavg()
let child, cdp, cleanup
const output = []
const hash = value => createHash('sha256').update(value).digest('hex')
const files = ['scripts/concurrent-performance.mjs', 'scripts/concurrent-performance-probe.cjs',
  'scripts/concurrent-performance.config.ts', 'scripts/fixtures/concurrent-performance-provider.ts', 'scripts/native-ui-pointer.mjs',
  'scripts/concurrent-performance-cdp.mjs', 'scripts/concurrent-performance-summary.mjs', 'scripts/concurrent-diff-demand-ui.mjs']
const harnessHash = hash(files.map(path => readFileSync(join(root, path))).join('\0'))
const artifactHash = () => hash(['out', 'packages/turn-recorder-cli/dist'].flatMap(dir =>
  readdirSync(join(root, dir), { recursive: true, withFileTypes: true }).filter(entry => entry.isFile()).map(entry =>
    join(entry.parentPath, entry.name))).sort().map(path => `${path.slice(root.length)}\0${hash(readFileSync(path))}`).join('\n'))


try {
  const artifactSha256 = artifactHash()
  // Exact production hook shell and packaged CLI wrapper; only the offline adapter is substituted.
  const contents = join(temp, 'cli/Contents')
  const resources = join(contents, 'Resources')
  const bin = join(resources, 'bin')
  mkdirSync(bin, { recursive: true })
  mkdirSync(join(contents, 'MacOS'))
  mkdirSync(join(resources, 'scry-cli'))
  symlinkSync(electron, join(contents, 'MacOS/Scry'))
  symlinkSync(join(root, 'packages/turn-recorder-cli/dist'), join(resources, 'scry-cli/dist'))
  const cli = join(bin, 'scry')
  copyFileSync(join(root, 'build/scry-cli'), cli)
  execFileSync('/bin/chmod', ['+x', cli])
  for (const cwd of workspaces) {
    execFileSync('git', ['init', '-q', cwd])
    writeFileSync(join(cwd, '.gitignore'), '.scry/\n')
    writeFileSync(join(cwd, 'seed.txt'), 'Fixed concurrent workload\n')
    writeFileSync(join(cwd, 'scry.config.json'), JSON.stringify({ schemaVersion: 1, enabled: true,
      workspaceId: `concurrent-performance-${workspaces.indexOf(cwd)}`, dataDir: '.scry', repositories: { mode: 'workspace-only' } }))
    execFileSync('git', ['-C', cwd, 'add', '.'])
    execFileSync('git', ['-C', cwd, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture'])
    mkdirSync(join(cwd, '.scry'))
    copyFileSync(join(root, 'out/main/concurrent-provider-hook.sh'), join(cwd, '.scry/provider-hook.sh'))
    writeFileSync(join(cwd, '.scry/cli-path'), `${cli}\n`)
    writeFileSync(join(cwd, '.scry/node-bin-dir'), `${dirname(process.execPath)}\n`)
  }
  // Seed only the temporary App's existing project authority, as other native fixtures do.
  writeFileSync(join(userData, 'recent-folders.json'), JSON.stringify(workspaces))
  const bootstrap = join(temp, 'app')
  mkdirSync(bootstrap)
  writeFileSync(join(bootstrap, 'package.json'), JSON.stringify({ name: 'scry-concurrent-measurement', version: '0.0.0', main: 'main.cjs' }))
  writeFileSync(join(bootstrap, 'main.cjs'), `
    const { app } = require('electron');
    app.setAppPath(${JSON.stringify(root)});
    require(${JSON.stringify(probe)});
    // Hidden native fixture, but foreground renderer workload (including visibility-gated polling).
    app.on('browser-window-created', (_event, win) => win.webContents.setBackgroundThrottling(false));
    require(${JSON.stringify(join(root, 'scripts/hidden-electron-windows.cjs'))})(app);
    require(${JSON.stringify(join(root, 'out/main/index.js'))});
  `)
  const server = createServer()
  await new Promise(ready => server.listen(0, '127.0.0.1', ready))
  const port = server.address().port
  await new Promise(ready => server.close(ready))
  const env = { ...process.env, HOME: home, SCRY_TEST_APP: '1', SCRY_PERF_LOG: '1', ELECTRON_ENABLE_LOGGING: '1',
    SCRY_ELECTRON_SMOKE_PROVIDER: '1', SCRY_ELECTRON_SMOKE_CONVERSATIONS: '1', SCRY_DISABLED_PROVIDERS: 'codex,qoder,opencode,pi', SCRY_REMOTE_HOST: '0',
    SCRY_CLI_PATH: cli, SCRY_CONCURRENT_PROBE: probe, SCRY_CONCURRENT_LOG: probeLog, SCRY_CONCURRENT_ROLE: 'main' }
  delete env.NODE_OPTIONS
  child = spawn(electron, [bootstrap, `--remote-debugging-port=${port}`, `--user-data-dir=${userData}`,
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--no-first-run'], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.on('data', data => output.push(String(data)))
  child.stderr.on('data', data => output.push(String(data)))
  cdp = await connectConcurrentApp(port, child)
  const evaluate = async expression => {
    const response = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text)
    return response.result.value
  }
  const wait = async expression => evaluate(`(async () => {
    const deadline = Date.now() + 30000;
    while (!(${expression})) { if (Date.now() > deadline) throw new Error('Condition timeout: ' + ${JSON.stringify(expression)}); await new Promise(r => setTimeout(r, 50)); }
    return true;
  })()`)
  const activate = async selector => {
    await wait(`document.querySelector(${JSON.stringify(selector)})`)
    // Reuse the native fixture's settled-geometry and trusted-hit receipt checks.
    // Perpetual sweep animations remain active; only finite layout motion must finish.
    const point = await evaluate(`(${nativeUiPointer.toString()})(${JSON.stringify(selector)}, { timeoutMs: 20000, scroll: true, captureReceipt: true })`)
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point })
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point })
    await wait('window.__nativeUiPointerReceipt')
    const receipt = await evaluate('window.__nativeUiPointerReceipt')
    assert.ok(receipt.trusted && receipt.targetMatched, `Native pointer missed ${selector}: ${JSON.stringify(receipt)}`)
  }
  await wait(`typeof window.scry === 'object'`)
  assert.equal(await evaluate('document.visibilityState'), 'visible', 'Fixture must exercise visibility-gated work')
  const detected = await evaluate('window.scry.detectFast()')
  assert.ok(detected.some(agent => agent.id === 'claude' && agent.name === 'claude Smoke Fixture'), 'Missing offline Claude adapter')
  assert.ok(detected.every(agent => agent.name.endsWith('Smoke Fixture')), 'Refusing a real Provider workload')
  await activate('.sb-view-tabs [role="tab"][id$="-activity"]')
  await wait(`document.querySelector('.sb-activity')`)
  await cdp.send('Performance.enable')
  const conversations = await evaluate(`(async () => {
    const result = [];
    for (let i=0; i<${count}; i++) {
      const c = await window.scry.conversations.create(${JSON.stringify(workspaces)}[i]);
      const named = await window.scry.conversations.update(c.id, c.revision, {kind:'rename',title:'Concurrent session '+i});
      const preview = await window.scry.conversations.preview(c.id,{providerId:'claude'});
      result.push({id:c.id, cwd:c.cwd, revision:named.revision, preview});
    }
    return result;
  })()`)
  // Fixed idle windows expose the observer's baseline and post-settlement memory, not GC-proof retention.
  const idleBeforeAt = Date.now()
  await evaluate('new Promise(r => setTimeout(r, 3000))')
  const beforeMetrics = await cdp.send('Performance.getMetrics')
  await cdp.send('Tracing.start', { categories: 'devtools.timeline', transferMode: 'ReportEvents' })
  const startedAt = Date.now()
  const outcome = evaluate(`(async () => {
    const conversations = ${JSON.stringify(conversations)};
    const done = new Map(), errors = [], first = new Map();
    const offDone = window.scry.onTurnDone(e => done.set(e.runId, {event:e,at:Date.now()}));
    const offError = window.scry.onError(e => errors.push(e));
    const offTrace = window.scry.onTrace(events => { for(const e of events) if(e.kind==='model'&&!first.has(e.runId)) first.set(e.runId,Date.now()); });
    try {
      const starts = await Promise.all(conversations.map((c,i) => window.scry.conversations.send({conversationId:c.id,
        expectedRevision:c.preview.revision,expectedContinuationKey:c.preview.target.continuationKey,commandId:'concurrent-'+i,
        providerId:'claude',prompt:'concurrent performance '+i,selectedItems:[],confirmFresh:true})));
      window.__concurrentStarts = starts;
      const deadline = Date.now()+120000;
      while(starts.some(s=>!done.has(s.runId))) {
        if(errors.length) throw new Error(JSON.stringify(errors));
        if(Date.now()>deadline) throw new Error('Concurrent terminal deadline');
        await new Promise(r=>setTimeout(r,100));
      }
      const pages = await Promise.all(conversations.map(c=>window.scry.conversations.read(c.id)));
      const runs = starts.map((s,i)=>{
        const turn=pages[i].turns.find(t=>t.runId===s.runId);
        if(!turn?.history?.done || !turn.history.items.some(e=>e.text==='CONCURRENT_FIXTURE_COMPLETE')) throw new Error('Missing durable output '+s.runId);
        return {runId:s.runId,cwd:conversations[i].cwd,terminal:done.get(s.runId),firstOutputAt:first.get(s.runId)};
      });
      return {runs,ui:{visibility:document.visibilityState,runningRows:document.querySelectorAll('.sb-sess').length,transcript:!!document.querySelector('.chat-transcript'),
        transcriptComplete:document.querySelector('.chat-transcript')?.textContent.includes('CONCURRENT_FIXTURE_COMPLETE')}};
    } finally {offDone();offError();offTrace();}
  })()`).then(result => ({ result }), error => ({ error }))
  await Promise.race([wait(`window.__concurrentStarts?.length === ${count}`), outcome.then(finished => { if (finished.error) throw finished.error })])
  // Open AFTER dispatch: the component's send handler normally refreshes its own page;
  // direct IPC dispatch does not run that handler. Mount the real view on the active turn.
  await activate(`button[data-conversation-id="${conversations[0].id}"]`)
  await wait(`document.querySelector('main.unified-conversation[data-conversation-id="${conversations[0].id}"]')`)
  const animatedTitles = await evaluate(`Array.from(document.querySelectorAll('.sb-activity [data-activity-group="working"] .sb-sesstext')).filter(e => getComputedStyle(e).animationName === 'sb-activity-sweep').length`)
  assert.ok(animatedTitles >= count, 'Activity sidebar must exercise the production sweep animation')
  const demandAcceptance = await exerciseConcurrentDiffDemand({
    evaluate, activate, wait, conversations, cdp, mode: process.env.SCRY_CONCURRENT_DEMAND_UI
  })
  const finished = await outcome
  if (finished.error) throw finished.error
  const result = finished.result
  const terminalAt = Date.now()
  await wait(`document.querySelector('main.unified-conversation .chat-transcript')?.textContent.includes('CONCURRENT_FIXTURE_COMPLETE')`)
  await evaluate('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))')
  const settledAt = Date.now()
  result.ui.transcriptComplete = true
  result.ui.animatedTitles = animatedTitles
  if (demandAcceptance) {
    result.ui.demandAcceptance = { ...demandAcceptance, evidence: 'Production App, native trusted-hit switching and real Git; diagnostic activeRuns reads; not an end-to-end latency benchmark' }
    console.log('SCRY_DIFF_DEMAND_UI=' + JSON.stringify(result.ui.demandAcceptance))
  }
  const afterMetrics = await cdp.send('Performance.getMetrics')
  let traceTimer
  try {
    await cdp.send('Tracing.end')
    await Promise.race([cdp.tracingDone, new Promise((_, reject) => { traceTimer = setTimeout(() => reject(new Error('Trace completion deadline')), 30000) })])
  } finally { clearTimeout(traceTimer) }
  await evaluate('new Promise(r => setTimeout(r, 3000))')
  const closing = child
  child = null
  cleanup = await stopOwnedApp(closing)
  const paintTrace = cdp.trace
  cdp.close(); cdp = null
  writeFileSync(appLog, output.join(''))
  const probes = readFileSync(probeLog, 'utf8').trim().split('\n').map(line => JSON.parse(line))
  const main = probes.find(p => p.role === 'main')
  assert.ok(main, 'Missing main probe shutdown receipt')
  assertScopedDelivery(main, result.runs[0].runId, startedAt, settledAt)
  assert.equal(main.hookTrees.length, count * 42, 'Every shell Hook needs a process-tree receipt')
  summarizeHookTrees(main.hookTrees)
  const hooks = probes.filter(p => p.role === 'hook')
  assert.equal(hooks.length, count * expectedHookStartsPerSession, 'Missing or extra Hook CLI receipts')
  assert.ok(hooks.every(p => p.argv.includes('--managed')), 'Hooks must use managed CLI')
  for (const cwd of workspaces) {
    const delivered = hooks.filter(p => p.argv[p.argv.indexOf('--workspace') + 1] === cwd)
    const events = delivered.map(p => p.argv[p.argv.indexOf('--event') + 1])
    assert.equal(events.filter(event => event === 'UserPromptSubmit').length, 1, 'Each run needs its actual start Hook')
    assert.equal(events.filter(event => event === 'Stop').length, 1, 'Each run needs its actual terminal Hook')
    for (const event of ['PreToolUse', 'PostToolUse']) {
      assert.equal(events.filter(value => value === event).length, expectedHookStartsPerSession === 42 ? 20 : 0)
    }
  }
  for (const cwd of workspaces) {
    const skips = join(cwd, '.scry/logs/hook-skip.log')
    try { assert.equal(readFileSync(skips, 'utf8').trim(), '', 'Hook shell silently failed') } catch(error) { if(error.code!=='ENOENT') throw error }
  }
  const archiveRoot = join(userData, 'trace-archive-turns-v1')
  const turns = readdirSync(archiveRoot, { recursive: true }).filter(p=>p.endsWith('.json')).flatMap(p=>{
    const archive=JSON.parse(readFileSync(join(archiveRoot,p),'utf8')); return archive.version===3?archive.turns??[]:[]
  })
  for(const run of result.runs) {
    const turn=turns.find(t=>t.runId===run.runId)
    assert.ok(turn?.done && turn.items.some(e=>e.text==='CONCURRENT_FIXTURE_COMPLETE'), 'Output must survive App exit')
    assert.equal(turn.items.filter(e=>e.kind==='tool'&&e.stage==='tool_result').length,20,'No lost tool results')
  }
  const records = workspaces.flatMap(cwd => {
    const recordRoot = join(cwd, '.scry/records')
    return readdirSync(recordRoot, { recursive: true }).filter(p => p.endsWith('.json')).map(p => JSON.parse(readFileSync(join(recordRoot, p), 'utf8')))
  })
  assert.equal(records.length,count,'Canonical recorder must converge once per run')
  for (const run of result.runs) {
    const record = records.find(record => record.providerTurnId === `${run.runId}:provider-turn`)
    assert.equal(record?.status, 'completed', 'Each run needs its own completed canonical record')
    assert.equal(record.tools.status, 'available')
    assert.equal(record.tools.value.length, 20, 'Canonical record must retain all tool calls')
    assert.equal(record.assistant.status, 'available')
    assert.equal((record.assistant.value.text.match(/Step \d+, delta \d+\./g) ?? []).length, 400, 'No lost stream deltas')
    for (let step = 0; step < 20; step++) {
      assert.ok(readFileSync(join(run.cwd, `fixture-${run.runId}-${step}.txt`), 'utf8').startsWith(`${run.runId} step ${step}\n`))
    }
  }
  assert.equal(artifactHash(), artifactSha256, 'Measured build changed during the run')
  assert.equal(hash(files.map(path => readFileSync(join(root, path))).join('\0')), harnessHash, 'Harness changed during the run')
  const metrics = snapshot=>Object.fromEntries(snapshot.metrics.map(m=>[m.name,m.value]))
  const a=metrics(beforeMetrics), b=metrics(afterMetrics)
  const report={schema:1,count,harnessHash,artifactSha256,lockfileSha256:hash(readFileSync(join(root,'package-lock.json'))),platform:`${process.platform}/${process.arch}`,sourceRevision:process.env.SCRY_MEASURE_REVISION??'unknown',temp,cwd,workspaces,initialLoad,finalLoad:loadavg(),cores:cpus().length,
    node:process.version,electron:JSON.parse(readFileSync(join(root,'node_modules/electron/package.json'))).version,
    idleBeforeAt,startedAt,terminalAt,settledAt,finishedAt:Date.now(),workload:{toolsPerSession:20,deltasPerSession:400,hookStarts:hooks.length,expectedHookStartsPerSession,sharedRepository:false,sidebar:'activity',activation:'settled-native-pointer'},
    result,cleanup,canonicalRecords:records.length,archiveVerified:true,trace:paintTrace,
    rendererMetrics:Object.fromEntries(['TaskDuration','ScriptDuration','LayoutDuration','RecalcStyleDuration','LayoutCount','RecalcStyleCount'].map(k=>[k,b[k]-a[k]])),
    main,hooks,
    limitations:['Isolated hidden window with GPU enabled and backgroundThrottling=false; not visible-window or visual-equivalence acceptance.',
      'CPU/memory of real Provider/MCP excluded by offline adapter.', 'fsync/git counts cover instrumented main and Hook Node processes, not workers or shell internals.',
      'activeRuns bytes are JSON size, not Electron wire bytes; observer serializes each actual response once.',
      'No forced GC; post-run memory is not proof of a leak.']}
  writeFileSync(join(temp,'result.json'),JSON.stringify(report,null,2))
  console.log(JSON.stringify({status:'measured',count,temp,result:join(temp,'result.json'),hookStarts:hooks.length,canonicalRecords:records.length,elapsedMs:settledAt-startedAt}))
} catch(error) {
  writeFileSync(appLog,output.join(''))
  const diagnostics = cdp ? await Promise.allSettled([cdp.send('Runtime.evaluate', { returnByValue: true,
    expression: `({ visibility: document.visibilityState, conversation: document.querySelector('main.unified-conversation')?.dataset.conversationId,
      selected: document.querySelector('.sb-sess[aria-current="true"]')?.dataset.conversationId,
      focused: document.activeElement?.outerHTML.slice(0, 1000), activation: window.__nativeUiPointerReceipt })` })]) : []
  console.error(JSON.stringify({status:'failed',count,temp,error:String(error),stack:error.stack,diagnostics}))
  process.exitCode=1
} finally {
  cdp?.close()
  if(child) { const closing=child; child=null; const cleanup=await stopOwnedApp(closing); writeFileSync(join(temp,'cleanup.json'),JSON.stringify(cleanup)) }
}
