import { useState } from 'react';
import { api } from '../api';
import type { DriverState, Folder, Link, LogEntry } from '../types';
import { Icon, type IconName } from './Icon';
import { LogView } from './LogView';

interface PanelViewProps {
  state: DriverState;
  log: LogEntry[];
  onConfigure: () => void;
  onNotify: (kind: 'ok' | 'error', message: string) => void;
}

const linkLabels: Record<Link['status'], string> = { off: 'Desligado', connecting: 'Conectando…', ok: 'Conectado', error: 'Com problema' };
const dotClass: Record<Link['status'], string> = { off: 'idle', connecting: 'busy', ok: 'up', error: 'down' };

function LinkCard({ title, icon, link }: { title: string; icon: IconName; link: Link }) {
  return (
    <div className={`status-block ${link.status === 'ok' ? 'up' : link.status === 'error' ? 'down' : link.status === 'connecting' ? 'busy' : ''}`}>
      <span className="eyebrow">
        <Icon name={icon} size={13} /> {title}
      </span>
      <div className="status-row">
        <span className={`dot ${dotClass[link.status]}`} />
        <strong>{linkLabels[link.status]}</strong>
      </div>
      <span className="muted small ellipsis" title={link.message}>
        {link.message || '—'}
      </span>
    </div>
  );
}

const megabytes = (bytes: number) => `${(bytes / 1024 / 1024).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} MB`;
const time = (iso: string) => new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });

function folderState(folder: Folder, state: DriverState): { label: string; className: string } {
  if (state.current?.appFileId === folder.id) return { label: 'Enviando', className: 'chip-accent' };
  if (state.queue.includes(folder.id)) return { label: 'Na fila', className: 'chip-accent' };
  if (folder.problem) return { label: folder.problem, className: 'chip-warn' };
  if (folder.watching) return { label: 'Observando', className: 'chip-ok' };
  return { label: 'Sem observação', className: '' };
}

/** Connections, the backup in progress and every folder registered in Gameout. */
export function PanelView({ state, log, onConfigure, onNotify }: PanelViewProps) {
  const [busy, setBusy] = useState<string | null>(null);
  const { current } = state;
  const percent = current?.total ? Math.min(100, Math.round((current.bytes / current.total) * 100)) : null;
  const online = state.backend.status === 'ok';

  async function run(key: string, action: () => Promise<unknown>, okMessage?: string) {
    setBusy(key);
    try {
      await action();
      if (okMessage) onNotify('ok', okMessage);
    } catch (error) {
      onNotify('error', (error as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="panel-layout">
      <div className="panel-main">
        {!state.configured && (
          <div className="card empty-state">
            <Icon name="link" size={32} />
            <h2>Conecte o driver ao Gameout</h2>
            <p className="muted">Informe o endereço do servidor e a API key (gerada no site do Gameout), e os dados do RabbitMQ.</p>
            <button className="button primary" onClick={onConfigure}>
              <Icon name="settings" />
              Abrir configurações
            </button>
          </div>
        )}

        <section className="links">
          <LinkCard title="Servidor" icon="globe" link={state.backend} />
          <LinkCard title="Comandos (RabbitMQ)" icon="download" link={state.rabbit} />
          <LinkCard title="Presença (WebSocket)" icon="power" link={state.socket} />
        </section>

        {current && (
          <section className="card job-card">
            <div className="section-head">
              <div className="list-text">
                <strong>Backup de {current.name}</strong>
                <span className="muted small">
                  {current.phase === 'scan' && 'Lendo a pasta…'}
                  {current.phase === 'zip' && `Compactando · ${megabytes(current.bytes)}${current.total ? ` de ${megabytes(current.total)}` : ''}`}
                  {current.phase === 'upload' && `Enviando · ${megabytes(current.bytes)}${current.total ? ` de ${megabytes(current.total)}` : ''}`}
                </span>
              </div>
              {percent !== null && <strong>{percent}%</strong>}
            </div>
            <div className={`progress${percent === null ? ' indeterminate' : ''}`}>
              <div style={percent === null ? undefined : { width: `${percent}%` }} />
            </div>
          </section>
        )}

        <header className="section-head">
          <h2>Pastas</h2>
          <div className="action-row">
            <button className="button" onClick={() => run('refresh', api.refreshFolders, 'Pastas atualizadas')} disabled={!online || busy !== null}>
              <Icon name="refresh" />
              Atualizar
            </button>
            <button
              className="button primary"
              onClick={() => run('all', async () => onNotify('ok', `${(await api.syncAll()).queued} pasta(s) na fila`))}
              disabled={!online || busy !== null || !state.folders.some((folder) => folder.watching)}
            >
              <Icon name="upload" />
              Sincronizar todas
            </button>
          </div>
        </header>

        {state.folders.length === 0 ? (
          <div className="card empty-state">
            <Icon name="folder" size={28} />
            <p className="muted">{online ? 'Nenhuma pasta cadastrada no Gameout.' : 'As pastas aparecem quando o driver se conecta ao servidor.'}</p>
          </div>
        ) : (
          <ul className="connection-cards">
            {state.folders.map((folder) => {
              const status = folderState(folder, state);
              return (
                <li key={folder.id} className="card connection-card">
                  <div className="connection-card-body static">
                    <span className={`dot ${folder.watching ? 'up' : folder.problem ? 'down' : 'idle'}`} />
                    <span className="list-text">
                      <strong>{folder.name}</strong>
                      <span className="muted small mono ellipsis" title={folder.path}>
                        {folder.path}
                      </span>
                      <span className="muted small">
                        {[folder.observer && 'backup automático', folder.autoValidateSync && 'valida a sincronização'].filter(Boolean).join(' · ') || 'só manual'}
                        {folder.lastSync && ` · último envio ${time(folder.lastSync.at)}: ${folder.lastSync.ok ? 'ok' : folder.lastSync.message}`}
                      </span>
                    </span>
                    <span className={`chip ${status.className}`}>{status.label}</span>
                  </div>
                  <button
                    className="button"
                    onClick={() => run(`sync-${folder.id}`, () => api.syncFolder(folder.id), `${folder.name} na fila`)}
                    disabled={!online || busy !== null || state.queue.includes(folder.id) || current?.appFileId === folder.id}
                  >
                    <Icon name="upload" />
                    Sincronizar agora
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <LogView entries={log} />
    </div>
  );
}
