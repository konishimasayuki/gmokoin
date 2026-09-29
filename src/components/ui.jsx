export function Card({ title, action, children, className = "" }) {
  return (
    <section className={`card ${className}`}>
      {(title || action) && (
        <div className="card-head">
          {title && <h2>{title}</h2>}
          {action}
        </div>
      )}
      {children}
    </section>
  );
}

export function Badge({ tone = "", children }) {
  return <span className={`badge ${tone}`}>{children}</span>;
}

export function Toggle({ checked, onChange, label, hint }) {
  return (
    <label className="toggle">
      <span>
        {label}
        {hint && <small>{hint}</small>}
      </span>
      <input
        type="checkbox"
        checked={Boolean(checked)}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="sw" aria-hidden="true" />
    </label>
  );
}

export function Metric({ label, value, sub, tone = "" }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <b className={`num ${tone}`}>{value}</b>
      {sub && <small>{sub}</small>}
    </div>
  );
}

export function Empty({ children }) {
  return <p className="hint empty">{children}</p>;
}
