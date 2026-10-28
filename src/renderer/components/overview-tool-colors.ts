// TOP TOOLS 行的颜色语义：读、编辑、MCP 各一档，其余保持默认。
export function topToolColor(name: string): '' | 'read' | 'edit' | 'mcp' {
  if (name.startsWith('mcp:')) return 'mcp'
  if (name === 'Read') return 'read'
  if (name === 'Write' || name === 'Edit' || name === 'MultiEdit' || name === 'NotebookEdit') return 'edit'
  return ''
}
