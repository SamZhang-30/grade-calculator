import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { DEFAULT_GRADE_CONFIG, summarize, type ForecastBasis } from "./grade-engine";
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

function MenuIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="M3.5 5.5h13M3.5 10h13M3.5 14.5h13" />
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
  });
  return summary.percent === null ? "—" : `${Math.round(summary.percent * 100)}%`;
}

function CourseTitle({ course, onChanged }: { course: Course; onChanged: () => void }) {
  const [name, setName] = useState(course.name);
  useEffect(() => setName(course.name), [course.id, course.name]);

  const commit = async () => {
    const next = name.trim();
    if (!next) {
      setName(course.name);
      return;
    }
    if (next === course.name) return;
    await store.updateCourse(course.id, { name: next });
    onChanged();
  };

  return (
    <input
      className="course-title-input"
      title={name}
      value={name}
      onChange={(event) => setName(event.target.value)}
      onBlur={() => void commit()}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
        if (event.key === "Escape") {
          setName(course.name);
          event.currentTarget.blur();
        }
      }}
      aria-label="Class name"
    />
  );
}

function AppearanceControl({ course, onChanged }: { course: Course; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
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
    <div className="appearance-control">
      <button
        className="course-emoji-trigger"
        style={{ "--course-color": course.color } as CSSProperties}
        onClick={() => setOpen(!open)}
        aria-label={`Change icon or color for ${course.name}`}
        aria-expanded={open}
      >
        {course.emoji}
      </button>
      {open ? (
        <div className="modal-backdrop grade-modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && setOpen(false)}>
          <section className="settings-dialog appearance-dialog" role="dialog" aria-modal="true" aria-labelledby="appearance-title">
            <div className="dialog-head">
              <div>
                <p className="eyebrow">Course identity</p>
                <h2 id="appearance-title">Icon and color</h2>
              </div>
              <button className="icon-button" onClick={() => setOpen(false)} aria-label="Close course appearance">×</button>
            </div>
            <p className="dialog-intro">Use any emoji and accent color combination.</p>
            <div className="appearance-fields">
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
            <div className="dialog-footer">
              <span>Changes are saved automatically.</span>
              <button className="primary-button" onClick={() => setOpen(false)}>Done</button>
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}

function CourseIdentity({ course, onChanged }: { course: Course; onChanged: () => void }) {
  const units = formatUnits(course.units);
  const subtitle = [course.term, course.instructor, units].filter(Boolean).join(" • ");
  return (
    <div className="course-identity">
      <AppearanceControl course={course} onChanged={onChanged} />
      <div className="course-identity-copy">
        <CourseTitle course={course} onChanged={onChanged} />
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
            <h2 id="settings-title">Prediction settings</h2>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="Close settings">×</button>
        </div>
        <p className="dialog-intro">
          New and inherited category forecasts use these values. A class or category can override them from its calculator button.
        </p>

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
  const [sidebarOpen, setSidebarOpen] = useState(false);
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
      setSidebarOpen(false);
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
      <button
        className={`sidebar-scrim${sidebarOpen ? " visible" : ""}`}
        onClick={() => setSidebarOpen(false)}
        aria-label="Close class sidebar"
      />
      <aside className={`sidebar${sidebarOpen ? " open" : ""}`}>
        <div className="brand">
          <span className="brand-mark">G</span>
          <div>
            <strong>Gradebook</strong>
            <span>Local calculator</span>
          </div>
        </div>

        <div className="sidebar-label">
          <span>Classes</span>
          <button onClick={() => setAdding(true)} aria-label="Add class">+</button>
        </div>

        <nav className="course-list" aria-label="Classes">
          {data.courses.map((course) => (
            <button
              key={course.id}
              className={course.id === active?.id ? "active" : ""}
              style={{ "--course-color": course.color } as CSSProperties}
              onClick={() => {
                setActiveId(course.id);
                setSidebarOpen(false);
              }}
            >
              <i className="course-emoji" style={{ "--course-color": course.color } as CSSProperties}>{course.emoji}</i>
              <span>{course.name}</span>
              <b>{gradeByCourse.get(course.id)}</b>
            </button>
          ))}
        </nav>

        {adding ? (
          <div className="add-course-form">
            <input
              autoFocus
              placeholder="Class name"
              value={newName}
              onChange={(event) => setNewName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void addCourse();
                if (event.key === "Escape") setAdding(false);
              }}
            />
            <button className="primary-button" onClick={() => void addCourse()} disabled={!newName.trim()}>Add</button>
            <button className="text-button" onClick={() => setAdding(false)}>Cancel</button>
          </div>
        ) : (
          <button className="add-course" onClick={() => setAdding(true)}>+ Add a class</button>
        )}

        <div className="sidebar-footer">
          <span className="saved-dot" />
          <span>Private to this browser</span>
          <button onClick={() => setSettingsOpen(true)} aria-label="Prediction settings">
            <SettingsIcon />
          </button>
        </div>
      </aside>

      <main className="main-panel">
        <header className="mobile-head">
          <button className="icon-button" onClick={() => setSidebarOpen(true)} aria-label="Open class sidebar"><MenuIcon /></button>
          <strong>Gradebook</strong>
          <button className="icon-button" onClick={() => setSettingsOpen(true)} aria-label="Prediction settings"><SettingsIcon /></button>
        </header>

        {active ? (
          <div className="workspace">
            <div className="gradebook-wrap">
              <GradeSheet
                itemId={active.id}
                courseName={active.name}
                categories={active.categories}
                course={active}
                app={data.settings}
                onChanged={refresh}
                courseHeader={<CourseIdentity course={active} onChanged={refresh} />}
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
