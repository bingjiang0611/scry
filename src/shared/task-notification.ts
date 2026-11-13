/** One Provider-written notification block; anything outside the blocks is what a person wrote. */
const BLOCK = /<task-notification>[\s\S]*?<\/task-notification>/g

/**
 * True when a message *is* the Provider's background-task notification. A message that starts with a
 * notification but carries text around it is a person's own message — quoting a notification and then
 * asking a question is still asking — so it stays a user prompt and its text stays user text.
 */
export function isTaskNotificationMessage(text: string | undefined): boolean {
  const trimmed = text?.trim()
  if (!trimmed || !trimmed.startsWith('<task-notification>')) return false
  return trimmed.replace(BLOCK, '').trim() === ''
}
