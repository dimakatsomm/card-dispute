import { NavLink, Outlet } from 'react-router';
import { useAuth } from '../auth/AuthProvider';
import { routes } from './routes';

export const AppShell = () => {
  const auth = useAuth();
  return (
    <>
      <header>
        <nav aria-label="Main">
          <NavLink to={routes.home()} end>
            Accounts
          </NavLink>
          <NavLink to={routes.disputes()}>Disputes</NavLink>
          <button type="button" onClick={() => void auth.signOut()}>
            Sign out
          </button>
        </nav>
      </header>
      <main>
        <Outlet />
      </main>
    </>
  );
};
