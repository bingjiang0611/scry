// Fixture RPC script, second half.
export const piFixtureSourceTail = `
              scenario === 'resume' ? 'Previous completion review is unresolved. It will not be replayed, including after resume. Completion remains unverified.' :
              'Completion review unresolved: Review tool-call limit reached. No automatic retry; completion remains unverified.' }],
            terminate: scenario !== 'no-terminate'
          }
        })
        if (scenario === 'later-stop' || scenario === 'later-error' || scenario === 'later-toolUse') {
          send({ type: 'message_start', message: { role: 'assistant' } })
          send({ type: 'message_end', message: {
            role: 'assistant', stopReason: scenario.slice('later-'.length), content: [],
            ...(scenario === 'later-error' ? { errorMessage: 'Qoder: request_failed' } : {})
          } })
        }
        send({ type: 'agent_end' })
        send({ type: 'agent_settled' })
        continue
      }
      if (command.message === 'mixed-billing' || command.message === 'mixed-billing-crash') {
        for (const [provider, model, stopReason, input, output, cost] of [
          ['cc-switch', 'claude-opus-5', 'error', 10, 2, 0],
          ['qoder', 'ultimate', 'toolUse', 20, 3, 0],
          ['custom-vendor', 'private-model', 'stop', 30, 4, 0.25]
        ]) send({ type: 'message_end', message: { role: 'assistant', provider, model, stopReason,
          content: [], usage: { input, output, cacheRead: 0, cacheWrite: 0, cost: { total: cost } } } })
        if (command.message === 'mixed-billing-crash') {
          process.stdout.write('', () => process.exit(17))
          continue
        }
        send({ type: 'agent_end' })
        send({ type: 'agent_settled' })
        continue
      }
      if (command.message === 'qoder-billing') {
        send({ type: 'message_end', message: {
          role: 'assistant', provider: 'qoder', model: 'ultimate', stopReason: 'stop',
          content: [{ type: 'text', text: '3973' }],
          usage: { input: 10937, output: 27, reasoning: 19, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } }
        } })
        send({ type: 'agent_end' })
        send({ type: 'agent_settled' })
        continue
      }
      if (command.message === 'call-timing') {
        // Pi stamps message.timestamp at request creation. Errored/aborted retries carry tokens too.
        for (const [stopReason, output, ageMs] of [['toolUse', 120, 3000], ['error', 50, 2000], ['aborted', 30, 1000], ['stop', 0, 1000], ['stop', 80, 2000]]) {
          send({ type: 'message_start', message: { role: 'assistant' } })
          // Only the first call streams a content block; the last one has no first-token signal.
          if (stopReason === 'toolUse') send({ type: 'message_update', assistantMessageEvent: { type: 'toolcall_start', contentIndex: 0 } })
          send({ type: 'message_end', message: {
            role: 'assistant', provider: 'qoder', model: 'ultimate', stopReason, content: [], timestamp: Date.now() - ageMs,
            usage: { input: 10, output, cost: { total: 0 } }
          } })
        }
        send({ type: 'agent_end' })
        send({ type: 'agent_settled' })
        continue
      }
      if (command.message.startsWith('cached-context:')) {
        const [, provider, turn] = command.message.split(':')
        const samples = turn === 'first'
          ? [{ input: 9100, cacheRead: 0, cacheWrite: 0 }]
          : [
            { input: 942, cacheRead: 100000, cacheWrite: 256 },
            { input: 9100, cacheRead: 100000, cacheWrite: 0 },
            { input: 0, cacheRead: 110000, cacheWrite: 0 },
            { input: 0, cacheRead: 0, cacheWrite: 0 }
          ]
        for (const usage of samples) {
          send({ type: 'message_start', message: { role: 'assistant' } })
          send({ type: 'message_end', message: {
            role: 'assistant', provider, model: 'test-model', stopReason: 'stop', content: [],
            usage: { ...usage, output: 4 }
          } })
        }
        send({ type: 'agent_end' })
        send({ type: 'agent_settled' })
        continue
      }
      if (command.message.startsWith('context-telemetry:')) {
        const scenario = command.message.slice('context-telemetry:'.length)
        const sample = (input) => {
          send({ type: 'message_start', message: { role: 'assistant' } })
          send({ type: 'message_end', message: {
            role: 'assistant', provider: 'openai-codex', model: 'test-model', stopReason: 'stop',
            content: [], usage: { input, output: input ? 4 : 0, cacheRead: input ? 2 : 0, cacheWrite: input ? 1 : 0 }
          } })
        }
        sample(50000)
        send({ type: 'compaction_start', reason: 'threshold' })
        send({ type: 'compaction_end', reason: 'threshold', aborted: scenario === 'aborted',
          ...(scenario === 'missing' ? {} : { result: { tokensBefore: 50000, summary: 'summary' } }),
          ...(scenario === 'error' ? { errorMessage: 'failed' } : {}), willRetry: false })
        if (scenario === 'success') sample(8000)
        // Native transport failures can end with an all-zero usage object; not a new context sample.
        sample(0)
        send({ type: 'agent_settled' })
        continue
      }
      if (command.message === 'steer-active' || command.message === 'steer-timeout' || command.message === 'steer-end-race') {
        send({ type: 'message_start', message: { role: 'assistant' } })
        continue
      }
      if (command.message === 'hang') continue
      if (command.message === 'stop-before-final-state') {
        send({ type: 'message_start', message: { role: 'assistant' } })
        send({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'started' } })
        continue
      }
      if (command.message === 'long-active') {
        let ticks = 0
        const timer = setInterval(() => {
          ticks += 1
          send({ type: 'status_update', status: 'working', ticks })
          if (ticks === 5) {
            clearInterval(timer)
            send({ type: 'agent_settled' })
          }
        }, 20)
        continue
      }
      if (command.message === 'oversized-unframed') {
        process.stdout.write('{"type":"unknown_large","payload":"' + 'x'.repeat(2 * 1024 * 1024))
        continue
      }
      if (command.message === 'large-event') send({ type: 'unknown_large', payload: 'x'.repeat(17 * 1024 * 1024) })
      if (command.message === 'pending-question') {
        send({ type: 'extension_ui_request', id: 'question-late', method: 'select', title: 'Pick one', options: ['One'] })
      }
      send({ type: 'message_start', message: { role: 'assistant' } })
      send({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: 'think' } })
      send({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: 'ing' } })
      send({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'hello' + String.fromCodePoint(0x2028) + 'world' } })
      send({ type: 'tool_execution_start', toolCallId: 'tool-read', toolName: 'read', args: { path: 'README.md' } })
      send({ type: 'tool_execution_end', toolCallId: 'tool-read', toolName: 'read', result: command.message === 'large-tool' ? '原文😀'.repeat(60_000) + 'PI-TOOL-END' : 'contents', isError: false })
      send({ type: 'tool_execution_start', toolCallId: 'tool-1', toolName: 'subagent', args: { task: 'inspect' } })
      send({ type: 'tool_execution_end', toolCallId: 'tool-1', toolName: 'subagent', result: { content: [{ type: 'text', text: 'done' }] }, isError: false })
      const providerAborted = command.message === 'provider-aborted'
      send({ type: 'message_end', message: {
        role: 'assistant', provider: 'openai-codex', model: 'test-model',
        stopReason: providerAborted ? 'aborted' : 'stop',
        ...(providerAborted ? { errorMessage: 'Qoder: aborted' } : {}),
        content: providerAborted ? [] : [{ type: 'text', text: 'hello world' }],
        usage: { input: 10, output: 4, cacheRead: 2, cacheWrite: 1, cost: { total: 0.01 } }
      } })
      if (command.message === 'large-snapshots') {
        const message = { role: 'toolResult', content: [{ type: 'text', text: 'x'.repeat(2 * 1024 * 1024) }] }
        entries.push({ type: 'message', id: 'large-result', parentId: leafId, message })
        leafId = 'large-result'
        send({ type: 'turn_end', toolResults: [message] })
        send({ type: 'agent_end', willRetry: false, messages: [message] })
      } else send({ type: 'agent_end', willRetry: false })
      setTimeout(() => send({ type: 'agent_settled' }), command.message === 'steer-active' ? 500 : 20)
    } else if (command.type === 'steer') {
      require('node:fs').appendFileSync(process.cwd() + '/fixture-steers', JSON.stringify(command) + '\\n')
      if (command.message === 'steer-reject') {
        send({ type: 'response', id: command.id, command: command.type, success: false, error: 'native steer rejected' })
        if (promptMessage === 'steer-active') setTimeout(() => send({ type: 'agent_settled' }), 10)
      } else if (command.message === 'steer-process-exit') {
        process.exit(17)
      } else if (command.message === 'steer-timeout') {
        continue
      } else if (command.message === 'steer-end-restart') {
        send({ type: 'agent_end' })
        send({ type: 'agent_start' })
        send({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'cycle restarted' } })
        response()
        continue
      } else {
        const entry = {
          type: 'message', id: 'pi-user-' + (++entrySeq), parentId: leafId,
          message: { role: 'user', content: [{ type: 'text', text: command.message }] }
        }
        entries.push(entry)
        persistEntries()
        leafId = entry.id
        if (command.message === 'steer-end-race') send({ type: 'agent_end' })
        response()
        if (promptMessage === 'steer-active' || promptMessage === 'steer-end-race') {
          setTimeout(() => send({ type: 'agent_settled' }), 10)
        }
      }
    } else if (command.type === 'extension_ui_response' && command.id.startsWith('batch-')) {
      require('node:fs').appendFileSync(process.cwd() + '/batch-responses', JSON.stringify(command) + '\\n')
      if (!command.cancelled && command.id === 'batch-first') {
        send({ type: 'extension_ui_request', id: 'batch-second', method: 'select', title: promptMessage.endsWith('-changed') ? 'Unrelated secret' : '[Review] When to review?', options: ['1. Now — Before continuing', '2. Later — At the end', '3. Type something.'] })
      } else if (!command.cancelled && command.id === 'batch-second' && command.value === '3. Type something.') {
        send({ type: 'extension_ui_request', id: 'batch-custom', method: 'input', title: '[Review] When to review?\\n\\nType your answer:', placeholder: '' })
      } else {
        send({ type: 'tool_execution_end', toolCallId: 'batch-tool', toolName: 'ask_user_question', result: { content: [{ type: 'text', text: command.cancelled ? 'Declined' : 'Answered' }] }, isError: false })
        send({ type: 'agent_end' })
        send({ type: 'agent_settled' })
        acknowledgePrompt()
      }
    } else if (command.type === 'extension_ui_response' && command.id.startsWith('question-')) {
      require('node:fs').appendFileSync(process.cwd() + '/question-responses', JSON.stringify(command) + '\\n')
      if (command.cancelled) acknowledgePrompt()
      else if (command.id === 'question-select' && command.value === '2. Type something.') {
        const title = promptMessage.endsWith('question-unrelated') ? 'Unrelated secret'
          : promptMessage.endsWith('question-unrelated-context') ? '[另一问题] Unrelated secret\\n\\nType your answer:'
          : promptMessage.endsWith('question-legacy') ? 'Type your answer:'
          : '[复现动作] Continue?\\n\\nType your answer:'
        send({ type: 'extension_ui_request', id: 'question-input', method: 'input', title, placeholder: '' })
      } else if (command.id === 'question-select' && command.value !== '1. Continue') {
        send({ type: 'extension_error', extensionPath: 'command:fixture-menu', event: 'command', error: 'User declined to answer questions' })
        acknowledgePrompt()
      } else acknowledgePrompt()
    } else if (command.type === 'extension_ui_response' && command.id.startsWith('menu-')) {
      if (command.cancelled) acknowledgePrompt()
      else if (command.id === 'menu-select') {
        send({ type: 'extension_ui_request', id: 'menu-editor', method: 'editor', title: 'Objective', prefill: 'Existing objective' })
      } else if (command.id === 'menu-editor') {
        send({ type: 'extension_ui_request', id: 'menu-confirm', method: 'confirm', title: 'Save?', message: command.value })
      } else {
        send({ type: 'extension_ui_request', id: 'menu-notify', method: 'notify', message: 'Saved', notifyType: 'info' })
        acknowledgePrompt()
      }
    } else if (command.type === 'extension_ui_response' && command.id === 'delayed-release') {
      if (promptMessage === 'late-entry') {
        const entry = { type: 'message', id: 'pi-user-' + (++entrySeq), parentId: leafId, message: { role: 'user' } }
        entries.push(entry)
        persistEntries()
        leafId = entry.id
      } else acknowledgePrompt()
      send({ type: 'agent_settled' })
    } else if (command.type === 'abort' && promptMessage === 'stop-before-final-state') {
      send({ type: 'agent_settled' })
    } else response()
  }
})
`
