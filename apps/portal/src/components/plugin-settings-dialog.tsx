import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { getPluginSettings, savePluginSettings, type PluginConfigField } from "@/lib/api";

/**
 * Generic, schema-driven settings dialog for a source plugin. Renders fields from
 * the server's config schema (text / url / secret / boolean). Secret values are
 * never sent to the client — a stored secret shows as "set"; leaving it blank
 * keeps the existing value.
 */
export function PluginSettingsDialog({
  pluginId,
  pluginName,
  open,
  onOpenChange,
  onSaved,
}: {
  pluginId: string;
  pluginName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved?: () => void;
}) {
  const [fields, setFields] = useState<PluginConfigField[]>([]);
  const [values, setValues] = useState<Record<string, string>>({});
  const [secretsSet, setSecretsSet] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setLoading(true);
    setError(null);
    getPluginSettings(pluginId)
      .then((s) => {
        if (!alive || !s) return;
        setFields(s.fields);
        setValues(s.values);
        setSecretsSet(s.secretsSet);
      })
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [open, pluginId]);

  const setValue = (key: string, v: string) => setValues((prev) => ({ ...prev, [key]: v }));

  async function save() {
    setSaving(true);
    setError(null);
    try {
      // Send every field; the server treats an empty secret as "keep existing".
      const payload: Record<string, string> = {};
      for (const f of fields) payload[f.key] = values[f.key] ?? "";
      await savePluginSettings(pluginId, payload);
      onSaved?.();
      onOpenChange(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[460px]">
        <DialogHeader>
          <DialogTitle>{pluginName} settings</DialogTitle>
        </DialogHeader>

        {loading ? (
          <div className="py-6 text-center text-[13px] text-muted-foreground">Loading…</div>
        ) : (
          <form
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            {fields.map((f) => {
              if (f.type === "boolean") {
                return (
                  <label key={f.key} className="flex items-center gap-2.5 text-[13.5px]">
                    <Checkbox
                      checked={values[f.key] === "true"}
                      onCheckedChange={(v) => setValue(f.key, v ? "true" : "false")}
                    />
                    {f.label}
                  </label>
                );
              }
              const isSecret = f.type === "secret";
              const stored = isSecret && secretsSet.includes(f.key);
              return (
                <div key={f.key} className="flex flex-col gap-1.5">
                  <label className="text-[12.5px] font-medium text-foreground">
                    {f.label}
                    {f.required && <span className="ml-1 text-destructive">*</span>}
                  </label>
                  <Input
                    type={isSecret ? "password" : f.type === "url" ? "text" : "text"}
                    value={values[f.key] ?? ""}
                    placeholder={stored ? "•••••••• (saved — leave blank to keep)" : undefined}
                    onChange={(e) => setValue(f.key, e.target.value)}
                    autoComplete={isSecret ? "off" : undefined}
                  />
                </div>
              );
            })}

            {error && <p className="text-[12.5px] text-destructive">{error}</p>}

            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" size="sm" disabled={saving}>
                {saving ? "Saving…" : "Save"}
              </Button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
