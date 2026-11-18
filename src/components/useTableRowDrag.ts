import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

export interface TableRowDrag {
  rowId: string;
  groupId: string;
  index: number;
}

export function useTableRowDrag(onDrop: (drag: TableRowDrag) => void, { withinGroup = false } = {}) {
  const [drag, setDrag] = useState<TableRowDrag | null>(null);
  const active = useRef<{
    pointerId: number;
    origin: HTMLTableSectionElement;
    initial: TableRowDrag;
    target: TableRowDrag;
  } | null>(null);
  const drop = useRef(onDrop);
  drop.current = onDrop;
  const dragging = drag !== null;

  useEffect(() => {
    if (!dragging) return;

    const move = (event: PointerEvent) => {
      const track = active.current;
      if (!track || track.pointerId !== event.pointerId) return;
      const under = document.elementFromPoint(event.clientX, event.clientY);
      const group = under?.closest<HTMLTableSectionElement>("tbody[data-row-group]");
      if (!group || (withinGroup && group !== track.origin)) return;

      const { rowId } = track.target;
      const row = under?.closest<HTMLTableRowElement>("tr[data-row-id]");
      if (row?.dataset.rowId === rowId) return;
      const rows = [...group.rows].filter((candidate) => candidate.dataset.rowId !== rowId);
      let index = rows.length;
      if (row) {
        const { top, height } = row.getBoundingClientRect();
        index = rows.indexOf(row) + (event.clientY > top + height / 2 ? 1 : 0);
      }
      const groupId = group.dataset.rowGroup!;
      if (track.target.groupId === groupId && track.target.index === index) return;
      track.target = { rowId, groupId, index };
      setDrag(track.target);
    };

    const finish = (event: PointerEvent, commit: boolean) => {
      const track = active.current;
      if (!track || track.pointerId !== event.pointerId) return;
      active.current = null;
      setDrag(null);
      if (commit && (track.target.groupId !== track.initial.groupId || track.target.index !== track.initial.index)) {
        drop.current(track.target);
      }
    };

    const end = (event: PointerEvent) => finish(event, true);
    const cancel = (event: PointerEvent) => finish(event, false);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", cancel);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", cancel);
    };
  }, [dragging, withinGroup]);

  const startDrag = (event: ReactPointerEvent) => {
    if (event.button !== 0 || active.current) return;
    const row = event.currentTarget.closest<HTMLTableRowElement>("tr[data-row-id]");
    const group = row?.closest<HTMLTableSectionElement>("tbody[data-row-group]");
    if (!row || !group) return;
    event.preventDefault();
    const target = { rowId: row.dataset.rowId!, groupId: group.dataset.rowGroup!, index: row.sectionRowIndex };
    active.current = { pointerId: event.pointerId, origin: group, initial: target, target };
    setDrag(target);
  };

  return { drag, startDrag };
}
