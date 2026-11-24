import type { AgentInputAttachment } from '../../shared/runtime'
import type { AcpInitializeResult } from './acp-client'

export function buildPromptBlocks(
  prompt: string,
  attachments: readonly AgentInputAttachment[],
  init: AcpInitializeResult
): Array<Record<string, unknown>> {
  const blocks: Array<Record<string, unknown>> = []
  if (prompt) blocks.push({ type: 'text', text: prompt })
  const supportsImage = init.agentCapabilities?.promptCapabilities?.image !== false
  for (const att of attachments) {
    const kind = (att as { kind?: string }).kind
    if (kind === 'audio') {
      throw new Error('Antigravity ACP 不支持音频附件（promptCapabilities.audio=false）')
    }
    if (att.kind === 'image') {
      if (!supportsImage) throw new Error('Antigravity ACP 当前不支持图片附件')
      blocks.push({ type: 'image', data: att.dataBase64, mimeType: att.mimeType })
    } else if (att.path) {
      blocks.push({ type: 'text', text: `[Attachment path: ${att.path}]` })
    }
  }
  if (blocks.length === 0) blocks.push({ type: 'text', text: '' })
  return blocks
}
