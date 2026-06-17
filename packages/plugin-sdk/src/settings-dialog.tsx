import { useEffect, useState } from "react";
import {
  Button,
  Checkbox,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  Icon,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@canopy/ui";
import { usePluginHost } from "./context";
import type { PluginConfigField, PluginPlace } from "./settings";

/**
 * Seed a `showWhen` controller (e.g. a connection "mode") for an *existing* config
 * that predates it: if a gated field already has a value but its controller is
 * unset, default the controller to that field's first matching value so the saved
 * inputs stay visible. New configs start with the controller unset (the user picks
 * it, then the relevant fields appear).
 */
function withInferredControllers(
  fields: PluginConfigField[],
  values: Record<string, string>,
  secretsSet: string[],
): Record<string, string> {
  const out = { ...values };
  for (const f of fields) {
    if (!f.showWhen) continue;
    const controller = f.showWhen.field;
    if (out[controller]) continue; // already set
    const hasData = (out[f.key] != null && out[f.key] !== "") || secretsSet.includes(f.key);
    if (hasData && f.showWhen.in[0]) out[controller] = f.showWhen.in[0];
  }
  return out;
}

/**
 * Generic, schema-driven settings dialog for a plugin. Renders config fields from
 * the server's schema (text / url / secret / boolean; secret values are never sent
 * to the client — a stored secret shows as "set", and leaving it blank keeps the
 * existing value) plus an "Applies to places" picker: the group spaces the caller
 * owns, where applying turns the plugin on for everyone in that place.
 *
 * Lives in the SDK and reaches settings I/O through {@link usePluginHost}, so any
 * plugin can offer settings without importing app internals.
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
  const host = usePluginHost();
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
    Promise.all([host.getPluginSettings(pluginId), host.getPluginPlaces(pluginId)])
      .then(([s, p]) => {
        if (!alive) return;
        if (s) {
          setFields(s.fields);
          setValues(withInferredControllers(s.fields, s.values, s.secretsSet));
          setSecretsSet(s.secretsSet);
        } else {
          // No settings for this plugin: clear any state held over from a previous
          // pluginId so stale fields/values can't be submitted under the new id.
          setFields([]);
          setValues({});
          setSecretsSet([]);
        }
        setPlaces(p);
      })
      .catch((e) => alive && setError((e as Error).message))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [open, pluginId, host]);

  async function togglePlace(place: PluginPlace) {
    setPlaceBusy(place.spaceId);
    setError(null);
    try {
      if (place.applied) await host.removeSpacePlugin(place.spaceId, pluginId);
      else await host.applySpacePlugin(place.spaceId, pluginId);
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

  /** Whether a field shows given the current values (its `showWhen` controller). */
  const visible = (f: PluginConfigField) => !f.showWhen || f.showWhen.in.includes(values[f.showWhen.field] ?? "");

  async function save() {
    setSaving(true);
    setError(null);
    try {
      // Visible fields save their value. A field hidden by its mode is cleared
      // (send ""), so switching modes never leaves a stale value that would change
      // behavior; the server keeps an empty secret, so hidden secrets are untouched.
      const payload: Record<string, string> = {};
      for (const f of fields) payload[f.key] = visible(f) ? (values[f.key] ?? "") : "";
      await host.savePluginSettings(pluginId, payload);
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
            {fields.filter(visible).map((f) => {
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
              if (f.type === "select") {
                const options = f.options ?? [];
                return (
                  <div key={f.key} className="flex flex-col gap-1.5">
                    <label className="text-[12.5px] font-medium text-foreground">
                      {f.label}
                      {f.required && <span className="ml-1 text-destructive">*</span>}
                    </label>
                    {options.length === 0 ? (
                      <p className="text-[12.5px] text-muted-foreground">
                        No AI models available — configure a provider on the server (or deploy on
                        Cloudflare to use Workers AI).
                      </p>
                    ) : (
                      <Select value={values[f.key] || undefined} onValueChange={(v) => setValue(f.key, v)}>
                        <SelectTrigger className="w-full">
                          <SelectValue placeholder="Auto — first available" />
                        </SelectTrigger>
                        <SelectContent>
                          {options.map((o) => (
                            <SelectItem key={o.value} value={o.value}>
                              {o.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                  </div>
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
                    type={isSecret ? "password" : f.type === "url" ? "url" : "text"}
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
