import { useEffect, useState, type FormEvent } from 'react';
import { api } from '../api';
import type { PublicSettings, SettingsInput } from '../types';
import { Icon } from './Icon';
import { SecretInput } from './SecretInput';

interface SettingsViewProps {
  onSaved: () => void;
  onNotify: (kind: 'ok' | 'error', message: string) => void;
}

const toInput = (settings: PublicSettings): SettingsInput => {
  const { effectiveSocketUrl: _socket, hasApiKey: _key, hasRabbitPassword: _password, autoStart: _autoStart, ...rest } = settings;
  return rest;
};

/** Server address and API key, RabbitMQ, and the desktop options. Saving reconnects everything. */
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
          <label className="field">
            <span>WebSocket (opcional)</span>
            <input value={draft.socketUrl} onChange={(e) => set('socketUrl', e.target.value)} placeholder={saved.effectiveSocketUrl} />
            <small className="muted">Vazio: derivado do endereço da API.</small>
          </label>
        </div>
      </section>

      <section className="card settings-section">
        <h3>
          <Icon name="download" /> RabbitMQ
        </h3>
        <div className="grid-fields">
          <label className="field">
            <span>Servidor</span>
            <input value={draft.rabbitHost} onChange={(e) => set('rabbitHost', e.target.value)} required />
          </label>
          <label className="field">
            <span>Porta</span>
            <input type="number" min={1} max={65535} value={draft.rabbitPort} onChange={(e) => set('rabbitPort', Number(e.target.value))} />
          </label>
          <label className="field">
            <span>Usuário</span>
            <input value={draft.rabbitUser} onChange={(e) => set('rabbitUser', e.target.value)} autoComplete="off" required />
          </label>
          <SecretInput label="Senha" stored={saved.hasRabbitPassword} value={draft.rabbitPassword} onChange={(value) => set('rabbitPassword', value)} />
        </div>
        <details className="advanced">
          <summary>Avançado (nomes do backend)</summary>
          <div className="grid-fields">
            <label className="field">
              <span>Virtual host</span>
              <input value={draft.rabbitVirtualHost} onChange={(e) => set('rabbitVirtualHost', e.target.value)} />
            </label>
            <label className="field">
              <span>Exchange de comandos</span>
              <input className="mono" value={draft.commandExchange} onChange={(e) => set('commandExchange', e.target.value)} />
            </label>
            <label className="field">
              <span>Prefixo da fila do driver</span>
              <input className="mono" value={draft.driverQueuePrefix} onChange={(e) => set('driverQueuePrefix', e.target.value)} />
            </label>
            <label className="field">
              <span>Exchange de eventos</span>
              <input className="mono" value={draft.eventExchange} onChange={(e) => set('eventExchange', e.target.value)} />
            </label>
            <label className="field">
              <span>Fila de eventos do backend</span>
              <input className="mono" value={draft.eventQueue} onChange={(e) => set('eventQueue', e.target.value)} />
            </label>
            <label className="field">
              <span>Prefetch</span>
              <input type="number" min={1} max={100} value={draft.prefetch} onChange={(e) => set('prefetch', Number(e.target.value))} />
            </label>
          </div>
        </details>
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
        <span className="muted small">A API key e a senha ficam criptografadas para este usuário do Windows (DPAPI).</span>
      </div>
    </form>
  );
}
