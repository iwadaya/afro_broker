// Button — primary (one per screen) / ghost / warn (opens a manual-entry modal) / sm.
import { Link } from 'react-router-dom';

export default function Button({ variant = 'ghost', size, to, type = 'button', className = '', children, ...rest }) {
  const cls = `ab-btn ${variant}${size ? ` ${size}` : ''} ${className}`.trim();
  if (to) return <Link to={to} className={cls} {...rest}>{children}</Link>;
  return <button type={type} className={cls} {...rest}>{children}</button>;
}
