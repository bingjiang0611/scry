// C4 重启提示的全部用户可见文案。这里的每一条都在说「宿主重启时丢掉了什么」，
// 不承诺已经补做：结果未知这件事必须写在用户看得见的地方。
export const RESTART_NOTE_COPY = {
  title: '上次的后台任务没有结果',
  hint: 'Scry 重启时它们被取消；继续会带着这条提示再发一轮，只发一次',
  label: '重启取消的后台任务',
  continue: '继续',
  continuing: '正在继续',
  refused: (reason: string) => `没能继续：${reason}`,
  noPendingNote: '这条重启提示已经用过了，不会再发一次'
} as const
