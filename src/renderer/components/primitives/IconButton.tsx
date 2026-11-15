import { forwardRef, type ComponentPropsWithoutRef } from 'react'

type IconButtonProps = Omit<ComponentPropsWithoutRef<'button'>, 'aria-label'> & {
  /** Required accessible name; also shown as the native tooltip unless `title` overrides it. */
  label: string
  /** md (32px) for panel headers; sm (28px) inside dense rows and editor bars. */
  size?: 'sm' | 'md'
  /** Visually marks a toggled or menu-open state. Callers still own aria-pressed / aria-expanded. */
  active?: boolean
}

/** The single icon-only button of the renderer: quiet by default, never unnamed. */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(
  function IconButton({ label, size = 'md', active = false, className, title, type = 'button', ...props }, ref) {
    const classes = ['icon-button', size === 'sm' ? 'sm' : '', active ? 'on' : '', className ?? ''].filter(Boolean).join(' ')
    return <button {...props} ref={ref} type={type} aria-label={label} title={title ?? label} className={classes} />
  }
)
