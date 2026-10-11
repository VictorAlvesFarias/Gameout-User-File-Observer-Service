import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api } from '../api';
import type { Page, ServerLog } from '../types';
import { Icon } from './Icon';

interface ServerLogsViewProps {
  online: boolean;
}

const pageSize = 50;
const actionClass: Record<string, string> = { Success: 'ok', Error: 'error', Warning: 'warn', Info: 'info' };
const time = (iso: string) => new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'medium' });

/** The backend's application log (the same one the web shows), a page at a time. */
export function ServerLogsView({ online }: ServerLogsViewProps) {
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [result, setResult] = useState<Page<ServerLog> | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setResult(await api.serverLogs(page, pageSize, query));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [page, query]);

  useEffect(() => {
    if (online) void load();
  }, [online, load]);

  function submit(event: FormEvent) {
    event.preventDefault();
    setPage(1);
    setQuery(search.trim());
  }

  const pages = result ? Math.max(1, Math.ceil(result.totalCount / result.pageSize)) : 1;

  return (
    <div className="server-logs">
      <header className="section-head">
        <div>
          <h2>Logs do servidor</h2>
          <p className="muted small">{result ? `${result.totalCount.toLocaleString('pt-BR')} registro(s)` : 'Os mesmos logs que o site mostra.'}</p>
        </div>
        <form className="action-row" onSubmit={submit}>
          <input className="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Mensagem, detalhe ou trace id" />
          <button type="submit" className="button" disabled={!online || loading}>
            <Icon name="eye" />
            Buscar
          </button>
          <button type="button" className="button" onClick={() => void load()} disabled={!online || loading} title="Atualizar">
            <Icon name="refresh" />
          </button>
        </form>
      </header>

      {!online && <div className="banner warn">Conecte o driver ao servidor para ver os logs.</div>}
      {error && <div className="banner error">{error}</div>}

      {result && result.items.length === 0 ? (
        <div className="card empty-state">
          <Icon name="code" size={28} />
          <p className="muted">{query ? 'Nada encontrado para essa busca.' : 'Nenhum log ainda.'}</p>
        </div>
      ) : (
        <ul className="card server-log-list">
          {result?.items.map((entry) => (
            <li key={entry.id} className={open === entry.id ? 'is-open' : ''}>
              <button type="button" className="server-log-row" onClick={() => setOpen(open === entry.id ? null : entry.id)} disabled={!entry.details}>
                <span className={`server-log-action ${actionClass[entry.action] ?? 'info'}`}>{entry.action}</span>
                <span className="server-log-message">{entry.message}</span>
                <span className="muted small mono">#{entry.traceId}</span>
                <span className="muted small">{time(entry.createDate)}</span>
              </button>
              {open === entry.id && entry.details && <pre className="server-log-details">{entry.details}</pre>}
            </li>
          ))}
        </ul>
      )}

      {result && result.totalCount > result.pageSize && (
        <footer className="pager">
          <button className="button" onClick={() => setPage(page - 1)} disabled={page <= 1 || loading}>
            <Icon name="back" />
            Anterior
          </button>
          <span className="muted small">
            Página {page} de {pages}
          </span>
          <button className="button" onClick={() => setPage(page + 1)} disabled={page >= pages || loading}>
            Próxima
            <Icon name="chevron" />
          </button>
        </footer>
      )}
    </div>
  );
}
