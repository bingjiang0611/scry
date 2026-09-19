import type { ContextMenuParams, MenuItemConstructorOptions } from 'electron'

type EditMenuParams = Pick<ContextMenuParams, 'isEditable' | 'formControlType' | 'editFlags'>
type ImageMenuParams = Pick<ContextMenuParams, 'hasImageContents'>

export function shouldShowImageContextMenu(params: ImageMenuParams): boolean {
  return params.hasImageContents
}

export function imageContextMenuTemplate(onCopyImage: () => void): MenuItemConstructorOptions[] {
  return [{ label: '复制图片', click: onCopyImage }]
}

export function shouldShowEditContextMenu(params: EditMenuParams): boolean {
  return params.isEditable && params.formControlType !== 'input-password'
}

export function editContextMenuTemplate(params: EditMenuParams): MenuItemConstructorOptions[] {
  return [
    { label: '撤销', role: 'undo', enabled: params.editFlags.canUndo },
    { label: '重做', role: 'redo', enabled: params.editFlags.canRedo },
    { type: 'separator' },
    { label: '剪切', role: 'cut', enabled: params.editFlags.canCut },
    { label: '复制', role: 'copy', enabled: params.editFlags.canCopy },
    { label: '粘贴', role: 'paste', enabled: params.editFlags.canPaste },
    { type: 'separator' },
    { label: '全选', role: 'selectAll', enabled: params.editFlags.canSelectAll }
  ]
}
