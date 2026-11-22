export function isGroupRowControl(target: EventTarget | null) {
  return target instanceof Element && !!target.closest(
    "button,a,input,select,textarea,label,[role=button],[role=checkbox],[popover],.report-check-cell",
  );
}
