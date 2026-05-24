import { useCallback, useEffect, useState } from "react";
import { Icon } from "@/lib/icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  getPluginSettings,
  listAiModels,
  savePluginSettings,
  type AiModel,
  type PluginConfigField,
} from "@/lib/api";

/**
 * Settings — a hub for user- and deployment-level configuration. Today it hosts the
 * **AI models** section: the provider keys a user adds (Gemini, an OpenAI-compatible
 * endpoint) feed the host AI gateway, and the models that result are what plugins
 * like Document AI can pick. Connectors, default plugins, and more belong here next.
 */
export function SettingsView() {
  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6">
      <div>
        <h1 className="text-[22px] font-semibold tracking-tight">Settings</h1>
        <p className="mt-0.5 text-[13px] text-muted-foreground">
          Configure the providers and plugins this account uses.
        </p>
      </div>
      <AiModelsSection />
    </div>
  );
}

/** Provider keys + the resulting available models. Stored encrypted, per user. */
function AiModelsSection() {
  const [fields, setFields] = useState<PluginConfigField[]>([]);
  const [values, setValues] = useState<Record<string, string>>({});
  const [secretsSet, setSecretsSet] = useState<string[]>([]);
  const [models, setModels] = useState<AiModel[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [settings, m] = await Promise.all([getPluginSettings("ai"), listAiModels()]);
    if (settings) {
      setFields(settings.fields);
      setValues(settings.values);
      setSecretsSet(settings.secretsSet);
    }
    setModels(m);
    setLoading(false);
  }, []);

  useEffect(() => {
    let alive = true;
    void load().catch(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [load]);

  const setValue = (key: string, v: string) => setValues((prev) => ({ ...prev, [key]: v }));

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const payload: Record<string, string> = {};
      for (const f of fields) payload[f.key] = values[f.key] ?? "";
      await savePluginSettings("ai", payload);
      await load(); // refresh the model list with whatever the new keys unlocked
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="flex flex-col gap-4 rounded-xl border bg-card p-5">
      <div className="flex items-center gap-3">
        <div className="grid size-10 place-items-center rounded-xl bg-primary/10 text-primary">
          <Icon name="sparkles" size={20} />
        </div>
        <div className="flex-1">
          <div className="text-[15px] font-semibold">AI models</div>
          <div className="text-[12.5px] text-muted-foreground">
            Add a provider key to make its models available to plugins. Keys are encrypted and
            never leave the server.
          </div>
        </div>
      </div>

      {/* Available models — what plugins can pick right now. */}
      <div className="flex flex-col gap-1.5">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Available models
        </span>
        {loading ? (
          <span className="text-[13px] text-muted-foreground">Loading…</span>
        ) : models.length === 0 ? (
          <span className="text-[13px] text-muted-foreground">
            None yet. On Cloudflare, Workers AI models appear automatically; otherwise add a key below.
          </span>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {models.map((m) => (
              <span
                key={m.id}
                className="inline-flex items-center gap-1.5 rounded-full border bg-background px-2.5 py-1 text-[12px]"
                title={m.id}
              >
                {m.label}
                <span className="text-muted-foreground">· {m.provider}</span>
                {m.vision && <Icon name="image" size={12} className="text-muted-foreground" />}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Provider keys. */}
      {!loading && (
        <form
          className="flex flex-col gap-3 border-t pt-4"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          {fields.map((f) => {
            const isSecret = f.type === "secret";
            const stored = isSecret && secretsSet.includes(f.key);
            return (
              <div key={f.key} className="flex flex-col gap-1.5">
                <label className="text-[12.5px] font-medium text-foreground">{f.label}</label>
                <Input
                  type={isSecret ? "password" : "text"}
                  value={values[f.key] ?? ""}
                  placeholder={stored ? "•••••••• (saved — leave blank to keep)" : undefined}
                  onChange={(e) => setValue(f.key, e.target.value)}
                  autoComplete={isSecret ? "off" : undefined}
                />
              </div>
            );
          })}
          {error && <p className="text-[12.5px] text-destructive">{error}</p>}
          <div className="flex justify-end">
            <Button type="submit" size="sm" disabled={saving}>
              {saving ? "Saving…" : "Save"}
            </Button>
          </div>
        </form>
      )}
    </section>
  );
}
