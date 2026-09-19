// client/src/broking/BrokingRoutes.jsx — the broking module's router:
//   /broking                      contract list (search)
//   /broking/new                  Identify step (UMR + business type)
//   /broking/:contractId/:step    identify | treaty-detail | contract-details | structure
import { lazy } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';

const ContractListScreen = lazy(() => import('./screens/ContractListScreen'));
const IdentifyScreen = lazy(() => import('./screens/IdentifyScreen'));
const CaptureScreen = lazy(() => import('./screens/CaptureScreen'));

export default function BrokingRoutes() {
  return (
    <Routes>
      <Route index element={<ContractListScreen />} />
      <Route path="new" element={<IdentifyScreen />} />
      <Route path=":contractId/:step" element={<CaptureScreen />} />
      <Route path=":contractId" element={<Navigate to="identify" replace />} />
      <Route path="*" element={<Navigate to="/broking" replace />} />
    </Routes>
  );
}
