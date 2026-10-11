import { useEffect, useState, type FormEvent } from 'react';
import { api } from '../api';
import type { PublicSettings, SettingsInput } from '../types';
import { Icon } from './Icon';
import { SecretInput } from './SecretInput';

interface SettingsViewProps {
  onSaved: () => void;
  onNotify: (kind: 'ok' | 'error', message: string) => void;
}

const toInput = (settings: PublicSettings): SettingsInput => ({ backendUrl: settings.backendUrl });

/** Server address, API key and the desktop options. Saving reconnects. */
export function SettingsView({ onSaved, onNotify }: SettingsViewProps) {
  const [saved, setSaved] = useState<PublicSettings | null>(null);
  const [draft, setDraft] = useState<SettingsInput | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.settings().then(
      (settings) => {
        setSaved(settings);
        setDraft(toInput(settings));
      },
      (err: Error) => setError(err.message),
    );
  }, []);

  if (!draft || !saved) return <p className="muted">{error ?? 'Carregando…'}</p>;

  const set = <K extends keyof SettingsInput>(key: K, value: SettingsInput[K]) => setDraft((current) => (current ? { ...current, [key]: value } : current));

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!draft) return;
    setSaving(true);
    setError(null);
    try {
      const result = await api.saveSettings(draft);
      setSaved(result);
      setDraft(toInput(result));
      onNotify('ok', 'Configurações salvas. Reconectando…');
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function toggleAutoStart(enabled: boolean) {
    try {
      const result = await api.setAutoStart(enabled);
      setSaved((current) => (current ? { ...current, autoStart: result.enabled } : current));
    } catch (err) {
      onNotify('error', (err as Error).message);
    }
  }

  return (
    <form className="settings-form" onSubmit={submit}>
      <section className="card settings-section">
        <h3>
          <Icon name="globe" /> Servidor do Gameout
        </h3>
        <div className="grid-fields">
          <label className="field wide">
            <span>Endereço da API</span>
            <input value={draft.backendUrl} onChange={(e) => set('backendUrl', e.target.value)} placeholder="http://localhost:8201" required />
            <small className="muted">No My-Personal-Compose: http://localhost:8201. Em desenvolvimento: https://localhost:7000.</small>
          </label>
          <SecretInput label="API key" stored={saved.hasApiKey} value={draft.apiKey} onChange={(value) => set('apiKey', value)} />
        </div>
      </section>

      {saved.autoStart !== null && (
        <section className="card settings-section">
          <h3>
            <Icon name="power" /> Windows
          </h3>
          <label className="check">
            <input type="checkbox" checked={saved.autoStart} onChange={(e) => toggleAutoStart(e.target.checked)} />
            Iniciar com o Windows (na bandeja, sem abrir a janela)
          </label>
        </section>
      )}

      {error && <p className="form-error">{error}</p>}
      <div className="settings-actions">
        <button type="submit" className="button primary" disabled={saving}>
          <Icon name="save" />
          {saving ? 'Salvando…' : 'Salvar e reconectar'}
        </button>
        <span className="muted small">A API key fica criptografada para este usuário do Windows (DPAPI).</span>
      </div>
    </form>
  );
}
