import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Icon } from "@/lib/icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PluginBrowser } from "@/components/plugin-browser";
import { McpSection } from "@/components/mcp-section";
import {
  getPluginSettings,
  listAiModels,
  savePluginSettings,
  type AiModel,
  type CustomPlugin,
  type PluginConfigField,
} from "@/lib/api";

/** The Settings tabs, also used by the host to deep-link (e.g. "Browse plugins"). */
export type SettingsTab = "ai" | "connectors" | "plugins";

export interface SettingsViewProps {
  tab: SettingsTab;
  onTabChange: (tab: SettingsTab) => void;
  installedIds: string[];
  onInstall: (id: string) => void;
  onUninstall: (id: string) => void;
  /** Open a plugin's config + places dialog. */
  onConfigure: (id: string) => void;
  /** Open the "Build your own plugin with AI" page. */
  onBuildWithAI: () => void;
  /** The caller's Plugin Studio creations, listed under the Plugins tab. */
  customPlugins?: CustomPlugin[];
  /** Launch a custom app plugin. */
  onOpenCustom?: (id: string) => void;
  /** Uninstall a custom plugin. */
  onUninstallCustom?: (id: string) => void;
}

/**
 * Settings — the hub for user- and deployment-level configuration, and the home for
 * all plugin management since the standalone store sheet was retired. Three tabs:
 * **AI** (provider keys that feed the host AI gateway, plus AI plugins like Document
 * AI), **Connectors** (StorageConnectorPlugins that back a space — Synology, GitHub),
 * and **Plugins** (the full catalog browser — search, install, configure everything).
 */
export function SettingsView({
  tab,
  onTabChange,
  installedIds,
  onInstall,
  onUninstall,
  onConfigure,
  onBuildWithAI,
  customPlugins,
  onOpenCustom,
  onUninstallCustom,
}: SettingsViewProps) {
  const browserProps = { installedIds, onInstall, onUninstall, onConfigure };
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6">
      <div>
        <h1 className="text-[22px] font-semibold tracking-tight">Settings</h1>
        <p className="mt-0.5 text-[13px] text-muted-foreground">
          Configure the providers and plugins this account uses.
        </p>
      </div>

      <Tabs value={tab} onValueChange={(v) => onTabChange(v as SettingsTab)} className="gap-5">
        <TabsList variant="line" className="self-start">
          <TabsTrigger value="ai">AI</TabsTrigger>
          <TabsTrigger value="connectors">Connectors</TabsTrigger>
          <TabsTrigger value="plugins">Plugins</TabsTrigger>
        </TabsList>

        <TabsContent value="ai" className="flex flex-col gap-5">
          <AiModelsSection />
          <TabSection
            title="AI plugins"
            description="Plugins that run inference through the gateway above."
          >
            <PluginBrowser group="ai" {...browserProps} />
          </TabSection>
        </TabsContent>

        <TabsContent value="connectors" className="flex flex-col gap-5">
          <McpSection />
          <TabSection
            title="Connectors"
            description="Mount an external store as a space. Install one, then open its settings to add credentials and choose where it appears."
          >
            <PluginBrowser group="connector" {...browserProps} />
          </TabSection>
        </TabsContent>

        <TabsContent value="plugins" className="flex flex-col gap-3">
          <PluginBrowser
            {...browserProps}
            onBuildWithAI={onBuildWithAI}
            custom={customPlugins}
            onOpenCustom={onOpenCustom}
            onUninstallCustom={onUninstallCustom}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}

/** A titled block within a tab, used for the AI-plugins and Connectors lists. */
function TabSection({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3">
      <div>
        <h2 className="text-[15px] font-semibold">{title}</h2>
        <p className="text-[12.5px] text-muted-foreground">{description}</p>
      </div>
      {children}
    </section>
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
                title={m.description ? `${m.id}\n\n${m.description}` : m.id}
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
