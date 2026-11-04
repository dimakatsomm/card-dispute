import { NavLink, Outlet } from 'react-router';
import { useAgentArea } from '../auth/AuthProvider';
import { buttonClass, cx, focusRing, pageGutterClass } from '../components/ui';
import { agentRoutes } from './routes';

const navLinkClass = ({ isActive }: { readonly isActive: boolean }): string =>
  cx(
    'rounded-lg px-3 py-1.5 text-sm font-medium motion-safe:transition-colors',
    isActive ? 'bg-accent-soft text-accent-strong' : 'text-zinc-600 hover:bg-zinc-100 hover:text-ink',
    focusRing,
  );

export const AgentShell = () => {
  const agent = useAgentArea();
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="sticky top-0 z-10 border-b border-line bg-surface/90 backdrop-blur supports-[backdrop-filter]:bg-surface/75">
        <div className={cx(pageGutterClass, 'flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-3')}>
          <span className="flex items-center gap-2 text-sm font-semibold tracking-tight text-ink">
            <span aria-hidden="true" className="size-2.5 rounded-full bg-amber-500" />
            Card disputes back office
          </span>
          <nav aria-label="Back office" className="flex items-center gap-1">
            <NavLink to={agentRoutes.queue()} end className={navLinkClass}>
              Review queue
            </NavLink>
            <span aria-hidden="true" className="mx-1 h-5 w-px bg-line" />
            <button type="button" className={buttonClass('ghost', 'sm')} onClick={() => void agent?.auth.signOut()}>
              Sign out
            </button>
          </nav>
        </div>
      </header>
      <main className={cx(pageGutterClass, 'flex-1 py-8 sm:py-10')}>
        <Outlet />
      </main>
    </div>
  );
};
