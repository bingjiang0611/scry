export function topToolColor(name: string): '' | 'read' | 'edit' | 'mcp' {
  if (name.startsWith('mcp:')) return 'mcp'
  if (name === 'Read') return 'read'
  if (name === 'Write' || name === 'Edit' || name === 'MultiEdit' || name === 'NotebookEdit') return 'edit'
  return ''
}
