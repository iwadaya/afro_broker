// Badge — status words in a pill with a leading dot (design system Badge README).
export const STATUS_VARIANT = {
  DRAFT: '', SUBMITTED: 'info', QUOTED: 'info', FIRM_ORDER: 'warn', BOUND: 'success', SIGNED: 'success', NTU: 'danger', CANCELLED: 'danger',
};
export const STATUS_LABEL = {
  DRAFT: 'Draft', SUBMITTED: 'Submitted', QUOTED: 'Quoted', FIRM_ORDER: 'Firm order', BOUND: 'Bound', SIGNED: 'Signed', NTU: 'NTU', CANCELLED: 'Cancelled',
};

export default function Badge({ status, variant, children, className = '', ...rest }) {
  const v = variant ?? (status ? STATUS_VARIANT[status] ?? '' : '');
  const label = children ?? (status ? STATUS_LABEL[status] ?? status : '');
  return <span className={`ab-badge ${v} ${className}`.trim()} data-status={status || undefined} {...rest}>{label}</span>;
}
