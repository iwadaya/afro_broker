import AppShell from './components/app/AppShell';
import AuthBootstrap from './components/app/AuthBootstrap';

export default function App() {
  return (
    <AuthBootstrap>
      <AppShell />
    </AuthBootstrap>
  );
}
