import ContractHeaderBar from './ContractHeaderBar';
export default function NpStructure({ contract }) {
  const { bundle } = contract;
  return (<><ContractHeaderBar bundle={bundle} step="NpStructure" /><p className="ab-help">NpStructure arrives in a later step.</p></>);
}
