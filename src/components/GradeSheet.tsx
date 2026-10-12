import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import {
  DEFAULT_GRADE_CONFIG,
  GRADEBOOK_FORMAT,
  curveError,
  forecast,
  hasActiveCurve,
  parseGradebook,
  serializeGradebook,
  summarize,
  type CategorySummary,
  type CurrentGradeWeighting,
  type EntrySummary,
  type CurveMode,
  type GradeStatus,
  type GradeSummary,
  type GradeWarning,
  type Interval,
  type WeightMode,
} from "../grade-engine";
import { autofillAssignmentName } from "../autofill";
import {
  api,
  store,
  type Course,
  type GradeCategoryRow,
  type GradeEntryPatch,
  type GradeEntryRow,
} from "../store";
import { unitInputValue } from "../units";

/**
 * Forecast settings resolve down three layers: app, then course, then category.
 *
 * Each layer is nullable against the one above it, so "follow the default" is a
 * real stored state rather than a coincidence of matching values. The course
 * layer exists because two courses can be predictable in completely different
 * ways, and because an exported gradebook should carry its own settings rather
 * than borrow whatever the account happened to be set to.
 */
export interface GradeDefaults {
  gradeAlpha: number;
  gradeBasis: ForecastBasis;
  gradeIncludeEstimates: boolean;
  gradeCapForecast: boolean;
  gradeCurrentWeighting: CurrentGradeWeighting;
}

/** What a course actually stores: nulls mean "follow the app". */
export interface CourseGradeSettings {
  gradeAlpha: number | null;
  gradeBasis: ForecastBasis | null;
  gradeIncludeEstimates: boolean | null;
  gradeCapForecast: boolean | null;
  gradeCurrentWeighting: CurrentGradeWeighting | null;
}

/** One layer resolved against the one beneath it. */
export function resolveDefaults(course: CourseGradeSettings, app: GradeDefaults): GradeDefaults {
  return {
    gradeAlpha: course.gradeAlpha ?? app.gradeAlpha,
    gradeBasis: course.gradeBasis ?? app.gradeBasis,
    gradeIncludeEstimates: course.gradeIncludeEstimates ?? app.gradeIncludeEstimates,
    gradeCapForecast: course.gradeCapForecast ?? app.gradeCapForecast,
    gradeCurrentWeighting: course.gradeCurrentWeighting ?? app.gradeCurrentWeighting,
  };
}
import type { ForecastBasis } from "../grade-engine";

/**
 * The course grade sheet.
 *
 * All arithmetic comes from the extracted grade engine and runs here, in the
 * browser, on every edit -- the server stores rows and nothing else. That is
 * the same discipline as XP: the numbers are always a function of the entries,
 * so there is nothing to invalidate and nothing that can drift.
 */

/**
 * The order a real assignment moves through: a maybe becomes scheduled, then
 * guessable, then marked. Clicking advances along that, and wraps.
 */
const STATUS_CYCLE: GradeStatus[] = ["POSSIBLE", "PENDING", "ESTIMATED", "RETURNED"];

/**
 * Deleting looks like deleting.
 *
 * An "✕" is the same glyph the dialog uses to close itself and the status chip
 * uses to mean nothing at all, so on a row full of controls it reads as one
 * more setting. A bin does not.
 */
function GearIcon() {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" fill="none"
      stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="8" cy="8" r="2.1" />
      <path d="M12.9 9.8a1.1 1.1 0 0 0 .22 1.21l.04.04a1.33 1.33 0 1 1-1.88 1.88l-.04-.04a1.1 1.1 0 0 0-1.21-.22 1.1 1.1 0 0 0-.66 1v.11a1.33 1.33 0 1 1-2.66 0v-.06a1.1 1.1 0 0 0-.72-1 1.1 1.1 0 0 0-1.21.22l-.04.04a1.33 1.33 0 1 1-1.88-1.88l.04-.04a1.1 1.1 0 0 0 .22-1.21 1.1 1.1 0 0 0-1-.66h-.11a1.33 1.33 0 1 1 0-2.66h.06a1.1 1.1 0 0 0 1-.72 1.1 1.1 0 0 0-.22-1.21l-.04-.04a1.33 1.33 0 1 1 1.88-1.88l.04.04a1.1 1.1 0 0 0 1.21.22h.05a1.1 1.1 0 0 0 .66-1v-.11a1.33 1.33 0 0 1 2.66 0v.06a1.1 1.1 0 0 0 .66 1 1.1 1.1 0 0 0 1.21-.22l.04-.04a1.33 1.33 0 1 1 1.88 1.88l-.04.04a1.1 1.1 0 0 0-.22 1.21v.05a1.1 1.1 0 0 0 1 .66h.11a1.33 1.33 0 1 1 0 2.66h-.06a1.1 1.1 0 0 0-1 .66Z" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" fill="none"
      stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
      <path d="M8 3v10M3 8h10" />
    </svg>
  );
}

function CalculatorIcon() {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" fill="none"
      stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="1.6" width="10" height="12.8" rx="1.6" />
      <path d="M5.3 4.4h5.4M5.5 7.6h.01M8 7.6h.01M10.5 7.6h.01M5.5 10h.01M8 10h.01M10.5 10h.01M5.5 12.3h5" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" fill="none"
      stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2.5 4h11M6.4 4V2.6h3.2V4M4.1 4l.6 9.2a1 1 0 0 0 1 .9h4.6a1 1 0 0 0 1-.9L12 4M6.6 6.8v4.4M9.4 6.8v4.4" />
    </svg>
  );
}

function ExportIcon() {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 10.5v-8M5.2 5.3 8 2.5l2.8 2.8M3 9.5v3.2h10V9.5" />
    </svg>
  );
}

function ImportIcon() {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 2.5v8M5.2 7.7 8 10.5l2.8-2.8M3 9.5v3.2h10V9.5" />
    </svg>
  );
}

function GripIcon() {
  return (
    <svg viewBox="0 0 14 18" width="14" height="18" aria-hidden="true">
      <circle cx="4" cy="4" r="1.25" />
      <circle cx="10" cy="4" r="1.25" />
      <circle cx="4" cy="9" r="1.25" />
      <circle cx="10" cy="9" r="1.25" />
      <circle cx="4" cy="14" r="1.25" />
      <circle cx="10" cy="14" r="1.25" />
    </svg>
  );
}

const STATUS_LABEL: Record<GradeStatus, string> = {
  RETURNED: "returned",
  ESTIMATED: "estimated",
  PENDING: "pending",
  POSSIBLE: "possible",
};

const pct = (x: number | null | undefined, digits = 2) =>
  x === null || x === undefined ? "—" : `${(x * 100).toFixed(digits)}%`;

function NotApplicable() {
  return <span className="not-applicable">N/A</span>;
}

/**
 * A signed percentage -- but only when there is a sign to give.
 *
 * A value that rounds to zero at the precision shown has no direction, and
 * printing "+0.00%" invents one. Zero reads as zero; the sign is reserved for
 * numbers that actually moved something.
 */
const signed = (x: number) => {
  const magnitude = Math.abs(x * 100).toFixed(2);
  return magnitude === "0.00" ? "0.00%" : `${x > 0 ? "+" : "−"}${magnitude}%`;
};

/**
 * How much is still undecided, counted in the unit the category is weighed in.
 *
 * A points-weighted category is missing POINTS; an evenly weighted one is
 * missing ASSIGNMENTS, because that is what its weight is divided between. The
 * same "30 (4.29%)" means two different things in the two modes, so it should
 * not be spelled the same way.
 */
/** Pooling is points-proportional by definition, so the toggle cannot apply. */
const byMaxOf = (category: GradeCategoryRow | undefined) =>
  category === undefined || category.weightMode === "POOLED" ? true : category.weightByMax;

const atStakeLabel = (category: CategorySummary, byMax: boolean) => {
  return byMax
    ? `${round(category.atStakePoints, 2)} pts.`
    : `${category.atStakeCount} ents.`;
};

/** Zero to two decimals -- the threshold `signed` and `tone` both work from. */
const isZero = (x: number) => Math.abs(x * 100).toFixed(2) === "0.00";

/**
 * Impact is coloured by its SIGN: red when it drags the grade down, green when
 * it pushes it up, and plain text at exactly zero, where "no effect" is the
 * whole message and a colour would invent one.
 *
 * Stand to gain and stand to lose are different: they are not signed
 * quantities but two named directions, so they keep their colour whatever the
 * arithmetic says. See `SummaryRow`.
 */
const tone = (x: number) => (isZero(x) ? "" : x > 0 ? "good" : "bad");

/** A projection reads as one number when its ends round together, else a range. */
const range = (interval: Interval | null) => {
  if (!interval) return "—";
  const low = Math.round(interval.low * 100);
  const high = Math.round(interval.high * 100);
  return low === high ? `${low}` : `${low}–${high}`;
};

const rangePct = (interval: Interval | null) => {
  const value = range(interval);
  return value === "—" ? value : `${value}%`;
};

function CurveSwap({ curved, raw }: { curved: string; raw: string }) {
  return (
    <>
      <span className="curve-applied">{curved}</span>
      <span className="curve-raw">{raw}</span>
    </>
  );
}

/** A row being dragged, and where it would land if released now. */
interface Drag {
  entryId: string;
  fromCategoryId: string;
  overCategoryId: string;
  overIndex: number;
}

type AutofillField = "name" | "points" | "max" | "status";

type AutofillSeed =
  | { field: "name"; value: string }
  | { field: "points" | "max"; value: number | null }
  | { field: "status"; value: GradeStatus };

type AutofillDrag = AutofillSeed & {
  pointerId: number;
  sourceIndex: number;
  overIndex: number;
};

function AutofillHandle({
  label,
  onPointerDown,
}: {
  label: string;
  onPointerDown: (event: React.PointerEvent<HTMLButtonElement>) => void;
}) {
  return (
    <button
      type="button"
      className="autofill-handle"
      tabIndex={-1}
      aria-label={label}
      title={label}
      onPointerDown={onPointerDown}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
    />
  );
}

/**
 * The layout as it would be if the drag were released now.
 *
 * One function drives both the live preview and the write, so what you see
 * mid-drag is exactly what gets saved -- including the recalculated weights
 * when a row crosses into a category with a different weighting.
 */
function applyDrag(categories: GradeCategoryRow[], drag: Drag | null): GradeCategoryRow[] {
  if (!drag) return categories;
  const moving = categories.flatMap((c) => c.entries).find((e) => e.id === drag.entryId);
  if (!moving) return categories;

  return categories.map((category) => {
    const entries = category.entries.filter((e) => e.id !== drag.entryId);
    if (category.id !== drag.overCategoryId) {
      return entries.length === category.entries.length ? category : { ...category, entries };
    }
    const index = Math.max(0, Math.min(drag.overIndex, entries.length));
    return { ...category, entries: [...entries.slice(0, index), moving, ...entries.slice(index)] };
  });
}

const orderOf = (categories: GradeCategoryRow[]) =>
  categories.map((c) => ({ id: c.id, entryIds: c.entries.map((e) => e.id) }));

/**
 * A popover that commits before it closes.
 *
 * Fields inside commit on blur, but closing UNMOUNTS them and an unmounted
 * input never fires blur -- so anything typed and then dismissed with a click
 * outside was silently discarded. The commit runs through a ref so the
 * document listener never holds a stale closure.
 */
function usePopover(commit?: () => void) {
  const [open, setOpen] = useState(false);
  const hostRef = useRef<HTMLSpanElement | null>(null);
  const commitRef = useRef<() => void>(() => {});
  commitRef.current = commit ?? (() => {});

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      // Against THIS popover's own host, not any host on the page. Testing for
      // the class meant a click on a different category's gear counted as
      // "inside", so the old panel stayed open behind the new one.
      if (hostRef.current?.contains(event.target as Node)) return;
      commitRef.current();
      setOpen(false);
    };
    window.addEventListener("pointerdown", close, true);
    return () => window.removeEventListener("pointerdown", close, true);
  }, [open]);

  return { open, setOpen, hostRef };
}

/** A horizontal table viewport that advertises hidden content only on the edge
 * where more columns actually exist. The fade spans the viewer's full height. */
function ScrollViewport({ children, className = "" }: { children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [edges, setEdges] = useState({ left: false, right: false });

  const updateEdges = (node: HTMLDivElement) => {
    const maxScroll = Math.max(0, node.scrollWidth - node.clientWidth);
    // WebKit can briefly report positions outside the scrollable range while
    // rubber-banding. Clamp them immediately so sticky cells never get pulled
    // away from their frozen edge.
    const clampedScroll = Math.min(maxScroll, Math.max(0, node.scrollLeft));
    if (node.scrollLeft !== clampedScroll) node.scrollLeft = clampedScroll;
    const overflow = maxScroll > 1;
    setEdges({
      left: overflow && clampedScroll > 1,
      right: overflow && clampedScroll < maxScroll - 1,
    });
  };

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const update = () => updateEdges(node);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(node);
    if (node.firstElementChild) observer.observe(node.firstElementChild);
    return () => observer.disconnect();
  }, [children]);

  return (
    <div className={`scroll-frame${className ? ` ${className}-frame` : ""}${edges.left ? " can-scroll-left" : ""}${edges.right ? " can-scroll-right" : ""}`}>
      <div ref={ref} className={`grade-scroll ${className}`.trim()} onScroll={() => {
        const node = ref.current;
        if (!node) return;
        updateEdges(node);
      }}>
        {children}
      </div>
    </div>
  );
}

function GradeModal({
  children,
  onClose,
  className = "",
  label = "Settings",
}: {
  children: ReactNode;
  onClose: () => void;
  className?: string;
  label?: string;
}) {
  return (
    <div className="modal-backdrop grade-modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className={`settings-dialog grade-popover modal-surface ${className}`.trim()} role="dialog" aria-modal="true" aria-label={label}>
        <button className="modal-close" onClick={onClose} aria-label="Close settings">×</button>
        {children}
      </section>
    </div>
  );
}

function SettingsIntro({
  eyebrow,
  title,
  description,
}: {
  eyebrow: string;
  title: string;
  description: string;
}) {
  return (
    <>
      <div className="dialog-head modal-dialog-head">
        <div>
          <p className="eyebrow">{eyebrow}</p>
          <h2>{title}</h2>
        </div>
      </div>
      <p className="dialog-intro">{description}</p>
    </>
  );
}

/** Everything the sheet derives, in one place, so both views agree by construction. */
function useSheet(
  categories: GradeCategoryRow[],
  alpha: number,
  defaultBasis: ForecastBasis,
  includeEstimates: boolean,
  capForecast: boolean,
  currentWeighting: CurrentGradeWeighting,
) {
  return useMemo(() => {
    // The engine takes a weight, not a flag: 0 excludes a guess from the
    // evidence, 1 counts it as an ordinary mark, and it can do fractions the UI
    // has no way to ask for yet.
    const config = {
      ...DEFAULT_GRADE_CONFIG,
      alpha,
      defaultBasis,
      estimateWeight: includeEstimates ? 1 : 0,
      capForecastAtFull: capForecast,
      currentGradeWeighting: currentWeighting,
    };
    const priced = categories.map((c) => ({
      ...c,
      estimateWeight: c.includeEstimates === null ? null : c.includeEstimates ? 1 : 0,
      capForecast: c.capForecast,
    }));
    const summary = summarize(priced, config);
    return { summary, prediction: forecast(priced, summary, config) };
  }, [categories, alpha, defaultBasis, includeEstimates, capForecast, currentWeighting]);
}

/** How a category's share of the grade came about, in words. */
function weightLine(
  category: GradeCategoryRow,
  summary: CategorySummary,
): string {
  if (category.weightMode === "POOLED") {
    return `Pooled final weight: ${pct(summary.syllabusWeight)} · current: ${pct(summary.weight)}`;
  }
  const split = category.weightByMax ? "" : ", split evenly";
  return `Fixed weight: ${pct(category.weight, 2)}${split}`;
}

const BASIS_LABEL: Record<ForecastBasis, string> = {
  COURSE: "Whole course",
  COURSE_WHEN_SPARSE: "Course until category has marks",
  CATEGORY: "Each category only",
};

/**
 * The one-line version, for the reference tab.
 *
 * Enough to answer "how is this course going" without opening the sheet, and
 * nothing that needs a table to read.
 */
export function GradeSummaryCard({
  categories,
  alpha,
  basis,
  includeEstimates,
  capForecast,
  currentWeighting,
  onOpen,
}: {
  categories: GradeCategoryRow[];
  alpha: number;
  basis: ForecastBasis;
  includeEstimates: boolean;
  capForecast: boolean;
  currentWeighting: CurrentGradeWeighting;
  onOpen: () => void;
}) {
  const { summary, prediction } = useSheet(
    categories,
    alpha,
    basis,
    includeEstimates,
    capForecast,
    currentWeighting,
  );

  if (categories.length === 0) {
    return (
      <section>
        <h3>Grades</h3>
        <p className="muted">No gradebook yet.</p>
        <button className="ghost add" onClick={onOpen}>
          + Set up the gradebook
        </button>
      </section>
    );
  }

  return (
    <section>
      <h3>Grades</h3>
      <div className="grade-card">
        <div className="grade-figure">
          <span className="grade-big">{pct(summary.percent)}</span>
          <span className="muted">current grade</span>
        </div>
        <div className="grade-figure">
          <span className="grade-big">{pct(summary.atStakePercent)}</span>
          <span className="muted">still at stake</span>
        </div>
        <div className="grade-figure">
          <span className="grade-big">{range(prediction.result)}</span>
          <span className="muted">projected finish</span>
        </div>
      </div>
      <button className="ghost add" onClick={onOpen}>
        Open the gradebook →
      </button>
    </section>
  );
}

function WarningIndicator({ warnings }: { warnings: GradeWarning[] }) {
  if (warnings.length === 0) return null;

  return (
    <span className="warning-indicator">
      <button
        className="warning-trigger"
        aria-label={`${warnings.length} gradebook warning${warnings.length === 1 ? "" : "s"}`}
      >
        !
        <b>{warnings.length}</b>
      </button>
      <span className="warning-tooltip" role="tooltip">
        <strong>Check these numbers</strong>
        {warnings.map((warning) => (
          <span key={`${warning.code}${warning.categoryId ?? ""}${warning.entryId ?? ""}`}>
            {warning.detail}
          </span>
        ))}
      </span>
    </span>
  );
}

function SummaryHighlights({
  summary,
  prediction,
  confidence,
}: {
  summary: GradeSummary;
  prediction: ReturnType<typeof forecast>;
  confidence: number;
}) {
  return (
    <div className="forecast-highlights">
      <article className="forecast-card primary">
        <span>Current grade</span>
        <strong>{pct(summary.percent)}</strong>
        <small>Across work counted so far</small>
      </article>
      <article className="forecast-card">
        <span>Projected finish</span>
        <strong>{rangePct(prediction.result)}</strong>
        <small>{Math.round(confidence * 100)}% forecast interval</small>
      </article>
      <article className="forecast-card">
        <span>Still in play</span>
        <strong>{pct(summary.atStakePercent)}</strong>
        <small>Share of the final grade undecided</small>
      </article>
    </div>
  );
}

export function GradeSheet({
  itemId,
  courseName,
  categories,
  course,
  app,
  onChanged,
  courseHeader,
  courseIdentitySettings,
  onDeleteCourse,
}: {
  itemId: string;
  courseName: string;
  categories: GradeCategoryRow[];
  course: Course;
  app: GradeDefaults;
  onChanged: () => void;
  courseHeader: ReactNode;
  courseIdentitySettings: ReactNode;
  onDeleteCourse: () => void;
}) {
  const defaults = resolveDefaults(course, app);
  const [error, setError] = useState("");
  const [draft, setDraft] = useState({ name: "", weight: "" });

  // The ref is the authority; the state exists only so React re-renders the
  // preview. The commit reads the REF -- StrictMode double-invokes updaters,
  // and a write from inside one would fire twice.
  const dragRef = useRef<Drag | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);

  const layout = useMemo(() => applyDrag(categories, drag), [categories, drag]);
  const { summary, prediction } = useSheet(
    layout,
    defaults.gradeAlpha,
    defaults.gradeBasis,
    defaults.gradeIncludeEstimates,
    defaults.gradeCapForecast,
    defaults.gradeCurrentWeighting,
  );

  const run = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      setError("");
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  // Kept in a ref so the pointer listeners below never close over a stale one.
  const commitRef = useRef<(drag: Drag) => void>(() => {});
  commitRef.current = (dropped) => {
    const next = applyDrag(categories, dropped);
    if (JSON.stringify(orderOf(next)) === JSON.stringify(orderOf(categories))) return;
    void run(() => api.reorderGrades(itemId, orderOf(next)));
  };

  const dragging = drag !== null;
  useEffect(() => {
    if (!dragging) return;

    const move = (event: PointerEvent) => {
      const current = dragRef.current;
      if (!current) return;
      const under = document.elementFromPoint(event.clientX, event.clientY);
      const body = under?.closest("tbody[data-category]") as HTMLElement | null;
      if (!body) return;

      const categoryId = body.dataset.category!;
      const rows = [...body.querySelectorAll<HTMLElement>("tr[data-entry]")].filter(
        (r) => r.dataset.entry !== current.entryId,
      );
      const row = under?.closest("tr[data-entry]") as HTMLElement | null;

      let index = rows.length;
      if (row && row.dataset.entry !== current.entryId) {
        const rect = row.getBoundingClientRect();
        index = rows.indexOf(row) + (event.clientY > rect.top + rect.height / 2 ? 1 : 0);
      } else if (row) {
        return; // hovering the row being dragged: nothing has changed
      }

      if (current.overCategoryId === categoryId && current.overIndex === index) return;
      const next = { ...current, overCategoryId: categoryId, overIndex: index };
      dragRef.current = next;
      setDrag(next);
    };

    const end = () => {
      const dropped = dragRef.current;
      dragRef.current = null;
      setDrag(null);
      if (dropped) commitRef.current(dropped);
    };

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
    };
  }, [dragging]);

  const startDrag = (event: React.PointerEvent, entryId: string, categoryId: string) => {
    event.preventDefault();
    const index = categories
      .find((c) => c.id === categoryId)!
      .entries.findIndex((e) => e.id === entryId);
    const next = {
      entryId,
      fromCategoryId: categoryId,
      overCategoryId: categoryId,
      overIndex: index,
    };
    dragRef.current = next;
    setDrag(next);
  };

  const addCategory = async () => {
    if (!draft.name.trim()) return;
    const weight = draft.weight.trim();
    await run(() =>
      api.addGradeCategory(itemId, {
        name: draft.name.trim(),
        // Typed as a percentage, stored as a fraction. A blank weight means
        // "pool it" -- the category shares whatever the fixed ones left.
        weight: weight === "" ? 0 : Number(weight) / 100,
        weightMode: weight === "" ? "POOLED" : "FIXED",
      }),
    );
    setDraft({ name: "", weight: "" });
  };

  return (
    <div className={dragging ? "grades-dragging" : undefined}>
      <header className="course-head">
        {courseHeader}
        <div className="head-actions course-toolbar">
          <WarningIndicator warnings={summary.warnings} />
          <CourseCalculations
            itemId={itemId}
            course={course}
            app={app}
            categories={categories}
            courseName={courseName}
            identitySettings={courseIdentitySettings}
            onDeleteCourse={onDeleteCourse}
            run={run}
          />
        </div>
      </header>

      <section className="grade-overview">
        {layout.length === 0 ? (
          <p className="muted grade-empty-copy">
            Add a category below — one per weighted bucket on the syllabus. Enter every assignment
            up front, including the ones not yet marked: rows left <b>pending</b> count toward what
            is still at stake without touching your current grade.
          </p>
        ) : (
          <>
            <SummaryHighlights
              summary={summary}
              prediction={prediction}
              confidence={1 - defaults.gradeAlpha}
            />
            <SummaryTable summary={summary} prediction={prediction} categories={layout} />
          </>
        )}

        <StatusGuide />
      </section>

      {layout.map((category, i) => (
        <CategoryTable
          key={category.id}
          category={category}
          summary={summary.categories[i]!}
          draggingId={drag?.entryId ?? null}
          defaults={defaults}
          onDragStart={startDrag}
          run={run}
        />
      ))}

      <section>
        <div className="grade-add">
          <input
            placeholder="New category"
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            onKeyDown={(e) => e.key === "Enter" && void addCategory()}
          />
          <input
            style={{ width: 90 }}
            inputMode="decimal"
            placeholder="Weight %"
            value={draft.weight}
            onChange={(e) => setDraft({ ...draft, weight: e.target.value })}
            onKeyDown={(e) => e.key === "Enter" && void addCategory()}
          />
          <button className="ghost tiny" onClick={addCategory} disabled={!draft.name.trim()}>
            + Add category
          </button>
          <span className="note">Leave the weight blank to share the leftover by points.</span>
        </div>
        {error ? <div className="err">{error}</div> : null}
      </section>
    </div>
  );
}

/**
 * The course defaults: what every category uses unless it says otherwise.
 *
 * Same two dials as a category's, one level up. Kept behind the same icon so
 * the relationship is obvious -- this is the row the per-category ones inherit.
 */
function CourseCalculations({
  itemId,
  course,
  app,
  categories,
  courseName,
  identitySettings,
  onDeleteCourse,
  run,
}: {
  itemId: string;
  course: Course;
  app: GradeDefaults;
  categories: GradeCategoryRow[];
  courseName: string;
  identitySettings: ReactNode;
  onDeleteCourse: () => void;
  run: (fn: () => Promise<unknown>) => Promise<void>;
}) {
  const resolved = resolveDefaults(course, app);
  const [level, setLevel] = useState(
    course.gradeAlpha === null ? "" : String(round((1 - course.gradeAlpha) * 100, 2)),
  );
  const [details, setDetails] = useState({
    name: course.name,
    term: course.term,
    instructor: course.instructor,
    units: unitInputValue(course.units),
  });

  useEffect(() => {
    setDetails({ name: course.name, term: course.term, instructor: course.instructor, units: unitInputValue(course.units) });
  }, [course.id, course.name, course.term, course.instructor, course.units]);

  const commit = () => {
    const text = level.trim();
    if (text === "") {
      if (course.gradeAlpha !== null) void run(() => api.updateItem(itemId, { gradeAlpha: null }));
      return;
    }
    const value = Number(text);
    if (!Number.isFinite(value) || value <= 0 || value >= 100) {
      setLevel(course.gradeAlpha === null ? "" : String(round((1 - course.gradeAlpha) * 100, 2)));
      return;
    }
    const alpha = 1 - value / 100;
    if (course.gradeAlpha !== null && Math.abs(alpha - course.gradeAlpha) < 1e-9) return;
    void run(() => api.updateItem(itemId, { gradeAlpha: alpha }));
  };

  const commitDetails = () => {
    const next = {
      name: details.name.trim() || course.name,
      term: details.term.trim(),
      instructor: details.instructor.trim(),
      units: details.units.trim(),
    };
    if (next.name === course.name && next.term === course.term && next.instructor === course.instructor && next.units === course.units) return;
    void run(() => store.updateCourse(itemId, next));
  };

  const inherits =
    course.gradeAlpha === null &&
    course.gradeBasis === null &&
    course.gradeIncludeEstimates === null &&
    course.gradeCapForecast === null &&
    course.gradeCurrentWeighting === null;

  const close = () => {
    commit();
    commitDetails();
    setOpen(false);
  };
  const { open, setOpen, hostRef } = usePopover(() => {
    commit();
    commitDetails();
  });

  return (
    <span className="popover-host" ref={hostRef}>
      <button
        className={`ghost icon${inherits ? "" : " on"}${open ? " open" : ""}`}
        onClick={() => setOpen(!open)}
        aria-label="Course settings"
        title={
          inherits
            ? "Course settings"
            : "Course settings — calculations differ from the app defaults"
        }
      >
        <GearIcon />
      </button>
      {open ? (
        <GradeModal className="course-settings-modal" onClose={close} label="Course settings">
          <SettingsIntro
            eyebrow="Course"
            title="Course settings"
            description="Details, predictions, files, and course actions in one place."
          />

          <section className="settings-group">
            <div className="settings-group-heading">
              <b>Course identity</b>
              <small>Name, icon, color, and information shown in the course header.</small>
            </div>
            {identitySettings}
            <div className="course-detail-fields">
              <label className="field-row">
                <span><b>Name</b><small>The name used in the header and class switcher.</small></span>
                <input aria-label="Class name" value={details.name} onChange={(event) => setDetails({ ...details, name: event.target.value })} onBlur={commitDetails} />
              </label>
              <label className="field-row">
                <span><b>Term</b><small>Semester, quarter, or other academic term.</small></span>
                <input value={details.term} placeholder="e.g. Fall 2026" onChange={(event) => setDetails({ ...details, term: event.target.value })} onBlur={commitDetails} />
              </label>
              <label className="field-row">
                <span><b>Instructor</b><small>Optional name shown beneath the course title.</small></span>
                <input value={details.instructor} placeholder="Instructor" onChange={(event) => setDetails({ ...details, instructor: event.target.value })} onBlur={commitDetails} />
              </label>
              <label className="field-row">
                <span><b>Units</b><small>Whole-number course credit count.</small></span>
                <input
                  inputMode="numeric"
                  pattern="[0-9]*"
                  value={details.units}
                  placeholder="e.g. 5"
                  onChange={(event) => {
                    if (/^\d*$/.test(event.target.value)) {
                      setDetails({ ...details, units: event.target.value });
                    }
                  }}
                  onBlur={commitDetails}
                />
              </label>
            </div>
          </section>

          <section className="settings-group">
            <div className="settings-group-heading">
              <b>Grade calculations</b>
              <small>Coursewide settings inherited from the app defaults.</small>
            </div>

            <label className="field-row">
              <span>
                <b>Current-grade weighting</b>
                <small>Final-weight mode uses pending assignments before renormalizing scored work.</small>
              </span>
              <select
                value={resolved.gradeCurrentWeighting}
                onChange={(event) =>
                  run(() =>
                    api.updateItem(itemId, {
                      gradeCurrentWeighting: event.target.value as CurrentGradeWeighting,
                    }),
                  )
                }
              >
                <option value="FINAL_ASSIGNMENT">Final assignment weights</option>
                <option value="CATEGORY_PROGRESS">Category progress</option>
              </select>
            </label>

            <label className="field-row">
              <span><b>Confidence interval</b><small>Blank follows the app default of {Math.round((1 - app.gradeAlpha) * 100)}%.</small></span>
              <span className="suffix-input">
                <input
                  inputMode="decimal"
                  placeholder={String(Math.round((1 - app.gradeAlpha) * 100))}
                  value={level}
                  onChange={(e) => setLevel(e.target.value)}
                  onBlur={commit}
                  onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
                />
                <i>%</i>
              </span>
            </label>

            <BasisChoice
              name="course-basis"
              value={resolved.gradeBasis}
              onChange={(basis) => run(() => api.updateItem(itemId, { gradeBasis: basis }))}
            />

            <EstimateChoice
              checked={resolved.gradeIncludeEstimates}
              onChange={(next) => run(() => api.updateItem(itemId, { gradeIncludeEstimates: next }))}
            />

            <CapChoice
              checked={!resolved.gradeCapForecast}
              onChange={(next) => run(() => api.updateItem(itemId, { gradeCapForecast: !next }))}
            />

            {inherits ? null : (
              <button
                className="ghost link reset"
                onClick={() => {
                  setLevel("");
                  void run(() =>
                    api.updateItem(itemId, {
                      gradeAlpha: null,
                      gradeBasis: null,
                      gradeIncludeEstimates: null,
                      gradeCapForecast: null,
                      gradeCurrentWeighting: null,
                    }),
                  );
                }}
              >
                ↺ Follow the app defaults
              </button>
            )}
          </section>

          <section className="settings-group">
            <div className="settings-group-heading">
              <b>Gradebook data</b>
              <small>Export a backup or replace this course from a file.</small>
            </div>
            <Transfer
              itemId={itemId}
              name={courseName}
              categories={categories}
              defaults={resolved}
              run={run}
              panel
            />
          </section>

          <section className="settings-group danger-settings-group">
            <div className="settings-group-heading">
              <b>Course actions</b>
              <small>Actions that affect the entire course.</small>
            </div>
            <button
              className="course-delete-action"
              onClick={() => {
                setOpen(false);
                onDeleteCourse();
              }}
            >
              <TrashIcon />
              <span><b>Delete course</b><small>Remove this course and all of its assignments.</small></span>
            </button>
          </section>

          <div className="dialog-footer">
            <span>Changes are saved automatically.</span>
            <button className="primary-button" onClick={close}>Done</button>
          </div>
        </GradeModal>
      ) : null}
    </span>
  );
}

/** Whether guesses count as evidence. Shared by the course and category popovers. */
function EstimateChoice({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <label className="toggle-row">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>
        <b>Count estimated marks as evidence</b>
        <small>Estimated marks always affect the current grade. This also lets them narrow the forecast.</small>
      </span>
    </label>
  );
}

/** Whether the band is held to 100%. Shared by every level. */
function CapChoice({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <label className="toggle-row">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>
        <b>Allow extra credit in forecasts</b>
        <small>Projected results may extend beyond 100%, with conservative damping.</small>
      </span>
    </label>
  );
}

/** The three prediction sources, shared by the course and category popovers. */
function BasisChoice({
  name,
  value,
  onChange,
}: {
  name: string;
  value: ForecastBasis;
  onChange: (basis: ForecastBasis) => void;
}) {
  return (
    <label className="field-row">
      <span>
        <b>Prediction source</b>
        <small>Where future-score evidence should come from.</small>
      </span>
      <select name={name} value={value} onChange={(event) => onChange(event.target.value as ForecastBasis)}>
        {(Object.keys(BASIS_LABEL) as ForecastBasis[]).map((option) => (
          <option key={option} value={option}>{BASIS_LABEL[option]}</option>
        ))}
      </select>
    </label>
  );
}

function SummaryTable({
  summary,
  prediction,
  categories,
}: {
  summary: GradeSummary;
  prediction: ReturnType<typeof forecast>;
  categories: GradeCategoryRow[];
}) {
  const tableRef = useRef<HTMLTableElement | null>(null);
  const [categoryWidth, setCategoryWidth] = useState(140);
  const categoryNames = categories.map((category) => category.name);
  const categoryMeasureKey = categoryNames.join("\u0000");

  useLayoutEffect(() => {
    const table = tableRef.current;
    if (!table) return;

    const measure = () => {
      const labels = table.querySelectorAll<HTMLElement>(
        ".summary-category-head > span, tbody td.sticky-col",
      );
      let requiredWidth = 0;

      for (const label of labels) {
        const range = document.createRange();
        range.selectNodeContents(label);
        const style = getComputedStyle(label);
        const padding = Number.parseFloat(style.paddingLeft) + Number.parseFloat(style.paddingRight);
        requiredWidth = Math.max(requiredWidth, range.getBoundingClientRect().width + padding);
        range.detach();
      }

      // Two pixels absorb fractional glyph and border rounding so the widest
      // label never acquires an ellipsis at a different zoom level.
      setCategoryWidth(Math.max(1, Math.ceil(requiredWidth) + 2));
    };

    measure();
    window.addEventListener("resize", measure);
    void document.fonts?.ready.then(measure);
    return () => window.removeEventListener("resize", measure);
  }, [categoryMeasureKey]);

  const summaryStyle = {
    "--summary-name-width": `${categoryWidth}px`,
  } as CSSProperties;

  return (
    <div className="summary-table-shell" style={summaryStyle}>
    <ScrollViewport className="summary-scroll">
      <table ref={tableRef} className="rows grades">
        <colgroup>
          <col className="col-name" />
          <col span={4} className="col-figure" />
          <col className="col-stake" />
          <col className="col-figure-lead" />
          <col span={3} className="col-figure" />
        </colgroup>
        <thead>
          {/* The split is fact vs. model, not present vs. future: everything on
              the left is arithmetic over rows that exist, and everything on the
              right moves when the forecast settings do. At stake looks like a
              future quantity but is pure arithmetic, so it sits on the left. */}
          <tr className="band">
            <th rowSpan={2} className="sticky-col summary-category-head">
              <span>Category</span>
            </th>
            <th colSpan={5}>
              <span className="band-label">Where you stand</span>
            </th>
            <th colSpan={4} className="proj proj-start">
              <span className="band-label">Projected</span>
            </th>
          </tr>
          <tr>
            <th>Percent</th>
            <th>Weight</th>
            <th>Impact</th>
            <th>Std. dev.</th>
            <th>At stake</th>
            <th className="proj proj-start">Expected</th>
            <th className="proj">Result</th>
            <th className="proj">Gain</th>
            <th className="proj">Lose</th>
          </tr>
        </thead>
        <tbody>
          {summary.categories.map((c, i) => {
            const f = prediction.categories[i]!;
            const category = categories.find((raw) => raw.id === c.id);
            const curved =
              category !== undefined &&
              category.entries.length > 0 &&
              c.syllabusWeight > 0 &&
              hasActiveCurve(category);
            return (
              <tr key={c.id}>
                <td className="sticky-col">{category?.name ?? "—"}</td>
                <td
                  className={curved && c.percent !== null ? "curved-cell" : undefined}
                  title={curved && c.percent !== null ? "Curved score — hover to see the raw score" : undefined}
                >
                  {c.percent === null ? (
                    <NotApplicable />
                  ) : curved ? (
                    <CurveSwap curved={pct(c.percent)} raw={pct(c.rawPercent)} />
                  ) : (
                    pct(c.percent)
                  )}
                </td>
                <td className="weight-cell" aria-label={`Current weight ${pct(c.weight)}; final weight ${pct(c.finalWeight)}`}>
                  <CurveSwap curved={pct(c.weight)} raw={pct(c.finalWeight)} />
                </td>
                <td className={c.percent === null ? undefined : tone(c.impact)}>
                  {c.percent === null ? <NotApplicable /> : signed(c.impact)}
                </td>
                <td>{c.percent === null ? <NotApplicable /> : pct(f.sd)}</td>
                <td className="at-stake-cell">
                  <CurveSwap curved={pct(c.atStakePercent)} raw={atStakeLabel(c, byMaxOf(category))} />
                </td>
                <td
                  className={`proj proj-start${curved ? " curved-cell" : ""}`}
                  title={curved ? "Curved forecast — hover to see the raw forecast" : undefined}
                >
                  {curved ? (
                    <CurveSwap curved={range(f.expected)} raw={range(f.rawExpected)} />
                  ) : range(f.expected)}
                </td>
                <td
                  className={`proj${curved && f.result !== null ? " curved-cell" : ""}`}
                  title={curved && f.result !== null ? "Curved result — hover to see the raw result" : undefined}
                >
                  {curved && f.result !== null ? (
                    <CurveSwap curved={range(f.result)} raw={range(f.rawResult)} />
                  ) : range(f.result)}
                </td>
                {/* "—" means the category cannot be projected at all; a plain
                    0.00% means it can, and the answer is that nothing moves. */}
                <td className={`proj ${f.result && !isZero(f.standToGain) ? "good" : ""}`}>
                  {f.result ? signed(f.standToGain) : "—"}
                </td>
                <td className={`proj ${f.result && !isZero(f.standToLose) ? "bad" : ""}`}>
                  {f.result ? signed(f.standToLose) : "—"}
                </td>
              </tr>
            );
          })}
          <tr className="total">
            <td className="sticky-col">Total</td>
            <td>{pct(summary.percent)}</td>
            <td className="weight-cell">
              <CurveSwap
                curved={pct(summary.categories.reduce((sum, c) => sum + c.weight, 0))}
                raw={pct(1 - summary.atStakePercent)}
              />
            </td>
            <td className={tone(summary.impact)}>
              {summary.percent === null ? "—" : signed(summary.impact)}
            </td>
            <td>{pct(prediction.sd)}</td>
            <td>{pct(summary.atStakePercent)}</td>
            <td className="proj proj-start">{range(prediction.expected)}</td>
            <td className="proj">{range(prediction.result)}</td>
            <td className={`proj ${prediction.result && !isZero(prediction.standToGain) ? "good" : ""}`}>
              {prediction.result ? signed(prediction.standToGain) : "—"}
            </td>
            <td className={`proj ${prediction.result && !isZero(prediction.standToLose) ? "bad" : ""}`}>
              {prediction.result ? signed(prediction.standToLose) : "—"}
            </td>
          </tr>
        </tbody>
      </table>
    </ScrollViewport>
    </div>
  );
}

function CategoryTable({
  category,
  summary,
  draggingId,
  defaults,
  onDragStart,
  run,
}: {
  category: GradeCategoryRow;
  summary: CategorySummary;
  draggingId: string | null;
  defaults: GradeDefaults;
  onDragStart: (event: React.PointerEvent, entryId: string, categoryId: string) => void;
  run: (fn: () => Promise<unknown>) => Promise<void>;
}) {
  const storedNameWidth = Number.isFinite(category.nameColumnWidth) ? category.nameColumnWidth : 180;
  const [nameWidth, setNameWidth] = useState(storedNameWidth);
  const sectionRef = useRef<HTMLElement | null>(null);
  const focusAddedEntryRef = useRef(false);
  const resizeRef = useRef<{ pointerId: number; startX: number; startWidth: number; width: number } | null>(null);
  const autofillRef = useRef<AutofillDrag | null>(null);
  const [autofill, setAutofill] = useState<AutofillDrag | null>(null);

  useEffect(() => setNameWidth(storedNameWidth), [storedNameWidth]);

  useLayoutEffect(() => {
    if (!focusAddedEntryRef.current || category.entries.length === 0) return;
    focusAddedEntryRef.current = false;
    sectionRef.current?.querySelector<HTMLInputElement>("tbody tr:last-child td.name-cell input")?.focus();
  }, [category.entries.length]);

  const autofillCommitRef = useRef<(drag: AutofillDrag) => void>(() => {});
  autofillCommitRef.current = (dropped) => {
    if (dropped.overIndex === dropped.sourceIndex) return;

    const first = Math.min(dropped.sourceIndex, dropped.overIndex);
    const last = Math.max(dropped.sourceIndex, dropped.overIndex);
    const updates: { id: string; patch: GradeEntryPatch }[] = [];

    for (let index = first; index <= last; index += 1) {
      const entry = category.entries[index];
      if (!entry) continue;

      switch (dropped.field) {
        case "name": {
          const name = autofillAssignmentName(dropped.value, index - dropped.sourceIndex);
          if (entry.name !== name) updates.push({ id: entry.id, patch: { name } });
          break;
        }
        case "points":
          if (entry.points !== dropped.value) {
            updates.push({ id: entry.id, patch: { points: dropped.value } });
          }
          break;
        case "max":
          if (entry.max !== dropped.value) {
            updates.push({ id: entry.id, patch: { max: dropped.value } });
          }
          break;
        case "status":
          if (entry.status !== dropped.value) {
            updates.push({ id: entry.id, patch: { status: dropped.value } });
          }
          break;
      }
    }

    if (updates.length > 0) void run(() => api.updateGradeEntries(updates));
  };

  useEffect(() => {
    const move = (event: PointerEvent) => {
      const current = autofillRef.current;
      if (!current || event.pointerId !== current.pointerId) return;

      const under = document.elementFromPoint(event.clientX, event.clientY);
      const row = under?.closest<HTMLElement>("tr[data-entry]");
      const body = row?.closest<HTMLElement>("tbody[data-category]");
      if (!row || body?.dataset.category !== category.id) return;

      const index = category.entries.findIndex((entry) => entry.id === row.dataset.entry);
      if (index < 0 || index === current.overIndex) return;

      const next = { ...current, overIndex: index };
      autofillRef.current = next;
      setAutofill(next);
    };

    const finish = (event: PointerEvent, commit: boolean) => {
      const dropped = autofillRef.current;
      if (!dropped || event.pointerId !== dropped.pointerId) return;
      autofillRef.current = null;
      setAutofill(null);
      document.body.classList.remove("autofill-dragging");
      if (commit) autofillCommitRef.current(dropped);
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
      document.body.classList.remove("autofill-dragging");
    };
  }, [category.id, category.entries]);

  const beginAutofill = (
    event: React.PointerEvent<HTMLButtonElement>,
    sourceIndex: number,
    seed: AutofillSeed,
  ) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    const next = {
      ...seed,
      pointerId: event.pointerId,
      sourceIndex,
      overIndex: sourceIndex,
    } as AutofillDrag;
    autofillRef.current = next;
    setAutofill(next);
    document.body.classList.add("autofill-dragging");
  };

  const clampNameWidth = (width: number) => Math.min(420, Math.max(80, Math.round(width)));
  const persistNameWidth = (width: number) => {
    const next = clampNameWidth(width);
    setNameWidth(next);
    if (next !== storedNameWidth) {
      void run(() => api.updateGradeCategory(category.id, { nameColumnWidth: next }));
    }
  };

  const beginNameResize = (event: React.PointerEvent<HTMLSpanElement>) => {
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    resizeRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: nameWidth,
      width: nameWidth,
    };
    document.body.classList.add("resizing-name-column");
  };

  const moveNameResize = (event: React.PointerEvent<HTMLSpanElement>) => {
    const resize = resizeRef.current;
    if (!resize || resize.pointerId !== event.pointerId) return;
    resize.width = clampNameWidth(resize.startWidth + event.clientX - resize.startX);
    setNameWidth(resize.width);
  };

  const finishNameResize = (event: React.PointerEvent<HTMLSpanElement>) => {
    const resize = resizeRef.current;
    if (!resize || resize.pointerId !== event.pointerId) return;
    resizeRef.current = null;
    document.body.classList.remove("resizing-name-column");
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    persistNameWidth(resize.width);
  };

  const nudgeNameWidth = (event: React.KeyboardEvent<HTMLSpanElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const direction = event.key === "ArrowRight" ? 1 : -1;
    persistNameWidth(nameWidth + direction * (event.shiftKey ? 24 : 8));
  };

  const add = async () => {
    focusAddedEntryRef.current = true;
    await run(() =>
      api.addGradeEntry(category.id, {
        name: "",
        max: null,
        points: null,
        status: "PENDING",
        notes: "",
      }),
    );
  };

  return (
    <section ref={sectionRef} className="grade-category">
      <div className="grade-head">
        {/* Plain text, not controls. The name and the weighting are things you
            read far more often than you change, and making them inputs made a
            reference line look like a form. Editing lives behind the gear. */}
        <div className="grade-heading">
          <h4>{category.name}</h4>
          <p className="weight-line">{weightLine(category, summary)}</p>
        </div>
        <button className="ghost icon add-assignment" onClick={() => void add()} aria-label={`Add assignment to ${category.name}`}>
          <PlusIcon />
        </button>
        <CategorySettings category={category} run={run} />
        <CategoryCalculations category={category} defaults={defaults} run={run} />
        <DeleteCategory category={category} run={run} />
      </div>

      {category.entries.length > 0 ? (
        <div
          className="category-table-shell"
          style={{ "--name-column-width": `${nameWidth}px` } as CSSProperties}
        >
        <ScrollViewport className="entry-scroll">
          <table className="rows grades entries">
          <colgroup>
            <col className="col-grip" />
            <col className="col-name" />
            <col className="col-points" />
            <col className="col-points" />
            <col className="col-status" />
            <col className="col-figure" />
            <col className="col-figure" />
            <col className="col-figure" />
            <col className="col-notes" />
            <col className="col-actions" />
          </colgroup>
          <thead>
            <tr>
              <th className="sticky-col sticky-grip" />
              <th className="sticky-col sticky-name">
                Name
                <span
                  className="name-column-resizer"
                  role="separator"
                  aria-label={`Resize the Name column for ${category.name}`}
                  aria-orientation="vertical"
                  aria-valuemin={80}
                  aria-valuemax={420}
                  aria-valuenow={nameWidth}
                  tabIndex={0}
                  title="Drag to resize the Name column"
                  onPointerDown={beginNameResize}
                  onPointerMove={moveNameResize}
                  onPointerUp={finishNameResize}
                  onPointerCancel={finishNameResize}
                  onKeyDown={nudgeNameWidth}
                />
              </th>
              <th>Pts</th>
              <th>Max</th>
              <th>Status</th>
              <th>Percent</th>
              <th>Weight</th>
              <th>Impact</th>
              <th>Notes</th>
              <th />
            </tr>
          </thead>
          <tbody data-category={category.id}>
            {category.entries.map((entry, i) => (
              // Keyed by the fields the row holds in LOCAL state -- name,
              // points, max, notes -- because `useState` would otherwise never
              // see a value the server changed underneath it. Status is read
              // straight from props and needs no resync, and including it made
              // every status click remount the row: the delete button restarted
              // its reveal transition from zero and flickered.
              <EntryRow
                key={`${entry.id}:${entry.name}:${entry.points}:${entry.max}:${entry.notes}`}
                entry={entry}
                summary={summary.entries[i]!}
                dragging={draggingId === entry.id}
                onDragStart={(e) => onDragStart(e, entry.id, category.id)}
                rowIndex={i}
                autofill={autofill}
                onAutofillStart={(event, seed) =>
                  beginAutofill(event, i, seed)
                }
                run={run}
              />
            ))}
          </tbody>
          </table>
        </ScrollViewport>
        </div>
      ) : null}

    </section>
  );
}

function EntryRow({
  entry,
  summary,
  dragging,
  onDragStart,
  rowIndex,
  autofill,
  onAutofillStart,
  run,
}: {
  entry: GradeEntryRow;
  summary: EntrySummary;
  dragging: boolean;
  onDragStart: (event: React.PointerEvent) => void;
  rowIndex: number;
  autofill: AutofillDrag | null;
  onAutofillStart: (
    event: React.PointerEvent<HTMLButtonElement>,
    seed: AutofillSeed,
  ) => void;
  run: (fn: () => Promise<unknown>) => Promise<void>;
}) {
  const [name, setName] = useState(entry.name);
  const [points, setPoints] = useState(entry.points === null ? "" : String(entry.points));
  const [max, setMax] = useState(entry.max === null ? "" : String(entry.max));
  const [notes, setNotes] = useState(entry.notes ?? "");

  const save = (body: Parameters<typeof api.updateGradeEntry>[1]) =>
    run(() => api.updateGradeEntry(entry.id, body));

  // Just the status. Nothing is invented to satisfy it -- a row marked
  // `returned` with no score simply stays out of the maths until it has one.
  const cycle = () =>
    save({ status: STATUS_CYCLE[(STATUS_CYCLE.indexOf(entry.status) + 1) % STATUS_CYCLE.length]! });

  const autofillCellClass = (field: AutofillField, base = "") => {
    const active = autofill?.field === field;
    const first = active ? Math.min(autofill.sourceIndex, autofill.overIndex) : -1;
    const last = active ? Math.max(autofill.sourceIndex, autofill.overIndex) : -1;
    const inRange = active && rowIndex >= first && rowIndex <= last;
    const source = active && rowIndex === autofill.sourceIndex;
    return [
      base,
      "autofill-cell",
      inRange ? "autofill-range" : "",
      inRange && rowIndex === first ? "autofill-range-start" : "",
      inRange && rowIndex === last ? "autofill-range-end" : "",
      source ? "autofill-source" : "",
    ]
      .filter(Boolean)
      .join(" ");
  };

  const numberSeed = (value: string, positiveOnly: boolean): number | null | undefined => {
    if (value.trim() === "") return null;
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || (positiveOnly && parsed <= 0)) return undefined;
    return parsed;
  };

  const beginNumberAutofill = (
    event: React.PointerEvent<HTMLButtonElement>,
    field: "points" | "max",
    value: string,
  ) => {
    const parsed = numberSeed(value, field === "max");
    if (parsed === undefined) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    onAutofillStart(event, { field, value: parsed });
  };

  return (
    <tr
      data-entry={entry.id}
      className={`${summary.counted ? "" : "pending"}${dragging ? " dragging" : ""}`}
    >
      <td
        className="sticky-col sticky-grip grip"
        onPointerDown={onDragStart}
        title="Drag to reorder or move category"
        aria-label={`Reorder ${entry.name}`}
      >
        <GripIcon />
      </td>
      <td className={autofillCellClass("name", "sticky-col sticky-name name-cell")}>
        <input
          title={name}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => name !== entry.name && save({ name })}
        />
        <AutofillHandle
          label="Drag to autofill assignment names"
          onPointerDown={(event) => onAutofillStart(event, { field: "name", value: name })}
        />
      </td>
      <td className={autofillCellClass("points", "score-input-cell")}>
        <input
          inputMode="decimal"
          placeholder="—"
          value={points}
          onChange={(e) => setPoints(e.target.value)}
          onBlur={() => {
            const next = points.trim() === "" ? null : Number(points);
            if (next !== entry.points && (next === null || Number.isFinite(next))) {
              void save({ points: next });
            }
          }}
        />
        <AutofillHandle
          label="Drag to autofill PTS values"
          onPointerDown={(event) => beginNumberAutofill(event, "points", points)}
        />
      </td>
      <td className={autofillCellClass("max", "score-input-cell")}>
        <input
          inputMode="decimal"
          placeholder="—"
          value={max}
          onChange={(e) => setMax(e.target.value)}
          onBlur={() => {
            const next = max.trim() === "" ? null : Number(max);
            if (next !== entry.max && (next === null || next > 0)) void save({ max: next });
          }}
        />
        <AutofillHandle
          label="Drag to autofill MAX values"
          onPointerDown={(event) => beginNumberAutofill(event, "max", max)}
        />
      </td>
      <td className={autofillCellClass("status", "status-cell")}>
        <button className={`status ${entry.status.toLowerCase()}`} onClick={cycle}>
          {STATUS_LABEL[entry.status]}
        </button>
        <AutofillHandle
          label="Drag to autofill statuses"
          onPointerDown={(event) =>
            onAutofillStart(event, { field: "status", value: entry.status })
          }
        />
      </td>
      <td>{summary.percent === null ? <NotApplicable /> : pct(summary.percent)}</td>
      <td className={summary.counted ? "weight-cell" : undefined}>
        {summary.counted ? (
          <CurveSwap curved={pct(summary.weight)} raw={pct(summary.finalWeight)} />
        ) : <NotApplicable />}
      </td>
      <td className={summary.counted ? tone(summary.impact) : undefined}>
        {summary.counted ? signed(summary.impact) : <NotApplicable />}
      </td>
      <td>
        <input
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          onBlur={() => notes !== (entry.notes ?? "") && save({ notes })}
        />
      </td>
      <td className="row-actions">
        <button
          className="ghost icon danger reveal"
          onClick={() => run(() => api.deleteGradeEntry(entry.id))}
          aria-label={`Delete ${entry.name}`}
          title={`Delete ${entry.name}`}
        >
          <TrashIcon />
        </button>
      </td>
    </tr>
  );
}

function round(x: number, places = 0): number {
  const factor = 10 ** places;
  return Math.round(x * factor) / factor;
}

/**
 * What the category IS: its name, and how its share of the grade is decided.
 *
 * Always plain grey. These are structural facts about the course, not
 * preferences -- there is no "default" to deviate from, so there is nothing
 * for the button to light up about.
 */
function CategorySettings({
  category,
  run,
}: {
  category: GradeCategoryRow;
  run: (fn: () => Promise<unknown>) => Promise<void>;
}) {
  const [name, setName] = useState(category.name);
  const [weight, setWeight] = useState(
    category.weightMode === "POOLED" ? "" : String(round(category.weight * 100, 2)),
  );
  const [curveAddend, setCurveAddend] = useState(String(category.curveAddend ?? 0));
  const [curveMultiplier, setCurveMultiplier] = useState(String(category.curveMultiplier ?? 100));
  const [curveExpression, setCurveExpression] = useState(category.curveExpression ?? "x");

  const curveDraft = {
    ...category,
    curveAddend: curveAddend.trim() === "" ? Number.NaN : Number(curveAddend),
    curveMultiplier: curveMultiplier.trim() === "" ? Number.NaN : Number(curveMultiplier),
    curveExpression,
  };
  const draftCurveError = curveError(curveDraft);

  const commit = () => {
    const patch: Parameters<typeof api.updateGradeCategory>[1] = {};
    if (name.trim() && name !== category.name) patch.name = name.trim();

    const text = weight.trim();
    const value = Number(text);
    if (text !== "" && Number.isFinite(value) && value >= 0) {
      const fraction = value / 100;
      if (category.weightMode !== "FIXED" || Math.abs(fraction - category.weight) > 1e-9) {
        patch.weight = fraction;
        patch.weightMode = "FIXED";
      }
    }

    const addend = Number(curveAddend);
    if (curveAddend.trim() !== "" && Number.isFinite(addend)) {
      if (addend !== (category.curveAddend ?? 0)) patch.curveAddend = addend;
    } else {
      setCurveAddend(String(category.curveAddend ?? 0));
    }

    const multiplier = Number(curveMultiplier);
    if (curveMultiplier.trim() !== "" && Number.isFinite(multiplier)) {
      if (multiplier !== (category.curveMultiplier ?? 100)) patch.curveMultiplier = multiplier;
    } else {
      setCurveMultiplier(String(category.curveMultiplier ?? 100));
    }

    if (curveExpression !== (category.curveExpression ?? "x")) patch.curveExpression = curveExpression;
    if (Object.keys(patch).length > 0) void run(() => api.updateGradeCategory(category.id, patch));
  };

  const { open, setOpen, hostRef } = usePopover(commit);

  const setMode = (mode: WeightMode) => {
    if (mode === category.weightMode) return;
    // Pooling means "work it out from my points", so the stored number stops
    // meaning anything and is cleared rather than left to reappear later.
    void run(() =>
      api.updateGradeCategory(category.id, { weightMode: mode, weight: mode === "POOLED" ? 0 : category.weight }),
    );
    if (mode === "POOLED") setWeight("");
  };

  const close = () => {
    commit();
    setOpen(false);
  };

  return (
    <span className="popover-host" ref={hostRef}>
      <button
        className={`ghost icon${open ? " open" : ""}`}
        onClick={() => setOpen(!open)}
        aria-label={`Settings for ${category.name}`}
        title="Name, weighting, and curve"
      >
        <GearIcon />
      </button>
      {open ? (
        <GradeModal className="setup-popover" onClose={close} label={`${category.name} settings`}>
          <SettingsIntro
            eyebrow="Category"
            title="Category settings"
            description="Define this group’s weight, assignment split, and optional score curve."
          />

          <label className="field-row">
            <span><b>Name</b><small>Shown in the summary and above this assignment table.</small></span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              onBlur={commit}
              onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
            />
          </label>

          <label className="field-row">
            <span><b>Weighting</b><small>Use a fixed syllabus share or pool the remaining weight by points.</small></span>
            <select value={category.weightMode} onChange={(event) => setMode(event.target.value as WeightMode)}>
              <option value="FIXED">Fixed share</option>
              <option value="POOLED">Pooled by points</option>
            </select>
          </label>

          {category.weightMode === "FIXED" ? (
            <label className="field-row">
              <span><b>Fixed share</b><small>Percentage of the final course grade.</small></span>
              <span className="suffix-input">
                <input
                  inputMode="decimal"
                  value={weight}
                  onChange={(e) => setWeight(e.target.value)}
                  onBlur={commit}
                  onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
                />
                <i>%</i>
              </span>
            </label>
          ) : null}

          <label className="field-row">
            <span><b>Assignment split</b><small>How this category distributes its weight between assignments.</small></span>
            <select
            disabled={category.weightMode === "POOLED"}
            title={
              category.weightMode === "POOLED"
                ? "A pooled category is shared out by points by definition."
                : undefined
            }
              value={byMaxOf(category) ? "points" : "even"}
              onChange={(event) =>
                run(() => api.updateGradeCategory(category.id, { weightByMax: event.target.value === "points" }))
              }
            >
              <option value="points">By point value</option>
              <option value="even">Evenly</option>
            </select>
          </label>

          <section className={`settings-group curve-settings-group${category.curveEnabled ? " enabled" : ""}`}>
            <div className="settings-group-heading">
              <b>Category curve</b>
              <small>Transform this category’s final percentage without changing its assignment rows.</small>
            </div>

            <label className="toggle-row">
              <input
                type="checkbox"
                checked={category.curveEnabled}
                onChange={(event) =>
                  run(() => api.updateGradeCategory(category.id, { curveEnabled: event.target.checked }))
                }
              />
              <span>
                <b>Apply a curve</b>
                <small>Use the transformed score in the course total and projections.</small>
              </span>
            </label>

            {category.curveEnabled ? (
              <>
                <label className="field-row">
                  <span><b>Curve type</b><small>Choose how the raw percentage is transformed.</small></span>
                  <select
                    value={category.curveMode}
                    onChange={(event) =>
                      run(() => api.updateGradeCategory(category.id, { curveMode: event.target.value as CurveMode }))
                    }
                  >
                    <option value="ADDITIVE">Additive</option>
                    <option value="MULTIPLICATIVE">Multiplicative</option>
                    <option value="CUSTOM">Custom formula</option>
                  </select>
                </label>

                {category.curveMode === "ADDITIVE" ? (
                  <label className="field-row">
                    <span><b>Add</b><small>Percentage points added to the raw score.</small></span>
                    <span className="suffix-input">
                      <input
                        inputMode="decimal"
                        value={curveAddend}
                        onChange={(event) => setCurveAddend(event.target.value)}
                        onBlur={commit}
                        onKeyDown={(event) => event.key === "Enter" && (event.target as HTMLInputElement).blur()}
                      />
                      <i>pts</i>
                    </span>
                  </label>
                ) : null}

                {category.curveMode === "MULTIPLICATIVE" ? (
                  <label className="field-row">
                    <span><b>Multiply by</b><small>100% keeps the raw score; 110% multiplies it by 1.10.</small></span>
                    <span className="suffix-input">
                      <input
                        inputMode="decimal"
                        value={curveMultiplier}
                        onChange={(event) => setCurveMultiplier(event.target.value)}
                        onBlur={commit}
                        onKeyDown={(event) => event.key === "Enter" && (event.target as HTMLInputElement).blur()}
                      />
                      <i>%</i>
                    </span>
                  </label>
                ) : null}

                {category.curveMode === "CUSTOM" ? (
                  <label className="field-row curve-formula-row">
                    <span>
                      <b>Formula</b>
                      <small>Use x for the raw 0–100 score. Supports +, −, ×, ÷, ^, sqrt, min, and max.</small>
                    </span>
                    <input
                      className="curve-expression-input"
                      value={curveExpression}
                      placeholder="e.g. max(x + 5, sqrt(x / 100) * 100)"
                      spellCheck={false}
                      onChange={(event) => setCurveExpression(event.target.value)}
                      onBlur={commit}
                      onKeyDown={(event) => event.key === "Enter" && (event.target as HTMLInputElement).blur()}
                    />
                  </label>
                ) : null}

                <label className="toggle-row">
                  <input
                    type="checkbox"
                    checked={category.curveCap}
                    onChange={(event) =>
                      run(() => api.updateGradeCategory(category.id, { curveCap: event.target.checked }))
                    }
                  />
                  <span>
                    <b>Cap at 100%</b>
                    <small>Keep curved scores from exceeding 100%.</small>
                  </span>
                </label>

                {draftCurveError ? <p className="curve-formula-error">{draftCurveError}</p> : null}
              </>
            ) : null}
          </section>

          <div className="dialog-footer">
            <span>Changes are saved automatically.</span>
            <button className="primary-button" onClick={close}>Done</button>
          </div>
        </GradeModal>
      ) : null}
    </span>
  );
}

/**
 * How this category's forecast is worked out.
 *
 * Lights up only when it DIFFERS from the course defaults -- a category that
 * follows them has nothing worth flagging, and a badge for it would send you
 * hunting for a setting that changes nothing.
 */
function CategoryCalculations({
  category,
  defaults,
  run,
}: {
  category: GradeCategoryRow;
  defaults: GradeDefaults;
  run: (fn: () => Promise<unknown>) => Promise<void>;
}) {
  const [level, setLevel] = useState(
    category.alphaOverride === null ? "" : String(round((1 - category.alphaOverride) * 100, 2)),
  );

  const commit = () => {
    const text = level.trim();
    if (text === "") {
      if (category.alphaOverride !== null) {
        void run(() => api.updateGradeCategory(category.id, { alphaOverride: null }));
      }
      return;
    }
    const value = Number(text);
    if (!Number.isFinite(value) || value <= 0 || value >= 100) {
      setLevel(category.alphaOverride === null ? "" : String(round((1 - category.alphaOverride) * 100, 2)));
      return;
    }
    const alpha = 1 - value / 100;
    if (category.alphaOverride !== null && Math.abs(alpha - category.alphaOverride) < 1e-9) return;
    void run(() => api.updateGradeCategory(category.id, { alphaOverride: alpha }));
  };

  const { open, setOpen, hostRef } = usePopover(commit);
  const basis = category.forecastBasis ?? defaults.gradeBasis;
  const estimates = category.includeEstimates ?? defaults.gradeIncludeEstimates;
  const cap = category.capForecast ?? defaults.gradeCapForecast;
  const overridden =
    category.alphaOverride !== null ||
    basis !== defaults.gradeBasis ||
    estimates !== defaults.gradeIncludeEstimates ||
    cap !== defaults.gradeCapForecast;
  const close = () => {
    commit();
    setOpen(false);
  };

  return (
    <span className="popover-host" ref={hostRef}>
      <button
        className={`ghost icon${overridden ? " on" : ""}${open ? " open" : ""}`}
        onClick={() => setOpen(!open)}
        aria-label={`Forecast calculations for ${category.name}`}
        title={
          overridden
            ? "Forecast calculations — this category differs from the course defaults"
            : "Forecast calculations"
        }
      >
        <CalculatorIcon />
        {overridden ? <i className="dot" /> : null}
      </button>
      {open ? (
        <GradeModal className="forecast-popover" onClose={close} label={`${category.name} prediction settings`}>
          <SettingsIntro
            eyebrow="Category forecast"
            title={`${category.name} predictions`}
            description="Fine-tune this category without changing the rest of the course."
          />

          <label className="field-row">
            <span><b>Confidence interval</b><small>Blank follows the course default of {Math.round((1 - defaults.gradeAlpha) * 100)}%.</small></span>
            <span className="suffix-input">
              <input
                inputMode="decimal"
                placeholder={String(Math.round((1 - defaults.gradeAlpha) * 100))}
                value={level}
                onChange={(e) => setLevel(e.target.value)}
                onBlur={commit}
                onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
              />
              <i>%</i>
            </span>
          </label>

          <BasisChoice
            name={`basis-${category.id}`}
            value={basis}
            onChange={(next) => run(() => api.updateGradeCategory(category.id, { forecastBasis: next }))}
          />

          <EstimateChoice
            checked={estimates}
            onChange={(next) => run(() => api.updateGradeCategory(category.id, { includeEstimates: next }))}
          />

          <CapChoice
            checked={!cap}
            onChange={(next) => run(() => api.updateGradeCategory(category.id, { capForecast: !next }))}
          />

          {overridden ? (
            <button
              className="ghost link reset"
              onClick={() => {
                setLevel("");
                void run(() =>
                  api.updateGradeCategory(category.id, {
                    alphaOverride: null,
                    forecastBasis: null,
                    includeEstimates: null,
                    capForecast: null,
                  }),
                );
              }}
            >
              ↺ Follow the course defaults
            </button>
          ) : null}

          <div className="dialog-footer">
            <span>Changes are saved automatically.</span>
            <button className="primary-button" onClick={close}>Done</button>
          </div>
        </GradeModal>
      ) : null}
    </span>
  );
}

/**
 * What each status does to the arithmetic.
 *
 * The four states are not self-explanatory -- "estimated" counting toward the
 * grade but not the forecast is a real rule that nothing on screen conveys --
 * and the difference between them is the single thing most likely to make the
 * numbers look wrong. Collapsed by default: needed once, not every visit.
 */
function StatusGuide() {
  const [open, setOpen] = useState(false);

  const rows: [GradeStatus, string][] = [
    ["RETURNED", "A known mark. Counts toward your grade, and toward the forecast."],
    [
      "ESTIMATED",
      "Your own guess. Counts toward your grade. By default it is kept out of the forecast so a guess cannot narrow it — the calculator button turns that back on, per category or for the whole course.",
    ],
    ["PENDING", "Assigned, not yet marked. Counts only toward what is at stake."],
    ["POSSIBLE", "A hypothetical. Counts toward nothing at all."],
  ];

  return (
    <div className="status-guide">
      <button className="ghost link" onClick={() => setOpen(!open)} aria-expanded={open}>
        {open ? "▾" : "▸"} How the statuses count
      </button>
      {open ? (
        <dl>
          {rows.map(([status, meaning]) => (
            <div key={status}>
              <dt>
                <span className={`status ${status.toLowerCase()}`}>{STATUS_LABEL[status]}</span>
              </dt>
              <dd>{meaning}</dd>
            </div>
          ))}
          <div>
            <dt className="plain">no max</dt>
            <dd>
              A row with no points possible is ignored everywhere, whatever its status says —
              there is nothing to divide by yet.
            </dd>
          </div>
        </dl>
      ) : null}
    </div>
  );
}

/**
 * Deleting a category, with a step in between.
 *
 * A category takes every assignment under it, and there is no undo. One
 * mis-aimed click on a row of three icons should not be able to erase a
 * term's worth of marks, so the trash opens a question rather than a hole.
 * Individual assignments stay one click -- they are cheap to retype, and
 * confirming each one would make ordinary tidying unbearable.
 */
function DeleteCategory({
  category,
  run,
}: {
  category: GradeCategoryRow;
  run: (fn: () => Promise<unknown>) => Promise<void>;
}) {
  const { open, setOpen, hostRef } = usePopover();
  const count = category.entries.length;

  return (
    <span className="popover-host" ref={hostRef}>
      <button
        className={`ghost icon danger${open ? " open" : ""}`}
        onClick={() => setOpen(!open)}
        aria-label={`Delete the ${category.name} category`}
        title={`Delete the ${category.name} category`}
      >
        <TrashIcon />
      </button>
      {open ? (
        <GradeModal className="confirm" onClose={() => setOpen(false)}>
          <p>
            Delete <b>{category.name}</b>
            {count > 0 ? ` and its ${count} assignment${count === 1 ? "" : "s"}` : ""}?
          </p>
          <p className="note">This cannot be undone.</p>
          <div className="confirm-actions">
            <button className="ghost tiny" onClick={() => setOpen(false)}>
              Cancel
            </button>
            <button
              className="ghost tiny danger"
              onClick={() => {
                setOpen(false);
                void run(() => api.deleteGradeCategory(category.id));
              }}
            >
              Delete
            </button>
          </div>
        </GradeModal>
      ) : null}
    </span>
  );
}

/** A tidy filename: "cme-106-gradebook-2026-08-27.json". */
function fileNameFor(courseName: string): string {
  const slug = courseName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return `${slug || "course"}-gradebook-${new Date().toISOString().slice(0, 10)}.json`;
}

/**
 * The gradebook as a file, in and out.
 *
 * Export is entirely local -- the page already holds every row, so there is no
 * request to make. Import goes through the server, which re-parses rather than
 * trusting what the browser says it validated.
 *
 * Importing REPLACES, so it asks first and says exactly what it is about to
 * trade: a file that turns out to hold two categories when you have twelve is
 * something you want to notice before it lands, not after.
 */
function Transfer({
  itemId,
  name,
  categories,
  defaults,
  run,
  panel = false,
}: {
  itemId: string;
  name: string;
  categories: GradeCategoryRow[];
  defaults: GradeDefaults;
  run: (fn: () => Promise<unknown>) => Promise<void>;
  panel?: boolean;
}) {
  const picker = useRef<HTMLInputElement | null>(null);
  const [staged, setStaged] = useState<{ text: string; categories: number; entries: number } | null>(
    null,
  );
  const [error, setError] = useState("");
  const { open, setOpen, hostRef } = usePopover();

  const exportFile = () => {
    const text = serializeGradebook({
      questlogGradebook: GRADEBOOK_FORMAT,
      exportedAt: new Date().toISOString(),
      course: { name, emoji: "" },
      // Applied on import, and safe to apply because they belong to this course
      // rather than the account -- restoring one gradebook cannot re-tune any
      // other. A snapshot that leaves you looking at different numbers is not a
      // snapshot.
      settings: {
        currentWeighting: defaults.gradeCurrentWeighting,
        alpha: defaults.gradeAlpha,
        basis: defaults.gradeBasis,
        estimateWeight: defaults.gradeIncludeEstimates ? 1 : 0,
        capForecast: defaults.gradeCapForecast,
      },
      categories: categories.map((c) => ({
        name: c.name,
        nameColumnWidth: c.nameColumnWidth,
        weightMode: c.weightMode,
        weight: c.weight,
        weightByMax: c.weightByMax,
        alphaOverride: c.alphaOverride,
        forecastBasis: c.forecastBasis,
        estimateWeight: c.includeEstimates === null ? null : c.includeEstimates ? 1 : 0,
        capForecast: c.capForecast,
        curveEnabled: c.curveEnabled,
        curveMode: c.curveMode,
        curveAddend: c.curveAddend,
        curveMultiplier: c.curveMultiplier,
        curveExpression: c.curveExpression,
        curveCap: c.curveCap,
        entries: c.entries.map((e) => ({
          name: e.name,
          points: e.points,
          max: e.max,
          status: e.status,
          notes: e.notes,
        })),
      })),
    });

    const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = fileNameFor(name);
    link.click();
    URL.revokeObjectURL(url);
  };

  const stage = async (file: File) => {
    const text = await file.text();
    const parsed = parseGradebook(text);
    if (!parsed.ok) {
      setStaged(null);
      setError(parsed.error);
      setOpen(true);
      return;
    }
    setError("");
    setStaged({
      text,
      categories: parsed.value.categories.length,
      entries: parsed.value.categories.reduce((total, c) => total + c.entries.length, 0),
    });
    setOpen(true);
  };

  const here = {
    categories: categories.length,
    entries: categories.reduce((total, c) => total + c.entries.length, 0),
  };

  return (
    <span className={`popover-host transfer${panel ? " panel-transfer" : ""}`} ref={hostRef}>
      <input
        ref={picker}
        type="file"
        accept="application/json,.json"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          // Cleared so choosing the same file twice still fires a change.
          e.target.value = "";
          if (file) void stage(file);
        }}
      />
      <button className="ghost tiny" onClick={exportFile} disabled={categories.length === 0}>
        <ExportIcon /><span>Export gradebook</span>
      </button>
      <button className="ghost tiny" onClick={() => picker.current?.click()}>
        <ImportIcon /><span>Import gradebook</span>
      </button>

      {open ? (
        <GradeModal className="confirm" onClose={() => setOpen(false)}>
          {error ? (
            <>
              <p>That file could not be read, so nothing has changed.</p>
              <p className="note">{error}</p>
              <div className="confirm-actions">
                <button className="ghost tiny" onClick={() => setOpen(false)}>
                  Close
                </button>
              </div>
            </>
          ) : staged ? (
            <>
              <p>
                Replace this gradebook with the file?
              </p>
              <p className="note">
                Out: {here.categories} categor{here.categories === 1 ? "y" : "ies"},{" "}
                {here.entries} assignment{here.entries === 1 ? "" : "s"}.
                <br />
                In: {staged.categories} categor{staged.categories === 1 ? "y" : "ies"},{" "}
                {staged.entries} assignment{staged.entries === 1 ? "" : "s"}.
                <br />
                {"Its forecast settings replace this course's too."}
                <br />
                This cannot be undone — export first if you want a way back.
              </p>
              <div className="confirm-actions">
                <button className="ghost tiny" onClick={() => setOpen(false)}>
                  Cancel
                </button>
                <button
                  className="ghost tiny danger"
                  onClick={() => {
                    setOpen(false);
                    void run(() => api.importGradebook(itemId, staged.text));
                  }}
                >
                  Replace
                </button>
              </div>
            </>
          ) : null}
        </GradeModal>
      ) : null}
    </span>
  );
}
