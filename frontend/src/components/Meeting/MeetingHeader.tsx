'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { invoke } from '@tauri-apps/api/core';
import { FolderOpen, MoreHorizontal, Pencil, Star, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { useSidebar } from '@/components/Sidebar/SidebarProvider';
import ShareMenu from '@/components/Meeting/ShareMenu';
import type { DeferredDeleteResponse, MeetingListPage } from '@/types/meeting';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';

export type MeetingDetailTab = 'summary' | 'notes' | 'transcript';
interface Props { meetingId:string; title:string; createdAt:string; activeTab:MeetingDetailTab; onTabChange:(tab:MeetingDetailTab)=>void; onTitleSaved:(title:string)=>void; onDeleted:()=>void }
const tabs:Array<{id:MeetingDetailTab;label:string;shortcut:string}>=[{id:'summary',label:'Summary',shortcut:'⌃1'},{id:'notes',label:'Notes',shortcut:'⌃2'},{id:'transcript',label:'Transcript',shortcut:'⌃3'}];
function isEditableTarget(target:EventTarget|null){return target instanceof HTMLElement&&(target.isContentEditable||Boolean(target.closest('input,textarea,select,[contenteditable="true"]')))}
function formatCreatedAt(value:string){const d=new Date(value);return Number.isNaN(d.getTime())?'Date unavailable':new Intl.DateTimeFormat(undefined,{weekday:'short',month:'short',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit'}).format(d)}
function formatDuration(ms:number|null){if(ms==null||!Number.isFinite(ms))return null;const m=Math.max(1,Math.round(ms/60000));return m<60?`${m} min`:`${Math.floor(m/60)}h${m%60?` ${m%60}m`:''}`}

export default function MeetingHeader({meetingId,title,createdAt,activeTab,onTabChange,onTitleSaved,onDeleted}:Props){
  const {currentMeeting,setCurrentMeeting,meetings,setMeetings,refetchMeetings}=useSidebar();
  const inputRef=useRef<HTMLInputElement>(null); const cancelBlur=useRef(false); const [savedTitle,setSavedTitle]=useState(title); const [draftTitle,setDraftTitle]=useState(title); const [editing,setEditing]=useState(false); const [saving,setSaving]=useState(false); const [starred,setStarred]=useState(false); const [starLoaded,setStarLoaded]=useState(false); const [durationMs,setDurationMs]=useState<number|null>(null); const [centerHost,setCenterHost]=useState<Element|null>(null); const [trailingHost,setTrailingHost]=useState<Element|null>(null);
  useEffect(()=>{setCenterHost(document.querySelector('[data-meetodds-toolbar-center]'));setTrailingHost(document.querySelector('[data-meetodds-toolbar-trailing]'))},[]);
  useEffect(()=>{setSavedTitle(title);setDraftTitle(title)},[meetingId,title]);
  useEffect(()=>{let cancelled=false;setStarLoaded(false);void invoke<MeetingListPage>('api_list_meetings',{request:{limit:100,query:title,sort:'newest'}}).then(page=>{if(cancelled)return;const item=page.items.find(x=>x.id===meetingId);if(item){setStarred(item.starred);setDurationMs(item.durationMs)}}).catch(()=>{}).finally(()=>{if(!cancelled)setStarLoaded(true)});return()=>{cancelled=true}},[meetingId,title]);
  const beginRename=()=>{setEditing(true);requestAnimationFrame(()=>{inputRef.current?.focus();inputRef.current?.select()})};
  useEffect(()=>{const key=(e:KeyboardEvent)=>{if(isEditableTarget(e.target))return;if(e.metaKey&&e.shiftKey&&e.key.toLowerCase()==='r'){e.preventDefault();beginRename();return}if(e.ctrlKey&&!e.metaKey&&['1','2','3'].includes(e.key)){e.preventDefault();onTabChange(tabs[Number(e.key)-1].id)}};window.addEventListener('keydown',key);return()=>window.removeEventListener('keydown',key)},[onTabChange]);
  const saveTitle=async()=>{if(cancelBlur.current){cancelBlur.current=false;return}const next=draftTitle.trim();if(!next){setDraftTitle(savedTitle);setEditing(false);toast.error('Meeting title cannot be empty');return}if(next===savedTitle){setEditing(false);return}setSaving(true);try{await invoke('api_rename_meeting',{meetingId,title:next});setSavedTitle(next);setDraftTitle(next);setEditing(false);setMeetings(meetings.map(m=>m.id===meetingId?{...m,title:next}:m));if(currentMeeting?.id===meetingId)setCurrentMeeting({id:meetingId,title:next});onTitleSaved(next);await refetchMeetings()}catch(e){setDraftTitle(savedTitle);toast.error('Could not rename meeting',{description:e instanceof Error?e.message:String(e)})}finally{setSaving(false)}};
  const toggleStar=async()=>{if(!starLoaded)return;const next=!starred;setStarred(next);try{await invoke('api_set_meeting_starred',{meetingId,starred:next});await refetchMeetings()}catch{setStarred(!next);toast.error('Could not update starred state')}};
  const deleteMeeting=async()=>{try{await invoke<DeferredDeleteResponse>('api_defer_delete_meeting',{meetingId});await refetchMeetings();onDeleted();toast('Meeting deleted',{duration:8000,action:{label:'Undo',onClick:()=>void invoke('api_restore_meeting',{meetingId}).then(()=>refetchMeetings())}})}catch(e){toast.error('Could not delete meeting',{description:String(e)})}};
  const openFolder=async()=>{try{await invoke('open_meeting_folder',{meetingId})}catch(e){toast.error('Could not open meeting folder',{description:String(e)})}};
  const duration=formatDuration(durationMs);
  const tabControl=<div data-toolbar-center-active className="flex items-center rounded-[10px] border border-border bg-panel-2 p-[2px]">{tabs.map(tab=><button key={tab.id} type="button" role="tab" aria-selected={activeTab===tab.id} onClick={()=>onTabChange(tab.id)} className={`h-7 rounded-[8px] px-3 text-[11px] font-semibold transition ${activeTab===tab.id?'bg-panel text-text shadow-[0_1px_2px_rgba(24,18,12,.08)]':'text-3 hover:text-text'}`}>{tab.label}<span className="ml-1.5 font-mono text-[8px] text-3">{tab.shortcut}</span></button>)}</div>;
  const trailing=<div className="flex items-center gap-1"><ShareMenu meetingId={meetingId}/><DropdownMenu><DropdownMenuTrigger asChild><button type="button" className="inline-grid h-8 w-8 place-items-center rounded-[9px] text-2 hover:bg-[var(--hover)]" aria-label="More meeting actions"><MoreHorizontal className="h-4 w-4"/></button></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuItem onSelect={beginRename}><Pencil/>Rename</DropdownMenuItem><DropdownMenuItem disabled={!starLoaded} onSelect={()=>void toggleStar()}><Star/>{starred?'Unstar':'Star'}</DropdownMenuItem><DropdownMenuSeparator/><DropdownMenuItem onSelect={()=>void deleteMeeting()} className="text-danger"><Trash2/>Delete</DropdownMenuItem></DropdownMenuContent></DropdownMenu></div>;
  return <>
    {centerHost&&createPortal(tabControl,centerHost)}{trailingHost&&createPortal(trailing,trailingHost)}
    <header className="shrink-0 bg-bg"><div className="mx-auto flex w-full max-w-[760px] items-start gap-4 px-6 pb-5 pt-7">
      <div className="min-w-0 flex-1">{editing?<input ref={inputRef} value={draftTitle} disabled={saving} onChange={e=>setDraftTitle(e.target.value)} onBlur={()=>void saveTitle()} onKeyDown={e=>{if(e.key==='Enter'){e.preventDefault();inputRef.current?.blur()}if(e.key==='Escape'){e.preventDefault();cancelBlur.current=true;setDraftTitle(savedTitle);setEditing(false);inputRef.current?.blur()}}} className="h-10 w-full rounded-[10px] border border-accent bg-panel px-3 text-[22px] font-semibold tracking-[-.03em] outline-none"/>:<button type="button" onClick={beginRename} className="group flex min-w-0 max-w-full items-center gap-2 text-left"><h1 className="truncate text-[25px] font-semibold tracking-[-.035em] text-text">{savedTitle||'Untitled meeting'}</h1><Pencil className="h-3.5 w-3.5 shrink-0 text-3 opacity-0 group-hover:opacity-100"/></button>}
      <p className="mt-1.5 font-mono text-[10.5px] text-3">{formatCreatedAt(createdAt)}{duration?` · ${duration}`:''}</p></div>
      <div className="flex shrink-0 items-center gap-1.5"><button type="button" onClick={()=>void toggleStar()} disabled={!starLoaded} className={`inline-grid h-9 w-9 place-items-center rounded-[10px] border border-border bg-panel ${starred?'text-accent':'text-3'}`} aria-label={starred?'Unstar':'Star'}><Star className="h-4 w-4" fill={starred?'currentColor':'none'}/></button><button type="button" onClick={()=>void openFolder()} className="inline-flex h-9 items-center gap-1.5 rounded-[10px] border border-border bg-panel px-3 text-[11px] font-medium text-text hover:bg-[var(--hover)]"><FolderOpen className="h-3.5 w-3.5"/>Open folder</button></div>
    </div></header>
  </>;
}
