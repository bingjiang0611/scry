import { forwardRef, type ComponentPropsWithoutRef } from 'react'

type IconButtonProps = Omit<ComponentPropsWithoutRef<'button'>, 'aria-label'> & {
  /** Required accessible name; also shown as the native tooltip unless `title` overrides it. */
  label: string
  size?: 'sm' | 'md'
  /** Visually marks a toggled or menu-open state. Callers still own aria-pressed / aria-expanded. */
  active?: boolean
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(
  function IconButton({ label, size = 'md', active = false, className, title, type = 'button', ...props }, ref) {
    const classes = ['icon-button', size === 'sm' ? 'sm' : '', active ? 'on' : '', className ?? ''].filter(Boolean).join(' ')
    return <button {...props} ref={ref} type={type} aria-label={label} title={title ?? label} className={classes} />
  }
)
