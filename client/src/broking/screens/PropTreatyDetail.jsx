import ContractHeaderBar from './ContractHeaderBar';
export default function PropTreatyDetail({ contract }) {
  const { bundle } = contract;
  return (<><ContractHeaderBar bundle={bundle} step="PropTreatyDetail" /><p className="ab-help">PropTreatyDetail arrives in a later step.</p></>);
}
