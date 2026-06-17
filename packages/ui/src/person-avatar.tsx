import { cn } from "./utils";

const SIZES = { xs: 20, sm: 24, md: 28, lg: 32 } as const;

/** Stable accent per known first name (HSL triplet); others fall back to a neutral grey. */
const PERSON_COLOR: Record<string, string> = {
  Maya: "145 33% 36%",
  Daniel: "212 70% 48%",
  Lily: "327 60% 55%",
  Nora: "28 80% 55%",
  Alex: "265 50% 55%",
};

export function PersonAvatar({
  name,
  size = "sm",
  className,
}: {
  name: string;
  size?: keyof typeof SIZES;
  className?: string;
}) {
  const px = SIZES[size];
  const color = PERSON_COLOR[name] ?? "220 9% 46%";
  return (
    <span
      title={name}
      className={cn(
        "grid shrink-0 place-items-center rounded-full font-semibold text-white ring-2 ring-background",
        className,
      )}
      style={{
        width: px,
        height: px,
        background: `hsl(${color})`,
        fontSize: px * 0.4,
      }}
    >
      {name[0]}
    </span>
  );
}

export function AvatarGroup({ people, max = 3 }: { people: string[]; max?: number }) {
  if (people.length === 0) {
    return <span className="text-muted-foreground text-[13px]">Only you</span>;
  }
  const shown = people.slice(0, max);
  const overflow = people.length - shown.length;
  return (
    <div className="flex items-center">
      <div className="flex -space-x-1.5">
        {shown.map((p) => (
          <PersonAvatar key={p} name={p} size="sm" />
        ))}
        {overflow > 0 && (
          <span
            className="grid size-6 shrink-0 place-items-center rounded-full bg-secondary text-secondary-foreground text-[10px] font-semibold ring-2 ring-background"
            title={`+${overflow} more`}
          >
            +{overflow}
          </span>
        )}
      </div>
    </div>
  );
}
