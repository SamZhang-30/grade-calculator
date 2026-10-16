import { useLayoutEffect, useRef, type ComponentPropsWithoutRef } from "react";

const openDialogs: HTMLElement[] = [];
const focusable = 'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])';

/** Shared keyboard behavior without changing the existing dialog layout. */
export function DialogSurface({ onClose, children, ...props }: ComponentPropsWithoutRef<"section"> & {
  onClose: () => void;
}) {
  const ref = useRef<HTMLElement>(null);
  const opener = useRef(typeof document === "undefined" ? null : document.activeElement);
  const close = useRef(onClose);
  close.current = onClose;
  useLayoutEffect(() => {
    const dialog = ref.current!;
    const previous = opener.current;
    openDialogs.push(dialog);
    const controls = () => [...dialog.querySelectorAll<HTMLElement>(focusable)]
      .filter((element) => element.tabIndex >= 0 && element.getClientRects().length && !element.closest('[hidden], [inert]'));
    const focusFirst = () => (controls()[0] ?? dialog).focus({ preventScroll: true });
    if (!dialog.contains(document.activeElement)) focusFirst();
    const topmost = () => openDialogs.at(-1) === dialog;
    const keydown = (event: KeyboardEvent) => {
      if (!topmost()) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        close.current();
      } else if (event.key === "Tab") {
        const elements = controls();
        const index = elements.indexOf(document.activeElement as HTMLElement);
        if (!elements.length || (event.shiftKey ? index <= 0 : index === elements.length - 1 || index < 0)) {
          event.preventDefault();
          (event.shiftKey ? elements.at(-1) ?? dialog : elements[0] ?? dialog).focus();
        }
      }
    };
    const focusin = (event: FocusEvent) => {
      if (topmost() && !dialog.contains(event.target as Node)) focusFirst();
    };
    document.addEventListener("keydown", keydown, true);
    document.addEventListener("focusin", focusin);
    return () => {
      const index = openDialogs.indexOf(dialog);
      if (index >= 0) openDialogs.splice(index, 1);
      document.removeEventListener("keydown", keydown, true);
      document.removeEventListener("focusin", focusin);
      // Layout cleanup runs before DOM removal; defer restoration so React's
      // Strict Mode effect replay does not steal a newly autofocus-ed input.
      queueMicrotask(() => {
        if (dialog.isConnected || openDialogs.at(-1)?.contains(document.activeElement)) return;
        if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true });
        else if (!openDialogs.length) document.querySelector<HTMLElement>(".course-emoji-trigger")?.focus({ preventScroll: true });
      });
    };
  }, []);
  useLayoutEffect(() => {
    const dialog = ref.current!;
    // A save/restore can remove the focused control without firing focusin.
    if (openDialogs.at(-1) === dialog && !dialog.contains(document.activeElement)) {
      (dialog.querySelector<HTMLElement>(focusable) ?? dialog).focus({ preventScroll: true });
    }
  });
  return <section {...props} ref={ref} role={props.role ?? "dialog"} aria-modal="true" tabIndex={-1}>{children}</section>;
}
