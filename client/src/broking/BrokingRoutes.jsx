// client/src/broking/BrokingRoutes.jsx — the broking module's router:
//   /broking                      contract list (search)
//   /broking/new                  Identify step (UMR + business type)
//   /broking/gallery              component gallery (design-system states, for screenshots)
//   /broking/:contractId/:step    identify | treaty-detail | contract-details | structure
import { lazy } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';

const ContractListScreen = lazy(() => import('./screens/ContractListScreen'));
const IdentifyScreen = lazy(() => import('./screens/IdentifyScreen'));
const CaptureScreen = lazy(() => import('./screens/CaptureScreen'));
const GalleryScreen = lazy(() => import('./screens/GalleryScreen'));

export default function BrokingRoutes() {
  return (
    <Routes>
      <Route index element={<ContractListScreen />} />
      <Route path="new" element={<IdentifyScreen />} />
      <Route path="gallery" element={<GalleryScreen />} />
      <Route path=":contractId/:step" element={<CaptureScreen />} />
      <Route path=":contractId" element={<Navigate to="identify" replace />} />
      <Route path="*" element={<Navigate to="/broking" replace />} />
    </Routes>
  );
}
