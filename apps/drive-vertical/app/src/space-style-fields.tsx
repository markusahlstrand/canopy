import { SPACE_ICONS, SPACE_COLORS } from '../../src/space-settings';
export function SpaceStyleFields({icon, color, disabled, onIcon, onColor}: {icon:string;color:string;disabled?:boolean;onIcon:(icon:string)=>void;onColor:(color:string)=>void}) {
  return <div className="flex gap-4"><label>Space icon<select aria-label="Space icon" disabled={disabled} value={icon} onChange={event => onIcon(event.target.value)}>{SPACE_ICONS.map(icon => <option key={icon}>{icon}</option>)}</select></label><label>Space color<select aria-label="Space color" disabled={disabled} value={color} onChange={event => onColor(event.target.value)}>{SPACE_COLORS.map((color, index) => <option key={color} value={color}>{['Blue','Green','Amber','Red','Purple','Slate'][index]}</option>)}</select></label></div>;
}
