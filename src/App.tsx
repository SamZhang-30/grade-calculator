import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  DEFAULT_GRADE_CONFIG,
  summarize,
  type CurrentGradeWeighting,
  type ForecastBasis,
} from "./grade-engine";
import { GradeSheet, resolveDefaults } from "./components/GradeSheet";
import { loadData, store, type AppData, type AppSettings, type Course } from "./store";
import { formatUnits } from "./units";

const PALETTE = [
  "#8b7cf6",
  "#5d9cec",
  "#48b6a6",
  "#75b76b",
  "#d2a94c",
  "#df8658",
  "#d76f8f",
  "#a879d2",
];

const ACTIVE_COURSE_KEY = "gradebook.active-course.v1";

function initialCourseId(): string {
  const data = loadData();
  try {
    const saved = window.localStorage.getItem(ACTIVE_COURSE_KEY);
    if (saved && data.courses.some((course) => course.id === saved)) return saved;
  } catch {
    // Storage can be disabled; selecting the first course remains functional.
  }
  return data.courses[0]?.id ?? "";
}

const BASIS_LABEL: Record<ForecastBasis, string> = {
  COURSE: "Whole course",
  COURSE_WHEN_SPARSE: "Course until category has marks",
  CATEGORY: "Each category only",
};

function SettingsIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="M3.5 5h7M14.5 5h2M3.5 10h2M9.5 10h7M3.5 15h8M15.5 15h1" />
      <circle cx="12.5" cy="5" r="1.5" />
      <circle cx="7.5" cy="10" r="1.5" />
      <circle cx="13.5" cy="15" r="1.5" />
    </svg>
  );
}

function currentGrade(course: Course, app: AppSettings): string {
  const defaults = resolveDefaults(course, app);
  const categories = course.categories.map((category) => ({
    ...category,
    estimateWeight:
      category.includeEstimates === null ? null : category.includeEstimates ? 1 : 0,
    capForecast: category.capForecast,
  }));
  const summary = summarize(categories, {
    ...DEFAULT_GRADE_CONFIG,
    alpha: defaults.gradeAlpha,
    defaultBasis: defaults.gradeBasis,
    estimateWeight: defaults.gradeIncludeEstimates ? 1 : 0,
    capForecastAtFull: defaults.gradeCapForecast,
    currentGradeWeighting: defaults.gradeCurrentWeighting,
  });
  return summary.percent === null ? "—" : `${Math.round(summary.percent * 100)}%`;
}

function CourseAppearanceFields({ course, onChanged }: { course: Course; onChanged: () => void }) {
  const [emoji, setEmoji] = useState(course.emoji);
  const [color, setColor] = useState(course.color);

  useEffect(() => {
    setEmoji(course.emoji);
    setColor(course.color);
  }, [course.id, course.emoji, course.color]);

  const update = async (patch: Partial<Pick<Course, "color" | "emoji">>) => {
    await store.updateCourse(course.id, patch);
    onChanged();
  };

  const commitEmoji = () => {
    const next = emoji.trim() || "📚";
    setEmoji(next);
    if (next !== course.emoji) void update({ emoji: next });
  };

  const commitColor = () => {
    const next = color.trim();
    if (!/^#[0-9a-f]{6}$/i.test(next)) {
      setColor(course.color);
      return;
    }
    if (next.toLowerCase() !== course.color.toLowerCase()) void update({ color: next });
  };

  return (
    <div className="appearance-fields course-detail-fields">
      <label className="field-row">
        <span><b>Emoji</b><small>Use one symbol to identify this course.</small></span>
        <input
          className="emoji-input"
          value={emoji}
          maxLength={8}
          onChange={(event) => setEmoji(event.target.value)}
          onBlur={commitEmoji}
          onKeyDown={(event) => event.key === "Enter" && event.currentTarget.blur()}
          aria-label="Course emoji"
        />
      </label>
      <label className="field-row">
        <span><b>Accent color</b><small>Used for highlights, borders, and the course header.</small></span>
        <div className="custom-color-combo">
          <input
            type="color"
            value={/^#[0-9a-f]{6}$/i.test(color) ? color : course.color}
            onChange={(event) => {
              setColor(event.target.value);
              void update({ color: event.target.value });
            }}
            aria-label="Course accent color"
          />
          <input
            value={color.toUpperCase()}
            onChange={(event) => setColor(event.target.value)}
            onBlur={commitColor}
            onKeyDown={(event) => event.key === "Enter" && event.currentTarget.blur()}
            aria-label="Course accent hex value"
          />
        </div>
      </label>
    </div>
  );
}

function CourseIdentity({ course, switcher }: { course: Course; switcher: ReactNode }) {
  const units = formatUnits(course.units);
  const subtitle = [course.term, course.instructor, units].filter(Boolean).join(" • ");
  return (
    <div className="course-identity">
      {switcher}
      <div className="course-identity-copy">
        <h1 className="course-title" title={course.name}>{course.name}</h1>
        <p
          className={`course-subtitle${subtitle ? "" : " empty"}`}
          title={subtitle || "Add course details in settings"}
        >
          {subtitle || "Add course details in settings"}
        </p>
      </div>
    </div>
  );
}

function CourseSwitcher({
  active, courses, grades, onSelect, onAdd, onSettings,
}: {
  active: Course;
  courses: Course[];
  grades: Map<string, string>;
  onSelect: (id: string) => void;
  onAdd: () => void;
  onSettings: () => void;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const close = () => {
    setOpen(false);
    trigger.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    const positionMenu = () => {
      const rect = trigger.current?.getBoundingClientRect();
      if (rect) setPosition({
        top: Math.max(12, Math.min(rect.bottom + 8, window.innerHeight - 220)),
        left: Math.max(12, Math.min(rect.left, window.innerWidth - Math.min(360, window.innerWidth - 24) - 12)),
      });
    };
    positionMenu();
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        trigger.current?.focus();
      }
    };
    window.addEventListener("resize", positionMenu);
    window.addEventListener("keydown", escape);
    return () => {
      window.removeEventListener("resize", positionMenu);
      window.removeEventListener("keydown", escape);
    };
  }, [open]);

  return (
    <>
      <button
        ref={trigger}
        className="course-emoji-trigger"
        style={{ "--course-color": active.color } as CSSProperties}
        onClick={() => setOpen(!open)}
        aria-label="Switch classes"
        aria-expanded={open}
        aria-haspopup="dialog"
      >{active.emoji}</button>
      {open ? createPortal(
        <div className="class-switcher-backdrop" onMouseDown={(event) => event.target === event.currentTarget && close()}>
          <section className="class-switcher" style={position} role="dialog" aria-label="Switch classes">
            <div className="class-switcher-heading">
              <b>Classes</b>
              <button className="icon-button" aria-label="Close class switcher" onClick={close}>×</button>
            </div>
            <nav className="course-list" aria-label="Classes">
              {courses.map((course) => (
                <button
                  key={course.id}
                  autoFocus={course.id === active.id}
                  className={course.id === active.id ? "active" : ""}
                  style={{ "--course-color": course.color } as CSSProperties}
                  aria-current={course.id === active.id ? "page" : undefined}
                  title={course.name}
                  onClick={() => { onSelect(course.id); close(); }}
                >
                  <i className="course-emoji">{course.emoji}</i>
                  <span>{course.name}</span>
                  <b>{grades.get(course.id)}</b>
                </button>
              ))}
            </nav>
            <button className="add-course" onClick={() => { close(); onAdd(); }}>+ Add a class</button>
            <button className="class-switcher-settings" onClick={() => { close(); onSettings(); }}>
              <SettingsIcon /> Global grade settings
            </button>
          </section>
        </div>, document.body,
      ) : null}
    </>
  );
}

function AppSettingsDialog({
  settings,
  onClose,
  onChanged,
}: {
  settings: AppSettings;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [confidence, setConfidence] = useState(String(Math.round((1 - settings.gradeAlpha) * 100)));

  const update = async (patch: Partial<AppSettings>) => {
    await store.updateSettings(patch);
    onChanged();
  };

  const commitConfidence = () => {
    const value = Number(confidence);
    if (!Number.isFinite(value) || value <= 0 || value >= 100) {
      setConfidence(String(Math.round((1 - settings.gradeAlpha) * 100)));
      return;
    }
    void update({ gradeAlpha: 1 - value / 100 });
  };

  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <div className="dialog-head">
          <div>
            <p className="eyebrow">Defaults</p>
            <h2 id="settings-title">Grade settings</h2>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="Close settings">×</button>
        </div>
        <p className="dialog-intro">
          Courses inherit these grade and prediction defaults. A course can override them from its settings.
        </p>

        <label className="field-row">
          <span>
            <b>Current-grade weighting</b>
            <small>Final-weight mode accounts for pending assignments before normalizing scored work.</small>
          </span>
          <select
            value={settings.gradeCurrentWeighting}
            onChange={(event) =>
              void update({ gradeCurrentWeighting: event.target.value as CurrentGradeWeighting })
            }
          >
            <option value="FINAL_ASSIGNMENT">Final assignment weights</option>
            <option value="CATEGORY_PROGRESS">Category progress</option>
          </select>
        </label>

        <label className="field-row">
          <span>
            <b>Confidence interval</b>
            <small>How wide the projected range should be.</small>
          </span>
          <span className="suffix-input">
            <input
              inputMode="decimal"
              value={confidence}
              onChange={(event) => setConfidence(event.target.value)}
              onBlur={commitConfidence}
              onKeyDown={(event) => event.key === "Enter" && event.currentTarget.blur()}
            />
            <i>%</i>
          </span>
        </label>

        <label className="field-row">
          <span>
            <b>Prediction source</b>
            <small>Where future-score evidence should come from.</small>
          </span>
          <select
            value={settings.gradeBasis}
            onChange={(event) => void update({ gradeBasis: event.target.value as ForecastBasis })}
          >
            {Object.entries(BASIS_LABEL).map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
        </label>

        <label className="toggle-row">
          <input
            type="checkbox"
            checked={settings.gradeIncludeEstimates}
            onChange={(event) => void update({ gradeIncludeEstimates: event.target.checked })}
          />
          <span>
            <b>Count estimated marks as evidence</b>
            <small>Estimated marks always affect the current grade. This also lets them narrow the forecast.</small>
          </span>
        </label>

        <label className="toggle-row">
          <input
            type="checkbox"
            checked={!settings.gradeCapForecast}
            onChange={(event) => void update({ gradeCapForecast: !event.target.checked })}
          />
          <span>
            <b>Allow extra credit in forecasts</b>
            <small>Projected results may extend beyond 100%, with conservative damping.</small>
          </span>
        </label>

        <div className="dialog-footer">
          <span>Saved automatically on this device.</span>
          <button className="primary-button" onClick={onClose}>Done</button>
        </div>
      </section>
    </div>
  );
}

export default function App() {
  const [data, setData] = useState<AppData>(() => loadData());
  const [activeId, setActiveId] = useState(initialCourseId);
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState("");

  const refresh = () => setData(loadData());
  const active = data.courses.find((course) => course.id === activeId) ?? data.courses[0] ?? null;

  useEffect(() => {
    if (active && active.id !== activeId) setActiveId(active.id);
  }, [active, activeId]);

  useEffect(() => {
    if (!active?.id) return;
    try {
      window.localStorage.setItem(ACTIVE_COURSE_KEY, active.id);
    } catch {
      // The gradebook itself already has an in-memory fallback.
    }
  }, [active?.id]);

  const gradeByCourse = useMemo(
    () => new Map(data.courses.map((course) => [course.id, currentGrade(course, data.settings)])),
    [data],
  );

  const addCourse = async () => {
    if (!newName.trim()) return;
    try {
      const color = PALETTE[data.courses.length % PALETTE.length]!;
      const course = await store.createCourse(newName, color);
      refresh();
      setActiveId(course.id);
      setNewName("");
      setAdding(false);
      setError("");
    } catch (cause) {
      setError((cause as Error).message);
    }
  };

  const removeCourse = async () => {
    if (!active) return;
    await store.deleteCourse(active.id);
    const next = loadData();
    setData(next);
    setActiveId(next.courses[0]?.id ?? "");
    setDeleting(false);
  };

  const accentStyle = active ? ({ "--accent": active.color } as CSSProperties) : undefined;

  return (
    <div className="app-shell" style={accentStyle}>
      <main className="main-panel">

        {active ? (
          <div className="workspace">
            <div className="gradebook-wrap">
              <GradeSheet
                key={active.id}
                itemId={active.id}
                courseName={active.name}
                categories={active.categories}
                course={active}
                app={data.settings}
                onChanged={refresh}
                courseHeader={<CourseIdentity course={active} switcher={
                  <CourseSwitcher active={active} courses={data.courses} grades={gradeByCourse}
                    onSelect={setActiveId} onAdd={() => setAdding(true)}
                    onSettings={() => setSettingsOpen(true)} />
                } />}
                courseIdentitySettings={<CourseAppearanceFields course={active} onChanged={refresh} />}
                onDeleteCourse={() => setDeleting(true)}
              />
            </div>
          </div>
        ) : (
          <section className="empty-state">
            <span className="empty-icon">∑</span>
            <h1>Create your first class</h1>
            <p>Track assignments, model your final grade, and see how much is still at stake.</p>
            <button className="primary-button" onClick={() => setAdding(true)}>Add a class</button>
          </section>
        )}

        {error ? <div className="toast" role="alert">{error}</div> : null}
      </main>

      {adding ? (
        <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && setAdding(false)}>
          <section className="settings-dialog" role="dialog" aria-modal="true" aria-labelledby="add-class-title"
            onKeyDown={(event) => event.key === "Escape" && setAdding(false)}>
            <div className="dialog-head">
              <h2 id="add-class-title">Add a class</h2>
              <button className="icon-button" onClick={() => setAdding(false)} aria-label="Close add class">×</button>
            </div>
            <form onSubmit={(event) => { event.preventDefault(); void addCourse(); }}>
              <label className="field-row">
                <span><b>Class name</b></span>
                <input autoFocus value={newName} onChange={(event) => setNewName(event.target.value)} />
              </label>
              <div className="dialog-footer">
                <button type="button" className="secondary-button" onClick={() => setAdding(false)}>Cancel</button>
                <button className="primary-button" disabled={!newName.trim()}>Add</button>
              </div>
            </form>
          </section>
        </div>
      ) : null}

      {settingsOpen ? (
        <AppSettingsDialog settings={data.settings} onClose={() => setSettingsOpen(false)} onChanged={refresh} />
      ) : null}

      {deleting && active ? (
        <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && setDeleting(false)}>
          <section className="confirm-dialog" role="alertdialog" aria-modal="true">
            <h2>Delete {active.name}?</h2>
            <p>This removes its categories, assignments, and forecasts from this browser. Export the gradebook first if you want a backup.</p>
            <div>
              <button className="secondary-button" onClick={() => setDeleting(false)}>Cancel</button>
              <button className="danger-button" onClick={() => void removeCourse()}>Delete class</button>
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}
