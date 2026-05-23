import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Icon } from "@/lib/icons";
import {
  applySpacePlugin,
  getPluginPlaces,
  getPluginSettings,
  removeSpacePlugin,
  savePluginSettings,
  type PluginConfigField,
  type PluginPlace,
} from "@/lib/api";

/**
 * Generic, schema-driven settings dialog for a plugin. Renders config fields from
 * the server's schema (text / url / secret / boolean; secret values are never sent
 * to the client — a stored secret shows as "set", and leaving it blank keeps the
 * existing value) plus an "Applies to places" picker: the group spaces the caller
 * owns, where applying turns the plugin on for everyone in that place.
 */
export function PluginSettingsDialog({
  pluginId,
  pluginName,
  open,
  onOpenChange,
  onSaved,
  onPlacesChanged,
}: {
  pluginId: string;
  pluginName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved?: () => void;
  /** Called after a place toggle, so the host can refresh its active-plugin set. */
  onPlacesChanged?: () => void;
}) {
  const [fields, setFields] = useState<PluginConfigField[]>([]);
  const [values, setValues] = useState<Record<string, string>>({});
  const [secretsSet, setSecretsSet] = useState<string[]>([]);
  const [places, setPlaces] = useState<PluginPlace[]>([]);
  const [placeBusy, setPlaceBusy] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setLoading(true);
    setError(null);
    Promise.all([getPluginSettings(pluginId), getPluginPlaces(pluginId)])
      .then(([s, p]) => {
        if (!alive) return;
        if (s) {
          setFields(s.fields);
          setValues(s.values);
          setSecretsSet(s.secretsSet);
        }
        setPlaces(p);
      })
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [open, pluginId]);

  async function togglePlace(place: PluginPlace) {
    setPlaceBusy(place.spaceId);
    setError(null);
    try {
      if (place.applied) await removeSpacePlugin(place.spaceId, pluginId);
      else await applySpacePlugin(place.spaceId, pluginId);
      setPlaces((prev) =>
        prev.map((p) => (p.spaceId === place.spaceId ? { ...p, applied: !p.applied } : p)),
      );
      onPlacesChanged?.();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPlaceBusy(null);
    }
  }

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
            {fields.length === 0 && places.length === 0 && (
              <p className="text-[13px] text-muted-foreground">This plugin has no settings to configure.</p>
            )}
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

            {places.length > 0 && (
              <div className="flex flex-col gap-2 border-t pt-4">
                <div className="flex flex-col gap-0.5">
                  <span className="text-[12.5px] font-medium text-foreground">Applies to places</span>
                  <span className="text-[12px] text-muted-foreground">
                    Turn this plugin on for a shared space — everyone in it gets it. Only spaces you own
                    are listed.
                  </span>
                </div>
                {places.map((p) => (
                  <label
                    key={p.spaceId}
                    className="flex items-center gap-2.5 rounded-lg border px-2.5 py-2 text-[13.5px]"
                  >
                    <Checkbox
                      checked={p.applied}
                      disabled={placeBusy === p.spaceId}
                      onCheckedChange={() => void togglePlace(p)}
                    />
                    <Icon name="users" size={15} className="text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate">{p.name}</span>
                    {placeBusy === p.spaceId && <span className="text-[11px] text-muted-foreground">…</span>}
                  </label>
                ))}
              </div>
            )}

            {error && <p className="text-[12.5px] text-destructive">{error}</p>}

            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
                {fields.length > 0 ? "Cancel" : "Close"}
              </Button>
              {fields.length > 0 && (
                <Button type="submit" size="sm" disabled={saving}>
                  {saving ? "Saving…" : "Save"}
                </Button>
              )}
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
