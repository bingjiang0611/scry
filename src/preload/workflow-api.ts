import { ipcRenderer } from 'electron'
import type { WorkflowApi } from '../shared/workflow-api'
import type { WorkflowTemplateApi } from '../shared/workflow-template'

export const workflowApi = {
    sizeGuideline: (): ReturnType<WorkflowApi['sizeGuideline']> => ipcRenderer.invoke('workflow:sizeGuideline'),
    setSizeGuideline: (value: Parameters<WorkflowApi['setSizeGuideline']>[0]): ReturnType<WorkflowApi['setSizeGuideline']> => ipcRenderer.invoke('workflow:setSizeGuideline', value),
    extractTemplate: (request: Parameters<WorkflowApi['extractTemplate']>[0]): ReturnType<WorkflowApi['extractTemplate']> => ipcRenderer.invoke('workflow:extractTemplate', request),
    instantiateTemplate: (request: Parameters<WorkflowApi['instantiateTemplate']>[0]): ReturnType<WorkflowApi['instantiateTemplate']> => ipcRenderer.invoke('workflow:instantiateTemplate', request),
    prepareTemplateTask: (request: Parameters<WorkflowApi['prepareTemplateTask']>[0]): ReturnType<WorkflowApi['prepareTemplateTask']> => ipcRenderer.invoke('workflow:prepareTemplateTask', request),
    templates: {
      drafts: (...args: Parameters<WorkflowTemplateApi['drafts']>): ReturnType<WorkflowTemplateApi['drafts']> => ipcRenderer.invoke('workflow:templates:drafts', ...args),
    catalog: (...args: Parameters<WorkflowTemplateApi['catalog']>): ReturnType<WorkflowTemplateApi['catalog']> => ipcRenderer.invoke('workflow:templates:catalog', ...args),
    history: (...args: Parameters<WorkflowTemplateApi['history']>): ReturnType<WorkflowTemplateApi['history']> => ipcRenderer.invoke('workflow:templates:history', ...args),
    revision: (ref: Parameters<WorkflowTemplateApi['revision']>[0]): ReturnType<WorkflowTemplateApi['revision']> => ipcRenderer.invoke('workflow:templates:revision', ref),
    restoreDraft: (request: Parameters<WorkflowTemplateApi['restoreDraft']>[0]): ReturnType<WorkflowTemplateApi['restoreDraft']> => ipcRenderer.invoke('workflow:templates:restoreDraft', request),
    delete: (request: Parameters<WorkflowTemplateApi['delete']>[0]): ReturnType<WorkflowTemplateApi['delete']> => ipcRenderer.invoke('workflow:templates:delete', request),
    read: (...args: Parameters<WorkflowTemplateApi['read']>): ReturnType<WorkflowTemplateApi['read']> => ipcRenderer.invoke('workflow:templates:read', ...args),
    list: (...args: Parameters<WorkflowTemplateApi['list']>): ReturnType<WorkflowTemplateApi['list']> => ipcRenderer.invoke('workflow:templates:list', ...args),
    saveDraft: (request: Parameters<WorkflowTemplateApi['saveDraft']>[0]): ReturnType<WorkflowTemplateApi['saveDraft']> => ipcRenderer.invoke('workflow:templates:saveDraft', request),
    draft: (id: string): ReturnType<WorkflowTemplateApi['draft']> => ipcRenderer.invoke('workflow:templates:draft', id),
    publish: (request: Parameters<WorkflowTemplateApi['publish']>[0]): ReturnType<WorkflowTemplateApi['publish']> => ipcRenderer.invoke('workflow:templates:publish', request)
  },
  plan: (request: Parameters<WorkflowApi['plan']>[0]): ReturnType<WorkflowApi['plan']> => ipcRenderer.invoke('workflow:plan', request),
  capturedTasks: (...args: Parameters<WorkflowApi['capturedTasks']>): ReturnType<WorkflowApi['capturedTasks']> => ipcRenderer.invoke('workflow:capturedTasks', ...args),
  inspectTask: (reference: Parameters<WorkflowApi['inspectTask']>[0]): ReturnType<WorkflowApi['inspectTask']> => ipcRenderer.invoke('workflow:inspectTask', reference),
  requestTemplateEditCandidate: (request: Parameters<WorkflowApi['requestTemplateEditCandidate']>[0]): ReturnType<WorkflowApi['requestTemplateEditCandidate']> => ipcRenderer.invoke('workflow:requestTemplateEditCandidate', request),
  applyTemplateEditCandidate: (request: Parameters<WorkflowApi['applyTemplateEditCandidate']>[0]): ReturnType<WorkflowApi['applyTemplateEditCandidate']> => ipcRenderer.invoke('workflow:applyTemplateEditCandidate', request),
  preview: (workflowId: string): ReturnType<WorkflowApi['preview']> => ipcRenderer.invoke('workflow:preview', workflowId),
  approve: (approval: Parameters<WorkflowApi['approve']>[0]): ReturnType<WorkflowApi['approve']> => ipcRenderer.invoke('workflow:approve', approval),
  start: (workflowId: string, approval: Parameters<WorkflowApi['start']>[1], commandId?: string): ReturnType<WorkflowApi['start']> => ipcRenderer.invoke('workflow:start', workflowId, { ...approval, ...(commandId ? { commandId } : {}) }),
  resume: (workflowId: string, approval: Parameters<WorkflowApi['resume']>[1], commandId: string): ReturnType<WorkflowApi['resume']> => ipcRenderer.invoke('workflow:resume', workflowId, { ...approval, commandId }),
  retry: (workflowId: string, approval: Parameters<WorkflowApi['retry']>[1], target: Parameters<WorkflowApi['retry']>[2], commandId: string): ReturnType<WorkflowApi['retry']> => ipcRenderer.invoke('workflow:retry', workflowId, { ...approval, target, commandId }),
  restartStalled: (workflowId: string, approval: Parameters<WorkflowApi['restartStalled']>[1], target: Parameters<WorkflowApi['restartStalled']>[2], commandId: string): ReturnType<WorkflowApi['restartStalled']> => ipcRenderer.invoke('workflow:restartStalled', workflowId, { ...approval, target, commandId }),
  prepareRevision: (draft: Parameters<WorkflowApi['prepareRevision']>[0]): ReturnType<WorkflowApi['prepareRevision']> => ipcRenderer.invoke('workflow:prepareRevision', draft),
  revise: (workflowId: string, approval: Parameters<WorkflowApi['revise']>[1], target: Parameters<WorkflowApi['revise']>[2], commandId: string): ReturnType<WorkflowApi['revise']> => ipcRenderer.invoke('workflow:revise', workflowId, { ...approval, target, commandId }),
  stop: (workflowId: string, commandId: string): ReturnType<WorkflowApi['stop']> => ipcRenderer.invoke('workflow:stop', workflowId, commandId),
  stopNode: (workflowId: string, target: Parameters<WorkflowApi['stopNode']>[1], commandId: string): ReturnType<WorkflowApi['stopNode']> => ipcRenderer.invoke('workflow:stopNode', workflowId, target, commandId),
  cancelPlanning: (commandId: string, submission?: Parameters<WorkflowApi['cancelPlanning']>[1]): ReturnType<WorkflowApi['cancelPlanning']> => ipcRenderer.invoke('workflow:cancelPlanning', commandId, submission),
  list: (cwd: string, cursor?: string): ReturnType<WorkflowApi['list']> => ipcRenderer.invoke('workflow:list', cwd, cursor),
  snapshot: (workflowId: string): ReturnType<WorkflowApi['snapshot']> => ipcRenderer.invoke('workflow:snapshot', workflowId),
  inspectFrame: (workflowId: string, frameId: string): ReturnType<WorkflowApi['inspectFrame']> => ipcRenderer.invoke('workflow:inspectFrame', workflowId, frameId),
  inspectExecution: (request: Parameters<WorkflowApi['inspectExecution']>[0]): ReturnType<WorkflowApi['inspectExecution']> => ipcRenderer.invoke('workflow:inspectExecution', request),
  inspectOutput: (request: Parameters<WorkflowApi['inspectOutput']>[0]): ReturnType<WorkflowApi['inspectOutput']> => ipcRenderer.invoke('workflow:inspectOutput', request),
  onProgress: (cb: Parameters<WorkflowApi['onProgress']>[0]): ReturnType<WorkflowApi['onProgress']> => {
    const listener = (_event: Electron.IpcRendererEvent, progress: Parameters<WorkflowApi['onProgress']>[0] extends (value: infer T) => void ? T : never): void => cb(progress)
    ipcRenderer.on('workflow:progress', listener)
    return () => ipcRenderer.removeListener('workflow:progress', listener)
  }
} satisfies WorkflowApi
