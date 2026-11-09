import { Icon } from './primitives/Icon'

/**
 * 单选菜单最左侧的对勾列：未选中时也占位，名称才能在同一列开始。
 * 选中态由 aria-checked 表达，这里只是视觉标记。
 */
export function MenuCheck({ selected }: { selected: boolean }) {
  return <span className="menu-check" aria-hidden="true">{selected ? <Icon name="check" /> : null}</span>
}
