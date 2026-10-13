import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { GPA_EXCLUDED, type GpaGrade } from "../gpa";
import { useHistoryRevision } from "../history-ui";

const LETTERS: GpaGrade[] = ["A+", "A", "A-", "B+", "B", "B-", "C+", "C", "C-", "D+", "D", "D-"];
const GSB: GpaGrade[] = ["GSB:H", "GSB:HP", "GSB:P", "GSB:LP", "GSB:U"];

/** A portaled choice grid so it never clips against table scroll viewports. */
export function GpaGradePicker({ grade, label, onSelect }: {
  grade: GpaGrade;
  label: string;
  onSelect: (grade: GpaGrade) => void;
}) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const trigger = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const revision = useHistoryRevision();
  useEffect(() => setOpen(false), [revision]);

  const close = (restoreFocus = false) => {
    setOpen(false);
    if (restoreFocus) trigger.current?.focus();
  };

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const anchor = trigger.current?.getBoundingClientRect();
      const menu = popup.current?.getBoundingClientRect();
      if (!anchor || !menu) return;
      const below = anchor.bottom + 6;
      const above = anchor.top - menu.height - 6;
      const top = below + menu.height <= window.innerHeight - 12 ? below : above;
      setPosition({
        top: Math.max(12, Math.min(top, window.innerHeight - menu.height - 12)),
        left: Math.max(12, Math.min(anchor.left + (anchor.width - menu.width) / 2, window.innerWidth - menu.width - 12)),
      });
    };
    place();
    const selected = popup.current?.querySelector<HTMLButtonElement>('button[aria-pressed="true"]');
    selected?.focus({ preventScroll: true });
    const outside = (event: Event) => {
      const target = event.target as Node;
      if (!popup.current?.contains(target) && !trigger.current?.contains(target)) close();
    };
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); close(true); }
    };
    const observer = new ResizeObserver(place);
    if (popup.current) observer.observe(popup.current);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    window.addEventListener("pointerdown", outside, true);
    window.addEventListener("focusin", outside);
    window.addEventListener("keydown", escape);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("focusin", outside);
      window.removeEventListener("keydown", escape);
    };
  }, [open]);

  const navigate = (event: KeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    if (target.tagName !== "BUTTON") return;
    const grid = target.closest<HTMLElement>("[data-columns]");
    if (!grid) return;
    const choices = [...grid.querySelectorAll<HTMLButtonElement>("button")];
    const index = choices.indexOf(target as HTMLButtonElement);
    const columns = Number(grid.dataset.columns);
    const offsets: Record<string, number> = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: columns, ArrowUp: -columns };
    const offset = offsets[event.key];
    let next = index;
    if (offset !== undefined) next = Math.max(0, Math.min(index + offset, choices.length - 1));
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = choices.length - 1;
    else return;
    event.preventDefault();
    choices[next]?.focus();
  };

  const choices = (grades: readonly GpaGrade[]) => grades.map((value) => (
    <button type="button" key={value || "blank"} aria-pressed={grade === value}
      aria-label={value === "" ? "Clear grade" : value.startsWith("GSB:") ? `GSB ${value.slice(4)}` : value}
      title={value === "L" ? "Temporary grade" : undefined}
      onClick={() => { onSelect(value); close(true); }}>
      {value === "" ? "—" : value.startsWith("GSB:") ? value.slice(4) : value}
    </button>
  ));

  return <>
    <button type="button" ref={trigger} className={`gpa-grade-trigger${open ? " open" : ""}`}
      aria-label={label} aria-haspopup="dialog" aria-expanded={open}
      onClick={() => setOpen(!open)} onKeyDown={(event) => {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setOpen(true); }
      }}>{grade.startsWith("GSB:") ? `GSB ${grade.slice(4)}` : grade || "—"}</button>
    {open ? createPortal(
      <div ref={popup} className="gpa-grade-popup" style={position} role="dialog" aria-label={`Choose ${label}`} onKeyDown={navigate}>
        <div className="gpa-grade-popup-heading">Set Grade</div>
        <div className="gpa-grade-grid" data-columns="6" role="group" aria-label="Letter grades">{choices(LETTERS)}</div>
        <div className="gpa-grade-grid gpa-grade-special" data-columns="3" role="group" aria-label="Other GPA grades">{choices(["NP", "L", ""])}</div>
        <div className="gpa-grade-popup-label">Excluded from GPA</div>
        <div className="gpa-grade-grid gpa-grade-excluded" data-columns="6" role="group" aria-label="Excluded from GPA">{choices(GPA_EXCLUDED)}</div>
        <div className="gpa-grade-popup-label">GSB · Not MBA / MSx</div>
        <div className="gpa-grade-grid gpa-grade-gsb" data-columns="5" role="group" aria-label="GSB grades">{choices(GSB)}</div>
      </div>, document.body,
    ) : null}
  </>;
}
