import { completedModelText } from '../completed-turn-flow'
import { TURN_FLOW_COPY } from '../constants/copy'
import Markdown from './MarkdownImpl'

export function CompletedModelText({
  text,
  completed,
  expanded,
  onExpand
}: {
  text: string
  completed: boolean
  expanded: boolean
  onExpand: () => void
}) {
  const modelText = completedModelText(text, { completed, expanded })
  return (
    <div className="model-text md">
      <Markdown>{modelText.text}</Markdown>
      {modelText.hiddenCharacters > 0 && (
        <button
          type="button"
          className="turn-flow-reveal"
          onClick={onExpand}
          aria-label={TURN_FLOW_COPY.showFullResponseLabel(modelText.hiddenCharacters)}
        >
          {TURN_FLOW_COPY.showFullResponse(modelText.hiddenCharacters)}
        </button>
      )}
    </div>
  )
}
