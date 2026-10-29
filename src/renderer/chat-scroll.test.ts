import { describe, expect, it } from 'vitest'
import { transcriptGrowthAboveEdge } from './chat-scroll'

describe('transcriptGrowthAboveEdge', () => {
  it('compensates a materialized turn whose top is above the edge', () => {
    // Session history: the row straddles the top edge, and everything below it must keep
    // its position while virtualized overscan materializes.
    expect(transcriptGrowthAboveEdge({ top: -155, height: 549, previousHeight: 240,
      firstMeasurement: true, restoreAnchor: false, edge: 0 })).toBe(309)
  })

  it('leaves a turn that starts below the edge alone', () => {
    expect(transcriptGrowthAboveEdge({ top: 394, height: 453, previousHeight: 240,
      firstMeasurement: true, restoreAnchor: false, edge: 0 })).toBe(0)
  })

  it('judges later growth by the previous box instead of the new one', () => {
    // Previous box ended above the edge: its growth happened above the reader.
    expect(transcriptGrowthAboveEdge({ top: -100, height: 300, previousHeight: 50,
      firstMeasurement: false, restoreAnchor: false, edge: 0 })).toBe(250)
    // Previous box straddled the edge: the growth is below it.
    expect(transcriptGrowthAboveEdge({ top: -40, height: 300, previousHeight: 100,
      firstMeasurement: false, restoreAnchor: false, edge: 0 })).toBe(0)
  })

  it('leaves the turn an exact view restore anchored to its remembered offset', () => {
    // A side chat reopen: the reader sits inside this turn, 80 px above the edge.
    expect(transcriptGrowthAboveEdge({ top: -80, height: 1515, previousHeight: 240,
      firstMeasurement: true, restoreAnchor: true, edge: 0 })).toBe(0)
  })
})
