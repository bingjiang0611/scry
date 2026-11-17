import { forwardRef, type ComponentPropsWithoutRef } from 'react'

export type ButtonVariant = 'primary' | 'secondary' | 'quiet' | 'danger'
export type ButtonSize = 'sm' | 'md'

type ButtonProps = ComponentPropsWithoutRef<'button'> & {
  /** primary: the one main action of a group; danger: irreversible confirm; quiet: low-emphasis inline action. */
  variant?: ButtonVariant
  /** md (32px) for dialogs and panels; sm (28px) for toolbars and inline rows. */
  size?: ButtonSize
}

export function buttonClassName(variant: ButtonVariant = 'secondary', size: ButtonSize = 'md', className?: string): string {
  return ['btn', variant === 'secondary' ? '' : variant, size === 'md' ? '' : size, className ?? ''].filter(Boolean).join(' ')
}

/**
 * The single text button of the renderer. Defaults to `type="button"` so a
 * button placed inside a form never submits it by accident; pass
 * `type="submit"` explicitly for the form's main action.
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  function Button({ variant, size, className, type = 'button', ...props }, ref) {
    return <button {...props} ref={ref} type={type} className={buttonClassName(variant, size, className)} />
  }
)
