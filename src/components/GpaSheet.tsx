import { useLayoutEffect, useState, type ReactNode } from "react";
import { calculateGpa, gpaCourseResult, GPA_EXCLUDED, GPA_POINTS, GPA_SOURCE, type GpaCourse, type GpaGrade, type GpaTerm } from "../gpa";
import { store } from "../store";
import { useHistoryRevision } from "../history-ui";
import { DuplicateIcon, GearIcon, GradeModal, PlusIcon, ScrollViewport, TrashIcon } from "./GradeSheet";

const displayGpa = (value: number | null) => value === null ? "N/A" : value.toFixed(2);
const number = (value: number) => Number(value.toFixed(2)).toString();
type Run = (action: () => Promise<unknown>) => Promise<void>;

export function GpaSheet({ terms, switcher, historyControls, onChanged, courseNames }: {
  terms: GpaTerm[];
  switcher: ReactNode;
  historyControls: ReactNode;
  onChanged: () => void;
  courseNames: string[];
}) {
  const [newTerm, setNewTerm] = useState("");
  const [error, setError] = useState("");
  const total = calculateGpa(terms.flatMap((term) => term.courses));
  const run: Run = async (action) => {
    try { await action(); onChanged(); setError(""); }
    catch (cause) { setError((cause as Error).message); }
  };
  return (
    <div className="gpa-sheet">
      <header className="course-head">
        <div className="course-identity">
          {switcher}
          <div className="course-copy">
            <h1 className="course-title">GPA Calculator</h1>
            <p className="course-subtitle">Stanford • Unit-weighted • 4.3 scale</p>
          </div>
        </div>
        <div className="head-actions course-toolbar">{historyControls}</div>
      </header>

      <section className="grade-overview">
        <div className="forecast-highlights">
          <div className="forecast-card"><span>Cumulative GPA</span><strong>{displayGpa(total.gpa)}</strong><small>Across all included terms</small></div>
          <div className="forecast-card"><span>GPA units</span><strong>{number(total.units)}</strong><small>{total.countedCourses} courses counted</small></div>
          <div className="forecast-card"><span>Grade points</span><strong>{number(total.qualityPoints)}</strong><small>Grade value × applicable units</small></div>
        </div>
        {terms.length ? (
          <div className="category-table-shell gpa-summary-shell">
            <ScrollViewport className="gpa-summary-scroll">
              <table className="rows gpa-table gpa-summary" aria-label="GPA by term">
                <thead><tr><th scope="col">Term</th><th scope="col">GPA</th><th scope="col">GPA units</th><th scope="col">Grade points</th></tr></thead>
                <tbody>
                  {terms.map((term) => {
                    const result = calculateGpa(term.courses);
                    return <tr key={term.id}><th scope="row">{term.name}</th><td className={result.gpa === null ? "gpa-na" : ""}>{displayGpa(result.gpa)}</td><td>{number(result.units)}</td><td>{number(result.qualityPoints)}</td></tr>;
                  })}
                  <tr className="total"><th scope="row">Total</th><td>{displayGpa(total.gpa)}</td><td>{number(total.units)}</td><td>{number(total.qualityPoints)}</td></tr>
                </tbody>
              </table>
            </ScrollViewport>
          </div>
        ) : <p className="grade-empty-copy muted">Add a term below, then enter each course’s transcript grade and applicable units.</p>}
        <details className="gpa-rules">
          <summary>How Stanford GPA is calculated</summary>
          <p>GPA = total (grade value × units) ÷ GPA units. A+ is 4.3; NP is 0.0 and still counts its units. L temporarily counts as 2.0 (Autumn 2014–15 onward).</p>
          <p>CR, S, NC, W, I, GNR, RP, N, N−, G, +, and * are excluded from both sums. Blank grades or units do not count yet. Use RP for an original enrollment replaced on your transcript; repeated course names are not automatically excluded.</p>
          <p>The separately labeled GSB grades use Stanford’s conversions for undergraduate/graduate students, not MBA or MSx students. This calculator does not model Law or Medicine’s separate grading systems.</p>
          <a href={GPA_SOURCE} target="_blank" rel="noreferrer">Stanford’s GPA rules ↗</a>
        </details>
      </section>

      <datalist id="gpa-course-names">{[...new Set(courseNames)].map((name) => <option key={name} value={name} />)}</datalist>
      {terms.map((term) => <TermTable key={term.id} term={term} run={run} />)}
      <form className="gpa-add-term" onSubmit={(event) => {
        event.preventDefault();
        if (!newTerm.trim()) return;
        void run(async () => { await store.addGpaTerm(newTerm); setNewTerm(""); });
      }}>
        <input aria-label="New term name" placeholder="Term name, e.g. Autumn 2026" value={newTerm} onChange={(event) => setNewTerm(event.target.value)} />
        <button className="ghost tiny" disabled={!newTerm.trim()}>+ Add term</button>
      </form>
      {error ? <p className="err" role="alert">{error}</p> : null}
    </div>
  );
}

function TermTable({ term, run }: { term: GpaTerm; run: Run }) {
  const [panel, setPanel] = useState<"settings" | "delete" | null>(null);
  const [name, setName] = useState(term.name);
  const revision = useHistoryRevision();
  useLayoutEffect(() => setName(term.name), [term.name, revision]);
  const result = calculateGpa(term.courses);
  const saveName = () => {
    if (!name.trim()) { setName(term.name); return; }
    if (name.trim() !== term.name) void run(() => store.renameGpaTerm(term.id, name));
  };
  return (
    <section className="grade-category gpa-term">
      <div className="grade-head">
        <div className="grade-heading"><h4>{term.name}</h4><p className="weight-line">GPA: {displayGpa(result.gpa)} • {number(result.units)} GPA units</p></div>
        <button className="ghost icon add-assignment" aria-label={`Add course to ${term.name}`} onClick={() => void run(() => store.addGpaCourse(term.id))}><PlusIcon /></button>
        <span className="popover-host"><button className={`ghost icon${panel === "settings" ? " open" : ""}`} aria-label={`Settings for ${term.name}`} onClick={() => setPanel("settings")}><GearIcon /></button></span>
        <span className="popover-host"><button className="ghost icon danger" aria-label={`Delete term ${term.name}`} onClick={() => setPanel("delete")}><TrashIcon /></button></span>
      </div>
      {term.courses.length ? (
        <div className="category-table-shell">
          <ScrollViewport className="gpa-course-scroll">
            <table className="rows gpa-table gpa-courses" aria-label={`Courses in ${term.name}`}>
              <colgroup><col className="gpa-name" /><col className="gpa-grade" /><col className="gpa-units" /><col className="gpa-value" /><col className="gpa-quality" /><col className="gpa-actions" /></colgroup>
              <thead><tr><th scope="col">Course</th><th scope="col">Grade</th><th scope="col">Units</th><th scope="col">Grade value</th><th scope="col">Grade points</th><th scope="col">Actions</th></tr></thead>
              <tbody>{term.courses.map((course, index) => <CourseRow key={course.id} course={course} rowLabel={`${term.name} course ${index + 1}`} run={run} />)}</tbody>
            </table>
          </ScrollViewport>
        </div>
      ) : <p className="muted grade-empty-copy">No courses yet. Use + to add one.</p>}
      {panel === "settings" ? (
        <GradeModal label={`${term.name} settings`} onClose={() => { saveName(); setPanel(null); }}>
          <div className="dialog-head"><div><p className="eyebrow">Term</p><h2>Term settings</h2></div></div>
          <label className="field-row"><span><b>Name</b><small>Quarter, semester, or other academic term.</small></span><input aria-label="Term name" value={name} onChange={(event) => setName(event.target.value)} onBlur={saveName} onKeyDown={(event) => event.key === "Enter" && event.currentTarget.blur()} /></label>
          <div className="dialog-footer"><span>Saved automatically on this device.</span><button className="primary-button" onClick={() => { saveName(); setPanel(null); }}>Done</button></div>
        </GradeModal>
      ) : panel === "delete" ? (
        <GradeModal className="confirm" label={`Delete ${term.name}`} onClose={() => setPanel(null)}>
          <p>Delete <b>{term.name}</b> and its {term.courses.length} courses?</p>
          <p className="note">You can undo this during the current session. Undo history resets when you reload.</p>
          <div className="confirm-actions"><button className="ghost tiny" onClick={() => setPanel(null)}>Cancel</button><button className="ghost tiny danger" onClick={() => void run(() => store.deleteGpaTerm(term.id))}>Delete term</button></div>
        </GradeModal>
      ) : null}
    </section>
  );
}

function CourseRow({ course, rowLabel, run }: { course: GpaCourse; rowLabel: string; run: Run }) {
  const [name, setName] = useState(course.name);
  const [units, setUnits] = useState(course.units === null ? "" : String(course.units));
  const [invalidUnits, setInvalidUnits] = useState(false);
  const revision = useHistoryRevision();
  useLayoutEffect(() => {
    setName(course.name); setUnits(course.units === null ? "" : String(course.units)); setInvalidUnits(false);
  }, [course.name, course.units, revision]);
  const result = gpaCourseResult(course);
  const commitUnits = () => {
    const value = units.trim() ? Number(units) : null;
    if (value !== null && (!Number.isFinite(value) || value <= 0)) { setInvalidUnits(true); return; }
    setInvalidUnits(false);
    if (value !== course.units) void run(() => store.updateGpaCourse(course.id, { units: value }));
  };
  return (
    <tr className={result.counted ? "" : "gpa-uncounted"}>
      <td><input list="gpa-course-names" aria-label={`${rowLabel} name`} placeholder="—" value={name} onChange={(event) => setName(event.target.value)} onBlur={() => name !== course.name && void run(() => store.updateGpaCourse(course.id, { name }))} onKeyDown={(event) => event.key === "Enter" && event.currentTarget.blur()} /></td>
      <td><select aria-label={`${rowLabel} grade`} value={course.grade} onChange={(event) => void run(() => store.updateGpaCourse(course.id, { grade: event.target.value as GpaGrade }))}>
        <option value="">—</option>
        <optgroup label="Stanford letter grades">{Object.entries(GPA_POINTS).filter(([grade]) => !grade.startsWith("GSB:")).map(([grade, points]) => <option key={grade} value={grade}>{grade}{grade === "L" ? " (temporary)" : ""} · {points.toFixed(1)}</option>)}</optgroup>
        <optgroup label="Excluded from GPA">{GPA_EXCLUDED.map((grade) => <option key={grade} value={grade}>{grade}</option>)}</optgroup>
        <optgroup label="GSB (not MBA / MSx)">{Object.entries(GPA_POINTS).filter(([grade]) => grade.startsWith("GSB:")).map(([grade, points]) => <option key={grade} value={grade}>GSB {grade.slice(4)} · {points.toFixed(2)}</option>)}</optgroup>
      </select></td>
      <td><input aria-label={`${rowLabel} units`} inputMode="decimal" placeholder="—" value={units} aria-invalid={invalidUnits} title={invalidUnits ? "Enter a positive number of units or leave blank." : "Applicable course units"} onChange={(event) => { setUnits(event.target.value); setInvalidUnits(false); }} onBlur={commitUnits} onKeyDown={(event) => event.key === "Enter" && event.currentTarget.blur()} /></td>
      <td className={result.points === null ? "gpa-na" : ""}>{result.points === null ? "N/A" : result.points.toFixed(2)}</td>
      <td className={!result.counted ? "gpa-na" : ""} title={!result.counted ? "Excluded until a GPA grade and positive units are entered." : "Grade value × units"}>{result.counted ? number(result.qualityPoints) : "N/A"}</td>
      <td className="gpa-row-actions">
        <button className="ghost icon" aria-label={`Duplicate ${rowLabel}`} title="Duplicate course" onClick={() => void run(() => store.duplicateGpaCourse(course.id))}><DuplicateIcon /></button>
        <button className="ghost icon danger" aria-label={`Delete ${rowLabel}`} title="Delete course" onClick={() => void run(() => store.deleteGpaCourse(course.id))}><TrashIcon /></button>
      </td>
    </tr>
  );
}
