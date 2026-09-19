// StaleWriteDialog — the 409 dialog: Reload (drop local edits, load the newer
// version) or Overwrite (save again with force).
import Modal from './Modal';
import Button from './Button';

export default function StaleWriteDialog({ conflict, onResolve }) {
  if (!conflict) return null;
  return (
    <Modal open onClose={() => onResolve('reload')} title="Changed by someone else" tag="409"
      footer={<><span className="ab-help">Server version {conflict.current}, yours {conflict.expected}.</span><span className="ab-right"><Button onClick={() => onResolve('reload')}>Reload</Button><Button variant="danger" onClick={() => onResolve('overwrite')}>Overwrite</Button></span></>}>
      <p className="ab-help" style={{ fontSize: 13 }}>This contract was saved by a colleague after you opened it. Reload to see their version and lose your unsaved changes, or overwrite theirs with yours.</p>
    </Modal>
  );
}
