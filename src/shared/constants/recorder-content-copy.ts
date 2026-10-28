export const recorderContentCopy = {
  invalidSource: 'invalid_content_source',
  workspaceChanged: 'recorder_workspace_changed',
  workspaceUnavailable: 'recorder_workspace_unavailable',
  unavailable: (reason: string) => `recorder_unavailable:${reason}`
} as const
