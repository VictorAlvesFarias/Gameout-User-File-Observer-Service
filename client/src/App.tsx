import { useCallback, useState } from 'react';
import { Icon, type IconName } from './components/Icon';
import { PanelView } from './components/PanelView';
import { SettingsView } from './components/SettingsView';
import type { Notice } from './types';
import { useServerEvents } from './useServerEvents';

type Tab = 'panel' | 'settings';

interface Toast {
  id: number;
  kind: 'ok' | 'error';
  message: string;
}

const tabs: Array<{ id: Tab; label: string; icon: IconName }> = [
  { id: 'panel', label: 'Painel', icon: 'upload' },
  { id: 'settings', label: 'Configurações', icon: 'settings' },
];

const tabFromHash = (): Tab => (window.location.hash.slice(1) === 'settings' ? 'settings' : 'panel');

export function App() {
  const [tab, setTabState] = useState<Tab>(tabFromHash);
  const [toasts, setToasts] = useState<Toast[]>([]);

  const notify = useCallback((kind: Toast['kind'], message: string) => {
    const id = Date.now() + Math.random();
    setToasts((current) => [...current, { id, kind, message }]);
    setTimeout(() => setToasts((current) => current.filter((t) => t.id !== id)), kind === 'error' ? 8000 : 5000);
  }, []);

  const onNotice = useCallback((notice: Notice) => notify(notice.kind, notice.message), [notify]);
  const { state, log, connected } = useServerEvents(onNotice);

  const setTab = (next: Tab) => {
    setTabState(next);
    window.history.replaceState(null, '', `#${next}`);
  };

  const summary = !state
    ? 'Iniciando…'
    : !state.configured
      ? 'Não configurado'
      : state.current
        ? `Enviando ${state.current.name}`
        : state.backend.status === 'ok'
          ? `${state.folders.filter((folder) => folder.watching).length} pasta(s) observada(s)`
          : 'Sem conexão com o servidor';

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">
            <Icon name="upload" size={22} />
          </span>
          <div>
            <h1>Gameout Driver</h1>
            <p className="muted">{summary}</p>
          </div>
        </div>
        <nav className="tabs">
          {tabs.map((item) => (
            <button key={item.id} className={tab === item.id ? 'is-active' : ''} onClick={() => setTab(item.id)}>
              <Icon name={item.icon} size={15} />
              {item.label}
            </button>
          ))}
        </nav>
      </header>

      {!connected && <div className="banner error">Sem conexão com o serviço interno do driver. Tentando de novo…</div>}

      <main>
        {tab === 'panel' && state && <PanelView state={state} log={log} onConfigure={() => setTab('settings')} onNotify={notify} />}
        {tab === 'settings' && <SettingsView onSaved={() => setTab('panel')} onNotify={notify} />}
      </main>

      <div className="toasts">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast ${toast.kind}`}>
            {toast.message}
          </div>
        ))}
      </div>
    </div>
  );
}
