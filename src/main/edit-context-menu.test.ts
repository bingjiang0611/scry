import { describe, expect, it } from 'vitest'
import { editContextMenuTemplate, shouldShowEditContextMenu } from './edit-context-menu'

const editFlags = {
  canUndo: true,
  canRedo: false,
  canCut: true,
  canCopy: true,
  canPaste: false,
  canDelete: false,
  canSelectAll: true,
  canEditRichly: false
}

describe('editable context menu', () => {
  it('只在非密码 editable 控件中显示', () => {
    expect(shouldShowEditContextMenu({ isEditable: true, formControlType: 'text-area', editFlags })).toBe(true)
    expect(shouldShowEditContextMenu({ isEditable: true, formControlType: 'input-password', editFlags })).toBe(false)
    expect(shouldShowEditContextMenu({ isEditable: false, formControlType: 'none', editFlags })).toBe(false)
  })

  it('使用系统编辑 role，并如实反映 Chromium editFlags', () => {
    const items = editContextMenuTemplate({ isEditable: true, formControlType: 'input-text', editFlags })
    expect(items.map((item) => item.role ?? item.type)).toEqual([
      'undo',
      'redo',
      'separator',
      'cut',
      'copy',
      'paste',
      'separator',
      'selectAll'
    ])
    expect(items.find((item) => item.role === 'redo')?.enabled).toBe(false)
    expect(items.find((item) => item.role === 'paste')?.enabled).toBe(false)
  })
})
