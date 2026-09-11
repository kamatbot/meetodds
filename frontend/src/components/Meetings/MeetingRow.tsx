'use client';

import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { Check, LoaderCircle, MoreHorizontal, Pencil, Star, Trash2 } from 'lucide-react';
import type { MeetingListItem } from '@/types/meeting';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';

interface Props { item: MeetingListItem; optionId: string; selected: boolean; selectMode: boolean; renaming: boolean; onSelect: (event: MouseEvent<HTMLDivElement>) => void; onOpen: () => void; onStartRename: () => void; onSaveRename: (title: string) => Promise<boolean>; onCancelRename: () => void; onToggleStar: () => void; onDelete: () => void; onContextMenu: (event: MouseEvent<HTMLDivElement>) => void }
function title(value: string) { const t = value.trim(); return !t || /^Meeting\s+\d{2}_\d{2}_\d{2}_\d{2}_\d{2}_\d{2}$/i.test(t) ? 'Untitled meeting' : t }
function duration(ms: number | null) { if (ms == null || !Number.isFinite(ms)) return '—'; const m = Math.max(1, Math.round(ms/60000)); return m < 60 ? `${m} min` : `${Math.floor(m/60)}h ${m%60 ? `${m%60}m` : ''}`.trim() }
function time(createdAt: string) { const d = new Date(createdAt); return Number.isNaN(d.getTime()) ? '—' : new Intl.DateTimeFormat(undefined,{hour:'numeric',minute:'2-digit'}).format(d) }
function status(status: MeetingListItem['summaryStatus']) { return status === 'ready' ? ['Summarised','text-success'] : status === 'generating' ? ['Generating…','text-warn'] : status === 'failed' ? ['Summary failed','text-danger'] : ['No summary','text-3'] }

export default function MeetingRow(props: Props) {
  const { item } = props; const [draft,setDraft] = useState(item.title); const [saving,setSaving] = useState(false); const inputRef=useRef<HTMLInputElement>(null);
  useEffect(()=>{ if(props.renaming){ setDraft(item.title); requestAnimationFrame(()=>{inputRef.current?.focus();inputRef.current?.select()})}},[item.title,props.renaming]);
  const saveRename=async()=>{ if(saving)return; const v=draft.trim(); if(!v||v===item.title){props.onCancelRename();return} setSaving(true); const saved=await props.onSaveRename(v); setSaving(false); if(!saved) requestAnimationFrame(()=>inputRef.current?.focus()) };
  const [statusText,statusTone]=status(item.summaryStatus);
  return <div id={props.optionId} role="option" aria-selected={props.selected} data-meeting-id={item.id} onClick={props.onSelect} onDoubleClick={e=>{e.preventDefault();e.stopPropagation();props.onStartRename()}} onContextMenu={props.onContextMenu} className={`group grid h-full min-w-0 cursor-default grid-cols-[24px_minmax(130px,1fr)_100px_96px_28px] items-center gap-2 px-3 transition-colors ${props.selected?'bg-accent-soft':'bg-panel hover:bg-[var(--hover)]'}`}>
    <button type="button" className={`inline-grid h-6 w-6 place-items-center rounded-[7px] ${item.starred?'text-accent':'text-3 hover:text-text'}`} aria-label={item.starred?'Unstar meeting':'Star meeting'} onClick={e=>{e.stopPropagation();props.onToggleStar()}}>{props.selectMode&&props.selected?<span className="inline-grid h-4 w-4 place-items-center rounded-[4px] bg-accent text-accent-foreground"><Check className="h-3 w-3" /></span>:<Star className="h-3.5 w-3.5" fill={item.starred?'currentColor':'none'} />}</button>
    <div className="min-w-0">{props.renaming?<input ref={inputRef} value={draft} disabled={saving} onClick={e=>e.stopPropagation()} onChange={e=>setDraft(e.target.value)} onBlur={()=>void saveRename()} onKeyDown={e=>{if(e.key==='Enter')void saveRename();if(e.key==='Escape'){setDraft(item.title);props.onCancelRename()}}} className="h-7 w-full rounded-[8px] border border-accent bg-panel px-2 text-[12px] font-semibold outline-none" />:<span className="block truncate text-[12.5px] font-semibold text-text">{title(item.title)}</span>}</div>
    <span className={`text-[10.5px] font-medium ${statusTone}`}>{item.summaryStatus==='generating'&&<LoaderCircle className="mr-1 inline h-3 w-3 animate-spin" />}{statusText}</span>
    <span className="text-right font-mono text-[9.5px] leading-4 text-3"><span className="block">{time(item.createdAt)}</span><span className="block">{duration(item.durationMs)}</span></span>
    <DropdownMenu><DropdownMenuTrigger asChild><button type="button" onClick={e=>e.stopPropagation()} className="inline-grid h-7 w-7 place-items-center rounded-[8px] text-3 opacity-0 hover:bg-panel-2 hover:text-text focus:opacity-100 group-hover:opacity-100" aria-label={`Actions for ${title(item.title)}`}><MoreHorizontal className="h-4 w-4" /></button></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuItem onSelect={props.onOpen}>Open</DropdownMenuItem><DropdownMenuItem onSelect={props.onStartRename}><Pencil/>Rename</DropdownMenuItem><DropdownMenuItem onSelect={props.onToggleStar}><Star/>{item.starred?'Unstar':'Star'}</DropdownMenuItem><DropdownMenuSeparator/><DropdownMenuItem onSelect={props.onDelete} className="text-danger"><Trash2/>Delete</DropdownMenuItem></DropdownMenuContent></DropdownMenu>
  </div>;
}
