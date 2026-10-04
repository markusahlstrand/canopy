import { useState } from 'react';
import { Icon, Popover, PopoverContent, PopoverTrigger, cn } from '@canopy/ui';
import { SPACE_ICONS, SPACE_COLORS } from '../../src/space-settings';

/** The icon and color picker used by both creation and settings, like the old portal. */
export function SpaceStyleFields({icon, color, disabled, onIcon, onColor}: {icon:string;color:string;disabled?:boolean;onIcon:(icon:string)=>void;onColor:(color:string)=>void}) {
  const [open, setOpen] = useState(false);
  return <div className="flex items-center gap-2.5">
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" disabled={disabled} aria-label="Choose space icon and color"
          className="grid size-10 shrink-0 place-items-center rounded-lg ring-1 ring-inset ring-border transition hover:ring-2 disabled:opacity-50"
          style={{ backgroundColor: `${color}24`, color }}>
          <Icon name={icon} size={20} />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-3">
        <p className="mb-2 text-xs font-medium text-muted-foreground">Space icon</p>
        <div role="group" aria-label="Space icon" className="mb-3 grid grid-cols-6 gap-1.5">
          {SPACE_ICONS.map(candidate => <button key={candidate} type="button" aria-label={`Icon ${candidate}`} aria-pressed={icon === candidate}
            onClick={() => onIcon(candidate)}
            className={cn('grid size-8 place-items-center rounded-md text-muted-foreground hover:bg-accent', icon === candidate && 'bg-accent text-foreground ring-1 ring-border')}>
            <Icon name={candidate} size={17} />
          </button>)}
        </div>
        <p className="mb-2 text-xs font-medium text-muted-foreground">Space color</p>
        <div role="group" aria-label="Space color" className="flex flex-wrap gap-2">
          {SPACE_COLORS.map(candidate => <button key={candidate} type="button" aria-label={`Color ${candidate}`} aria-pressed={color === candidate}
            onClick={() => onColor(candidate)}
            className={cn('size-7 rounded-full ring-offset-2 ring-offset-popover transition', color === candidate && 'ring-2 ring-foreground')}
            style={{ backgroundColor: candidate }} />)}
        </div>
      </PopoverContent>
    </Popover>
    <span className="text-xs text-muted-foreground">Choose an icon and color for this space</span>
  </div>;
}
