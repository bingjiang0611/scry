import { describe, expect, it } from 'vitest'
import type { HostMetricsSnapshot } from '@shared/host-metrics'
import {
  dispatchDiskRole, formatBytes, formatSampleAge, formatUptime, memoryPressureText,
  meterViews, providerUsageRows, providerUsageTotals, runsText, scryUsageTotals, hostSummary, targetNotice
} from './machines-view-model'

const GB = 1024 ** 3
const snapshot: HostMetricsSnapshot = {
  sampledAt: 1_700_000_000_000,
  uptimeSec: 3 * 86400 + 3600,
  cpu: { percent: 34, cores: 10, load1: 4.1 },
  memory: { totalBytes: 16 * GB, usedBytes: 9.1 * GB, pressure: 'medium', swapUsedBytes: 2 * GB, swapTotalBytes: 4 * GB },
  disks: [{ role: 'data', totalBytes: 1000 * GB, freeBytes: 212 * GB }],
  scry: {
    daemon: { cpuPercent: 0.8, rssBytes: 210 * 1024 ** 2, pid: 900 },
    providers: [
      { providerId: 'pi', processes: 2, cpuPercent: 10, rssBytes: GB },
      { providerId: 'other', processes: 1, cpuPercent: 4, rssBytes: 0.5 * GB }
    ]
  },
  runs: { active: 2, queued: 1 }
}

describe('machine metrics text', () => {
  it('writes bytes the way the mockups do, and 「不可用」 for what could not be read', () => {
    expect(formatBytes(210 * 1024 ** 2)).toBe('210 MB')
    expect(formatBytes(1.5 * GB)).toBe('1.5 GB')
    expect(formatBytes(16 * GB)).toBe('16 GB')
    expect(formatBytes(936 * 1024)).toBe('936 KB')
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(null)).toBe('不可用')
  })

  it('says how long the machine has been up and how many runs are in flight', () => {
    expect(formatUptime(3 * 86400 + 3600)).toBe('开机 3 天')
    expect(formatUptime(5 * 3600)).toBe('开机 5 小时')
    expect(formatUptime(120)).toBe('开机 2 分钟')
    expect(formatUptime(null)).toBe('开机时长不可用')
    expect(runsText({ active: 2, queued: 1 })).toBe('运行中 2 · 排队 1')
    expect(runsText({ active: 0, queued: 0 })).toBe('没有运行')
  })

  it('names memory pressure in the same words the system reports', () => {
    expect(memoryPressureText('low')).toBe('低')
    expect(memoryPressureText('medium')).toBe('中')
    expect(memoryPressureText('high')).toBe('高')
    expect(memoryPressureText(null)).toBe('不可用')
  })

  it('writes roles as names on the machine that owns them', () => {
    expect(dispatchDiskRole('data')).toBe('数据盘')
    expect(dispatchDiskRole('workspace')).toBe('工作区')
  })

  it('says how old the sample is instead of showing a fake live number', () => {
    expect(formatSampleAge(1_700_000_000_000, 1_700_000_003_000)).toBe('3 秒前更新')
    expect(formatSampleAge(1_700_000_000_000, 1_700_000_300_000)).toBe('5 分钟前更新')
    expect(formatSampleAge(1_700_000_000_000, 1_700_007_200_000)).toBe('2 小时前更新')
    expect(formatSampleAge(null, 1_700_000_000_000)).toBe('')
  })

  it('summarizes the machine under the card title', () => {
    expect(hostSummary(snapshot)).toBe('10 核 · 开机 3 天 · 运行中 2')
  })
})

describe('resource bars', () => {
  it('draws four bars with the values the snapshot actually has', () => {
    const meters = meterViews(snapshot)
    expect(meters.map((meter) => meter.label)).toEqual(['CPU', '内存', '交换区', '磁盘'])
    expect(meters[0]).toMatchObject({ percent: 34, valueText: '34%', tone: 'normal' })
    expect(meters[1]).toMatchObject({ percent: 57, valueText: '已用 9.1 GB / 16 GB' })
    // 85% and above is the danger threshold, 70% warns.
    expect(meters[2]).toMatchObject({ percent: 50, valueText: '已用 2 GB / 4 GB', tone: 'normal' })
    expect(meters[3]).toMatchObject({ percent: 79, valueText: '剩余 212 GB', tone: 'warn' })
  })

  it('marks a value as unavailable instead of drawing an empty bar as zero', () => {
    const partial: HostMetricsSnapshot = {
      ...snapshot,
      cpu: { ...snapshot.cpu, percent: null },
      memory: { ...snapshot.memory, usedBytes: null },
      memoryPressure: undefined,
      disks: [{ role: 'data', totalBytes: 0, freeBytes: 0 }]
    } as HostMetricsSnapshot
    const meters = meterViews(partial)
    expect(meters[0]).toMatchObject({ percent: null, valueText: '不可用', tone: 'none' })
    expect(meters[1]).toMatchObject({ percent: null, valueText: '不可用' })
    expect(meters[3]).toMatchObject({ percent: null, valueText: '不可用' })
  })

  it('colors 70% and 85% by the shared thresholds', () => {
    const tone = (percent: number) => meterViews({
      ...snapshot, cpu: { ...snapshot.cpu, percent }
    })[0].tone
    expect(tone(69)).toBe('normal')
    expect(tone(70)).toBe('warn')
    expect(tone(84)).toBe('warn')
    expect(tone(85)).toBe('danger')
    expect(tone(100)).toBe('danger')
  })
})

describe('Scry usage', () => {
  it('reports the daemon and the provider tree separately and in total', () => {
    const rows = providerUsageRows(snapshot)
    expect(rows).toHaveLength(2)
    expect(rows![0]).toMatchObject({ providerId: 'pi', processes: 2 })
    // 合计含后台服务自己：Provider 1.5 GB + daemon 210 MB。
    expect(scryUsageTotals(snapshot)).toEqual({ processes: 3, cpuPercent: 14.8, rssBytes: 1.5 * GB + 210 * 1024 ** 2 })
    // 卡片上 Provider 与后台服务分两行写，Provider 行不能把 daemon 算进去。
    expect(providerUsageTotals(snapshot)).toEqual({ processes: 3, cpuPercent: 14, rssBytes: 1.5 * GB })
  })

  it('distinguishes "no provider processes" from "the process table was unreadable"', () => {
    expect(providerUsageRows({ ...snapshot, scry: { ...snapshot.scry, providers: [] } })).toEqual([])
    expect(providerUsageRows({ ...snapshot, scry: { ...snapshot.scry, providers: null } })).toBeNull()
    expect(scryUsageTotals({ ...snapshot, scry: { ...snapshot.scry, providers: null } }))
      .toEqual({ processes: null, cpuPercent: null, rssBytes: null })
  })
})

describe('target cards', () => {
  it('names the state of a card that cannot show resources', () => {
    expect(targetNotice({ kind: 'unsupported' })).toEqual({
      tone: 'info', title: '该主机版本不支持，请升级', detail: '升级后即可显示这台机器的资源；会话和运行不受影响。'
    })
    expect(targetNotice({ kind: 'offline' })?.title).toBe('离线')
    expect(targetNotice({ kind: 'failed', detail: '请求超时（2 秒）' })).toMatchObject({
      tone: 'bad', title: '读取资源失败：请求超时（2 秒）'
    })
    expect(targetNotice({ kind: 'ready' })).toBeNull()
  })
})
