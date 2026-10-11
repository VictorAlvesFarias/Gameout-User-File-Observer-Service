import { useState, type FormEvent } from 'react';
import { api } from '../api';
import type { Folder, LocalFolder } from '../types';
import { Icon } from './Icon';
import { Modal } from './Modal';

interface FolderDialogProps {
  /** Missing: creates a new group. */
  folder?: Folder;
  canPickFolder: boolean;
  onClose: () => void;
  onNotify: (kind: 'ok' | 'error', message: string) => void;
}

const emptyLocal: LocalFolder = { path: '', observer: true, autoValidateSync: true };

/** Which folder of this PC feeds a group, and what to do when it changes. */
export function FolderDialog({ folder, canPickFolder, onClose, onNotify }: FolderDialogProps) {
  const creating = !folder;
  const [name, setName] = useState('');
  const [local, setLocal] = useState<LocalFolder>(folder?.local ?? emptyLocal);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const set = <K extends keyof LocalFolder>(key: K, value: LocalFolder[K]) => setLocal((current) => ({ ...current, [key]: value }));

  async function pick() {
    try {
      const { path } = await api.pickFolder();
      if (!path) return;
      set('path', path);
      // The folder name is a good first guess for a new group.
      if (creating && !name) setName(path.split(/[\\/]/).filter(Boolean).pop() ?? '');
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      if (creating) await api.createGroup(name, local);
      else await api.setLocal(folder.id, local);
      onNotify('ok', creating ? `Grupo ${name} criado` : `Pasta de ${folder.name} salva`);
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!folder) return;
    setSaving(true);
    try {
      await api.removeLocal(folder.id);
      onNotify('ok', `${folder.name} não é mais enviado por este PC`);
      onClose();
    } catch (err) {
      setError((err as Error).message);
      setSaving(false);
    }
  }

  return (
    <Modal
      title={creating ? 'Novo grupo' : `Pasta de ${folder.name}`}
      onClose={onClose}
      onSubmit={submit}
      footer={
        <>
          {!creating && folder.local && (
            <button type="button" className="button danger" onClick={remove} disabled={saving}>
              <Icon name="unplug" />
              Remover deste PC
            </button>
          )}
          <span className="spacer" />
          <button type="button" className="button" onClick={onClose}>
            Cancelar
          </button>
          <button type="submit" className="button primary" disabled={saving}>
            <Icon name="save" />
            {saving ? 'Salvando…' : creating ? 'Criar grupo' : 'Salvar'}
          </button>
        </>
      }
    >
      <div className="modal-body">
        {creating && (
          <label className="field">
            <span>Nome do grupo</span>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Elden Ring" maxLength={120} required autoFocus />
            <small className="muted">Aparece no site. Guarda todas as versões; isso pode ser mudado lá.</small>
          </label>
        )}
        <label className="field">
          <span>Pasta neste PC</span>
          <div className="input-row">
            <input className="mono" value={local.path} onChange={(e) => set('path', e.target.value)} placeholder="C:\Users\voce\AppData\Roaming\Jogo\Saves" required />
            {canPickFolder && (
              <button type="button" className="button" onClick={pick}>
                <Icon name="folder" />
                Escolher…
              </button>
            )}
          </div>
          <small className="muted">Cada PC tem a sua pasta para o mesmo grupo; ela fica salva só aqui.</small>
        </label>
        <label className="check">
          <input type="checkbox" checked={local.observer} onChange={(e) => set('observer', e.target.checked)} />
          Enviar sozinho quando a pasta mudar
        </label>
        <label className="check">
          <input type="checkbox" checked={local.autoValidateSync} onChange={(e) => set('autoValidateSync', e.target.checked)} />
          Marcar como desatualizado quando a pasta mudar (e validar ao abrir o driver)
        </label>
        {error && <p className="form-error">{error}</p>}
      </div>
    </Modal>
  );
}
