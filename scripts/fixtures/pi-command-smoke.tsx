import { useState } from 'react'
import { AssistantTurn } from '../../src/renderer/components/ChatTurn'
import type { AgentQuestionRequest, AgentQuestionResponse } from '../../src/shared/runtime'
import type { TraceEvent } from '../../src/shared/trace'

const questions: AgentQuestionRequest[] = [
  { runId: 'pi-command-ui', questionId: 'select', providerId: 'pi', source: 'pi_extension_ui:select', questions: [
    { header: 'Menu', question: 'Choose an action', options: [{ label: 'Edit', description: 'Edit objective' }], multiSelect: false, allowCustomAnswer: true }
  ] },
  { runId: 'pi-command-ui', questionId: 'editor', providerId: 'pi', questions: [
    { header: 'Objective', question: 'Edit objective', options: [], multiSelect: false, inputMode: 'multiline', initialValue: 'Existing objective' }
  ] },
  { runId: 'pi-command-ui', questionId: 'confirm', providerId: 'pi', questions: [
    { header: 'Save', question: 'Save changes?', options: [{ label: '确认', description: '确认这次操作' }, { label: '取消', description: '取消这次操作' }], multiSelect: false, allowCustomAnswer: false }
  ] }
]

export function PiCommandFixture() {
  const [step, setStep] = useState(0)
  const [answers, setAnswers] = useState<AgentQuestionResponse[]>([])
  const done = step === questions.length
  const feedback: TraceEvent = {
    id: 'command-result', runId: 'pi-command-ui', ts: '', kind: 'harness', stage: 'result',
    providerId: 'pi', runtimeProvider: 'pi_rpc', text: 'Command interaction ended; model turn unobserved',
    providerCommand: { name: 'fixture-menu', source: 'extension', modelTurn: 'unobserved' }
  }
  return <section id="pi-command">
    <button id="pi-command-restart" onClick={() => { setStep(0); setAnswers([]) }}>Restart menu</button>
    <AssistantTurn
      turn={{ runId: 'pi-command-ui', userText: '/fixture-menu', done, items: done ? [
        { ...feedback, id: 'notify', stage: 'runtime:extension_ui', providerCommand: undefined, runtimeMetadata: { method: 'notify' }, text: 'Pi extension notification' },
        { ...feedback, id: 'custom', stage: 'runtime:extension_message', providerCommand: undefined, text: 'Custom command status' },
        feedback
      ] : [] }}
      selectedId={null}
      onSelect={() => {}}
      pendingQuestions={done ? [] : [questions[step]]}
      onAnswerQuestion={async (response) => {
        setAnswers((previous) => [...previous, response])
        setStep((previous) => response.behavior === 'cancelled' ? questions.length
          : previous === 0 && response.nativeCustomAnswer ? 2 : previous + 1)
      }}
    />
    <output id="pi-command-answers">{JSON.stringify(answers)}</output>
  </section>
}
