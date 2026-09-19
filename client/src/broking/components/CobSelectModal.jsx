// CobSelectModal — the Universe "Select Lines of Business" checkbox modal
// (PropTreatyModals.CobSelectModal). The first selected class is the primary.
import { useState } from 'react';
import Modal from './Modal';
import Button from './Button';

export default function CobSelectModal({ open, selected = [], classList = [], title = 'Select Lines of Business', onSave, onClose }) {
  const [sel, setSel] = useState(() => new Set(selected));
  const toggle = (id) => setSel((cur) => { const n = new Set(cur); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  // Universe: the Set's insertion order — classes in the order they were ticked, the first is the primary.
  const ordered = [...sel];
  return (
    <Modal open={open} onClose={onClose} title={title} tag={`${sel.size} selected`}
      footer={<><span className="ab-help">First selected class is the primary class.</span><span className="ab-right"><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={() => onSave(ordered)}>Apply</Button></span></>}>
      <div className="ab-check-list">
        {classList.map((c) => (
          <label key={c.id}><input type="checkbox" className="ab-check" checked={sel.has(c.id)} onChange={() => toggle(c.id)} />{c.name}</label>
        ))}
      </div>
    </Modal>
  );
}
