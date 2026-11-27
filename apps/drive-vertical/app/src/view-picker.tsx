import { Button, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger, Icon } from '@canopy/ui';
import { FOLDERS_VIEW } from '../../src/space-settings';
import type { SpaceViews } from './space-views';

/** The value the radio group holds for "whatever the space's default is". */
const DEFAULT_CHOICE = '\u0000default';

/**
 * How a person looks at the space: its folders or one of its saved views. Their pick is their
 * own; "Space default" hands the choice back to what the owners set.
 */
export function ViewPicker({ spaceViews, choice, active, onChoose, onEdit }: {
  spaceViews: SpaceViews;
  /** The person's own pick: a view id, `folders`, or null for the space default. */
  choice: string | null;
  /** The view on screen, or null for the folders. */
  active: string | null;
  onChoose: (choice: string | null) => void;
  /** Owners only: open the settings where views are made. */
  onEdit?: () => void;
}) {
  const nameOf = (id: string | null) => id ? spaceViews.views.find(view => view.id === id)?.name ?? 'Folders' : 'Folders';
  const pick = choice === FOLDERS_VIEW || spaceViews.views.some(view => view.id === choice) ? choice! : DEFAULT_CHOICE;
  return <DropdownMenu>
    <DropdownMenuTrigger asChild>
      <Button variant={active ? 'secondary' : 'outline'} size="sm" className="gap-1.5" aria-label={`View: ${nameOf(active)}`} title="Choose how to see this space">
        <Icon name={active ? 'board' : 'folder'} className="size-4" />
        <span className="hidden max-w-[10rem] truncate sm:inline">{nameOf(active)}</span>
        <Icon name="chevron-down" className="size-3.5" />
      </Button>
    </DropdownMenuTrigger>
    <DropdownMenuContent align="end" className="w-60">
      <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Your view of this space</DropdownMenuLabel>
      <DropdownMenuRadioGroup value={pick} onValueChange={value => onChoose(value === DEFAULT_CHOICE ? null : value)}>
        <DropdownMenuRadioItem value={DEFAULT_CHOICE}>Space default · {nameOf(spaceViews.defaultView)}</DropdownMenuRadioItem>
        <DropdownMenuSeparator />
        <DropdownMenuRadioItem value={FOLDERS_VIEW}>Folders</DropdownMenuRadioItem>
        {spaceViews.views.map(view => <DropdownMenuRadioItem key={view.id} value={view.id}>{view.name}</DropdownMenuRadioItem>)}
      </DropdownMenuRadioGroup>
      {onEdit ? <>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onEdit}><Icon name="settings" className="size-4" />Edit views…</DropdownMenuItem>
      </> : null}
    </DropdownMenuContent>
  </DropdownMenu>;
}
