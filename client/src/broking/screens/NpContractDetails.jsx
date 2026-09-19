import ContractHeaderBar from './ContractHeaderBar';
export default function NpContractDetails({ contract }) {
  const { bundle } = contract;
  return (<><ContractHeaderBar bundle={bundle} step="NpContractDetails" /><p className="ab-help">NpContractDetails arrives in a later step.</p></>);
}
