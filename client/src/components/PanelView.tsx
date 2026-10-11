import { useState } from 'react';
import { api } from '../api';
import type { DriverState, Folder, FolderStatus, Link, LogEntry } from '../types';
import { FolderDialog } from './FolderDialog';
import { Icon } from './Icon';
import { LogView } from './LogView';

interface PanelViewProps {
  state: DriverState;
  log: LogEntry[];
  canPickFolder: boolean;
  onConfigure: () => void;
  onNotify: (kind: 'ok' | 'error', message: string) => void;
}

const linkLabels: Record<Link['status'], string> = { off: 'Desligado', connecting: 'Conectando…', ok: 'Conectado', error: 'Com problema' };
const dotClass: Record<Link['status'], string> = { off: 'idle', connecting: 'busy', ok: 'up', error: 'down' };

const statusLabels: Record<FolderStatus, string> = {
  Pending: 'Pendente',
  Processing: 'Enviando',
  Synced: 'Sincronizado',
  Unsynced: 'Desatualizado',
  PathNotFounded: 'Pasta não encontrada',
  LockedFiles: 'Arquivos em uso',
};

const megabytes = (bytes: number) => `${(bytes / 1024 / 1024).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} MB`;
const time = (iso: string) => new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });

/** What this PC is doing with the group right now, or the status the backend has for it. */
function folderChip(folder: Folder, state: DriverState): { label: string; className: string } {
  if (state.current?.appFileId === folder.id) return { label: 'Enviando', className: 'chip-accent' };
  if (state.queue.includes(folder.id)) return { label: 'Na fila', className: 'chip-accent' };
  if (folder.local && folder.problem) return { label: folder.problem, className: 'chip-warn' };
  if (!folder.status) return { label: 'Sem status', className: '' };
  const className = folder.status === 'Synced' ? 'chip-ok' : folder.status === 'Processing' ? 'chip-accent' : 'chip-warn';
  return { label: statusLabels[folder.status], className };
}

function localSummary(folder: Folder): string {
  if (!folder.local) return '';
  const modes = [folder.local.observer && 'envia ao mudar', folder.local.autoValidateSync && 'valida ao mudar'].filter(Boolean).join(' · ');
  return modes || 'só manual';
}

/** The server connection, the backup in progress and every group of the account. */
export function PanelView({ state, log, canPickFolder, onConfigure, onNotify }: PanelViewProps) {
  const [busy, setBusy] = useState<string | null>(null);
  const [dialog, setDialog] = useState<{ folder?: Folder } | null>(null);
  const { current } = state;
  const percent = current?.total ? Math.min(100, Math.round((current.bytes / current.total) * 100)) : null;
  const online = state.backend.status === 'ok';
  const withFolder = state.folders.filter((folder) => folder.local);
  const withoutFolder = state.folders.filter((folder) => !folder.local);

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

  function renderFolder(folder: Folder) {
    const chip = folderChip(folder, state);
    const working = state.queue.includes(folder.id) || current?.appFileId === folder.id;
    return (
      <li key={folder.id} className="card connection-card">
        <div className="connection-card-body static">
          <span className={`dot ${!folder.local ? 'idle' : folder.problem ? 'down' : folder.watching ? 'up' : 'idle'}`} />
          <span className="list-text">
            <strong>{folder.name}</strong>
            {folder.local ? (
              <span className="muted small mono ellipsis" title={folder.local.path}>
                {folder.local.path}
              </span>
            ) : (
              <span className="muted small">Este PC não envia este grupo.</span>
            )}
            <span className="muted small">
              {[
                localSummary(folder),
                folder.versionControl && 'guarda todas as versões',
                folder.lastSyncedAt && `última versão ${time(folder.lastSyncedAt)}`,
                folder.lastSync && !folder.lastSync.ok && `último envio falhou: ${folder.lastSync.message}`,
              ]
                .filter(Boolean)
                .join(' · ')}
            </span>
          </span>
          <span className={`chip ${chip.className}`} title={folder.statusMessage ?? undefined}>
            {chip.label}
          </span>
        </div>
        <div className="action-row">
          <button className="button" onClick={() => setDialog({ folder })} disabled={!online}>
            <Icon name={folder.local ? 'edit' : 'folder'} />
            {folder.local ? 'Pasta' : 'Escolher pasta'}
          </button>
          {folder.local && (
            <>
              <button className="button" onClick={() => run(`check-${folder.id}`, () => api.checkFolder(folder.id))} disabled={!online || busy !== null || working}>
                <Icon name="check" />
                Validar
              </button>
              <button
                className="button primary"
                onClick={() => run(`sync-${folder.id}`, () => api.syncFolder(folder.id), `${folder.name} na fila`)}
                disabled={!online || busy !== null || working}
              >
                <Icon name="upload" />
                Sincronizar
              </button>
            </>
          )}
        </div>
      </li>
    );
  }

  return (
    <div className="panel-layout">
      <div className="panel-main">
        {!state.configured && (
          <div className="card empty-state">
            <Icon name="link" size={32} />
            <h2>Conecte o driver ao Gameout</h2>
            <p className="muted">Informe o endereço do servidor e a API key gerada no site do Gameout (Config).</p>
            <button className="button primary" onClick={onConfigure}>
              <Icon name="settings" />
              Abrir configurações
            </button>
          </div>
        )}

        <section className={`status-block ${online ? 'up' : state.backend.status === 'error' ? 'down' : state.backend.status === 'connecting' ? 'busy' : ''}`}>
          <span className="eyebrow">
            <Icon name="globe" size={13} /> Servidor
          </span>
          <div className="status-row">
            <span className={`dot ${dotClass[state.backend.status]}`} />
            <strong>{linkLabels[state.backend.status]}</strong>
          </div>
          <span className="muted small ellipsis" title={state.backend.message}>
            {state.backend.message || '—'}
            {online && state.checkedAt && ` · grupos lidos às ${new Date(state.checkedAt).toLocaleTimeString('pt-BR', { timeStyle: 'short' })}`}
          </span>
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
          <h2>Grupos</h2>
          <div className="action-row">
            <button className="button" onClick={() => run('refresh', api.refreshFolders)} disabled={!online || busy !== null} title="Ler os grupos do servidor">
              <Icon name="refresh" />
            </button>
            <button
              className="button"
              onClick={() => run('all', async () => onNotify('ok', `${(await api.syncAll()).queued} grupo(s) na fila`))}
              disabled={!online || busy !== null || withFolder.length === 0}
            >
              <Icon name="upload" />
              Sincronizar todos
            </button>
            <button className="button primary" onClick={() => setDialog({})} disabled={!online}>
              <Icon name="plus" />
              Novo grupo
            </button>
          </div>
        </header>

        {state.folders.length === 0 ? (
          <div className="card empty-state">
            <Icon name="folder" size={28} />
            <p className="muted">{online ? 'Nenhum grupo ainda. Crie um escolhendo a pasta dos saves.' : 'Os grupos aparecem quando o driver se conecta ao servidor.'}</p>
          </div>
        ) : (
          <>
            {withFolder.length > 0 && <ul className="connection-cards">{withFolder.map(renderFolder)}</ul>}
            {withoutFolder.length > 0 && (
              <>
                <h3 className="subhead">Sem pasta neste PC</h3>
                <ul className="connection-cards">{withoutFolder.map(renderFolder)}</ul>
              </>
            )}
          </>
        )}
      </div>

      <LogView entries={log} />

      {dialog && <FolderDialog folder={dialog.folder} canPickFolder={canPickFolder} onClose={() => setDialog(null)} onNotify={onNotify} />}
    </div>
  );
}
