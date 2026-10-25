import * as shared from './shared'
const { describe, it, expect, renderToStaticMarkup, overviewToolErrors, OverviewPanel, TurnToolErrorDetails, ev } = shared
type TraceEvent = shared.TraceEvent
type Turn = shared.Turn

describe('OverviewPanel verdict 诚实态：error 不显绿 / danger→bad / busy→运行中 / 不冒充"blocked"', () => {
  const panel = (t: Turn, busy = false): string =>
    renderToStaticMarkup(
      <OverviewPanel turns={[t]} selected={null} onSelect={() => {}} usage={null} stats={null} busy={busy} />
    )
  const dangerTurn = (): { t: Turn; dangerEv: TraceEvent } => {
    const dangerEv = ev({
      id: 'td1',
      kind: 'tool',
      stage: 'tool:Bash',
      tool: 'Bash',
      toolUseId: 'td1',
      danger: { level: 'danger', reason: 'rm -rf 强删' }
    })
    return {
      dangerEv,
      t: {
        runId: 'dg',
        userText: 'x',
        done: true,
        items: [dangerEv, ev({ id: 'td2', kind: 'harness', stage: 'result', costUsd: 0.01, tokensIn: 10, tokensOut: 5 })]
      }
    }
  }

  it('工具报错归入对应轮次，并可展开查看输入、输出与提取后的错误信息', () => {
    const output = JSON.stringify({ content: [{ type: 'text', text: 'role-only UI condition requires ref' }], isError: true })
    const t: Turn = {
      runId: 'er',
      userText: 'x',
      done: true,
      items: [
        ev({ id: 'te1', kind: 'tool', stage: 'tool:act_ui', tool: 'act_ui', toolUseId: 'tu1', input: { action: 'click', role: 'button' } }),
        ev({ id: 'te2', kind: 'tool', stage: 'tool_result', toolUseId: 'tu1', isError: true, output }),
        ev({ id: 'te3', kind: 'harness', stage: 'result', costUsd: 0.01, tokensIn: 10, tokensOut: 5 })
      ]
    }
    const errors = overviewToolErrors(t.items)
    const html = panel(t)
    const detailsHtml = renderToStaticMarkup(<TurnToolErrorDetails errors={errors} onOpen={() => {}} />)

    expect(html).toContain('overview-verdict warn')
    expect(html).toContain('处工具报错')
    expect(html).toContain('class="turn-call-group error"')
    expect(html).toContain('aria-label="本轮工具报错详情"')
    expect(html).not.toContain('overview-tool-errors')
    expect(html).not.toContain('overview-verdict ok') // 失败会话顶绿色健康判决 = 假状态
    expect(errors).toMatchObject([{
      tool: 'act_ui',
      input: { action: 'click', role: 'button' },
      output,
      message: 'role-only UI condition requires ref'
    }])
    expect(detailsHtml).toContain('<span>输入</span>')
    expect(detailsHtml).toContain('&quot;action&quot;: &quot;click&quot;')
    expect(detailsHtml).toContain('<span>输出</span>')
    expect(detailsHtml).toContain('isError')
    expect(detailsHtml).toContain('<span>报错信息</span>')
    expect(detailsHtml).toContain('role-only UI condition requires ref')
    expect(detailsHtml).toContain('定位到对话')
  })

  it('部分证据保留 Token 下界，成本仅显示金额并保留缺失提示', () => {
    const html = renderToStaticMarkup(
      <OverviewPanel
        turns={[
          { runId: 'known', userText: 'one', done: true, items: [ev({ id: 'known-result', kind: 'harness', stage: 'result', tokensIn: 10, tokensOut: 5, costUsd: 29.14 })] },
          { runId: 'missing', userText: 'two', done: true, items: [ev({ id: 'missing-result', kind: 'harness', stage: 'result' })] }
        ]}
        selected={null}
        onSelect={() => {}}
        usage={null}
        stats={null}
      />
    )

    expect(html).toContain('<strong>≥15</strong>')
    expect(html).toContain('<strong>$29.14</strong>')
    expect(html).toContain('title="1/2 轮上报了成本"')
    expect(html).not.toContain('≥$')
    expect(html).not.toContain('tok+')
  })

  it('高危操作 → 判决 bad，详细审计仍明确未拦截且不再占用指标栏', () => {
    const { t } = dangerTurn()
    const html = panel(t)
    expect(html).toContain('overview-verdict bad')
    expect(html).toContain('overview-verdict-line')
    expect(html).toContain('1 处高危操作')
    expect(html).toContain('rm -rf 强删')
    expect(html).not.toContain('审计·未拦截') // 四栏副文案已移除
    expect(html).toContain('观测标记（不阻塞、默认放行）')
    expect(html).not.toContain('class="overview-metric overview-metric-action bad"')
    expect(html).not.toContain('<span>危险</span>')
    expect(html).toContain('class="panel-section danger-audit-section"')
    expect(html).toContain('class="callrow danger-audit-row"')
    expect(html).toContain('aria-label="跳到左侧对话中的这次 Bash 调用：rm -rf 强删"')
    expect(html).not.toContain('blocked') // 不冒充蓝本 demo 的"已阻断"语义
  })

  it('移除冗余 topbar 状态行后，判决卡仍使用真实会话 verdict', () => {
    const { t, dangerEv } = dangerTurn()
    const html = renderToStaticMarkup(
      <OverviewPanel turns={[t]} selected={dangerEv} onSelect={() => {}} usage={null} stats={null} />
    )
    expect(html).toContain('<span class="sdot bad"></span><strong>1 处高危操作</strong>')
    expect(html).not.toContain('title="会话状态')
  })

  it('busy → 静态运行中状态（仅在真 busy 时）', () => {
    const t: Turn = {
      runId: 'rn',
      userText: 'x',
      done: false,
      items: [ev({ id: 'rn1', kind: 'tool', stage: 'tool:Bash', tool: 'Bash', toolUseId: 'r1' })]
    }
    const html = panel(t, true)
    expect(html).toContain('运行中')
    expect(html).not.toContain('轮已结束')
    expect(html).not.toContain('Provider 终态不代表用户目标完成')
    expect(html).toContain('overview-verdict warn')
  })

  it('指标区只展示 Token、缓存命中率与成本，不再展示输入/输出', () => {
    const html = renderToStaticMarkup(
      <OverviewPanel
        turns={[
          {
            runId: 'coverage-1',
            userText: 'one',
            done: true,
            items: [ev({ id: 'coverage-result-1', kind: 'harness', stage: 'result', tokensIn: 10, tokensOut: 5, reasoningTokens: 4, cacheReadTokens: 7, cacheCreationTokens: 2, durationApiMs: 1000 })]
          },
          {
            runId: 'coverage-2',
            userText: 'two',
            done: true,
            items: [ev({ id: 'coverage-result-2', kind: 'harness', stage: 'result', tokensIn: 3 })]
          }
        ]}
        selected={null}
        onSelect={() => {}}
        usage={null}
        stats={null}
      />
    )

    expect(html).not.toContain('<span>输入 / 输出</span>')
    expect(html).not.toContain('<strong>13 / 5</strong>')
    expect(html.match(/class="overview-metric(?: |")/g)).toHaveLength(3)
    expect(html).toContain('<span>缓存命中率 · 部分</span><strong>36.8%</strong>')
    expect(html).toContain('<span>成本</span><strong>—</strong>')
    expect(html).not.toContain('<span>调用</span>')
    expect(html).not.toContain('<span>危险</span>')
    expect(html).not.toContain('cache·r')
    expect(html).not.toContain('cache·w')
    expect(html).not.toContain('<b>reason</b>')
    expect(html).not.toContain('<b>api</b>')
    expect(html).not.toContain('overview-metric-foot')
  })

  it('Qoder 会话的第三栏显示 Credit，不把它冒充美元成本', () => {
    const html = renderToStaticMarkup(
      <OverviewPanel
        turns={[{
          runId: 'qoder-credit',
          userText: 'one',
          done: true,
          items: [
            ev({ id: 'qoder-result', kind: 'harness', stage: 'result', providerId: 'qoder', runtimeProvider: 'qoder_cli', tokensIn: 100, tokensOut: 20, cacheReadTokens: 40, cacheCreationTokens: 10, costUsd: 9 }),
            ev({
              id: 'qoder-credit-result',
              kind: 'harness',
              stage: 'credit_usage',
              providerId: 'qoder',
              runtimeProvider: 'qoder_cli',
              creditUsage: {
                status: 'partial',
                quality: 'exact',
                source: ['qoder_sdk'],
                value: { provider: 'qoder', unit: 'credits', scope: 'main', amount: 2.5, knownRequests: 1, missingRequests: 0 },
                omissionReason: 'Only observed main-session requests are covered.'
              }
            })
          ]
        }]}
        selected={null}
        onSelect={() => {}}
        usage={null}
        stats={null}
        runtimeProvider="qoder_cli"
      />
    )

    expect(html).toContain('<span>Credit</span><strong>≥2.5</strong>')
    expect(html).not.toContain('<span>成本</span><strong>$9.00</strong>')
  })

  it('通过上游模型识别 Rotom 的 Qoder 会话并隐藏美元成本', () => {
    const html = renderToStaticMarkup(
      <OverviewPanel
        turns={[{
          runId: 'rotom-qoder',
          userText: 'one',
          done: true,
          items: [ev({
            id: 'rotom-qoder-result',
            kind: 'harness',
            stage: 'result',
            runtimeProvider: 'pi_rpc',
            contextProvider: 'qoder',
            upstreamProvider: 'qoder',
            contextModel: 'ultimate',
            tokensIn: 100,
            tokensOut: 20,
            costUsd: 9,
            modelUsage: [{ model: 'ultimate', upstreamProvider: 'qoder' }]
          })]
        }]}
        selected={null}
        onSelect={() => {}}
        usage={null}
        stats={null}
        runtimeProvider="pi_rpc"
      />
    )

    expect(html).toContain('<span>Credit</span><strong>—</strong>')
    expect(html).not.toContain('<span>成本</span>')
    expect(html).not.toContain('$9.00')
  })
})