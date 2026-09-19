// ErrorSummary — after a save attempt, lists "Required: <label>" per missing field
// (the `required` colour alone is below 3:1 on white, so the word is always shown).
export default function ErrorSummary({ missing = [], message = null }) {
  if (!missing.length && !message) return null;
  return (
    <div className="ab-error-summary" role="alert" data-testid="error-summary">
      {message || 'Complete the required fields before submitting.'}
      {missing.length > 0 && <ul>{missing.map((m) => <li key={m}>Required: {m}</li>)}</ul>}
    </div>
  );
}
