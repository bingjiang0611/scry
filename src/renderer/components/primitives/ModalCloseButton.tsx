import { forwardRef, type ComponentPropsWithoutRef } from 'react'
import { Icon } from './Icon'

type ModalCloseButtonProps = Omit<ComponentPropsWithoutRef<'button'>, 'type'> & {
  'aria-label': string
}

/** Keeps modal close controls non-submitting, including those inside forms. */
export const ModalCloseButton = forwardRef<HTMLButtonElement, ModalCloseButtonProps>(
  function ModalCloseButton({ className, children = <Icon name="x" />, ...props }, ref) {
    return (
      <button {...props} ref={ref} type="button" className={className ? `modal-x ${className}` : 'modal-x'}>
        {children}
      </button>
    )
  }
)
