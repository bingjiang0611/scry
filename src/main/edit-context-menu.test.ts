import { describe, expect, it } from 'vitest'
import {
  editContextMenuTemplate,
  imageContextMenuTemplate,
  shouldShowEditContextMenu,
  shouldShowImageContextMenu
} from './edit-context-menu'

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

describe('image context menu', () => {
  it('只在点击处有图片内容时显示', () => {
    expect(shouldShowImageContextMenu({ hasImageContents: true })).toBe(true)
    expect(shouldShowImageContextMenu({ hasImageContents: false })).toBe(false)
  })

  it('提供复制图片操作并调用原生复制回调', () => {
    let copied = false
    const items = imageContextMenuTemplate(() => { copied = true })

    expect(items).toHaveLength(1)
    expect(items[0]?.label).toBe('复制图片')
    items[0]?.click?.({} as never, {} as never, {} as never)
    expect(copied).toBe(true)
  })
})

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
