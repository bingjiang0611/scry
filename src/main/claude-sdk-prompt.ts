// SDK prompt 组装：纯文本时直接给字符串，否则给一个可中断的流（附件走 base64 image block）。

import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type { AgentInputAttachment } from '../shared/runtime'

export function sdkPrompt(prompt: string, attachments: AgentInputAttachment[], beforeInput?: () => Promise<boolean>): string | AsyncIterable<SDKUserMessage> {
  if (attachments.length === 0 && !beforeInput) return prompt
  async function* stream(): AsyncIterable<SDKUserMessage> {
    if (beforeInput && !await beforeInput()) return
    const content: Array<Record<string, unknown>> = []
    if (prompt.trim()) content.push({ type: 'text', text: prompt })
    for (const attachment of attachments) {
      content.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: attachment.mimeType,
          data: attachment.dataBase64
        }
      })
    }
    yield ({
      type: 'user',
      message: {
        role: 'user',
        content
      },
      parent_tool_use_id: null
    } as unknown as SDKUserMessage)
  }
  return stream()
}

