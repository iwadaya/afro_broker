// Pane — the Universe `card glass`: UPPERCASE title, optional tag or head control, body of FormRows.
export default function Pane({ title, tag, headRight, className = '', bodyClassName = '', children, ...rest }) {
  return (
    <section className={`ab-pane ${className}`.trim()} {...rest}>
      <div className="ab-pane-head">
        <span className="ab-pane-title">{title}</span>
        {headRight ?? (tag ? <span className="ab-tag">{tag}</span> : null)}
      </div>
      <div className={`ab-pane-body ${bodyClassName}`.trim()}>{children}</div>
    </section>
  );
}
