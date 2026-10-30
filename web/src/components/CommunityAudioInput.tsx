import { createContext, useContext, useMemo, useState, type ReactNode } from 'react'
import { wavToPCM16Mono16k } from '../lib/backfillAudio'

export const CommunityAudioContext = createContext<{pcm:Int16Array|null;busy:boolean;setBusy:(busy:boolean)=>void}>({pcm:null,busy:false,setBusy:()=>undefined})
export function CommunityAudioProvider({children}:{children:ReactNode}){
 const [pcm,setPCM]=useState<Int16Array|null>(null)
 const [busy,setBusy]=useState(false)
 const [name,setName]=useState('')
 const [error,setError]=useState('')
 const value=useMemo(()=>({pcm,busy,setBusy}),[pcm,busy])
 return <CommunityAudioContext.Provider value={value}>{window.location.pathname==='/'&&<div className="community-audio-input"><label>音频输入 <select aria-label="社区版音频输入" disabled={busy} value={pcm?'file':'microphone'} onChange={()=>{setPCM(null);setName('')}}><option value="microphone">麦克风</option>{pcm&&<option value="file">WAV 文件</option>}</select></label><label>或选择 WAV 文件 <input aria-label="选择 WAV 测试音频" type="file" accept=".wav,audio/wav" disabled={busy} onChange={async e=>{const file=e.target.files?.[0];if(!file)return;try{if(file.size>20*1024*1024)throw new Error('文件不能超过 20 MiB');const next=wavToPCM16Mono16k(new Uint8Array(await file.arrayBuffer()));if(!next.length)throw new Error('音频为空');setPCM(next);setName(file.name);setError('')}catch(err){setPCM(null);setError(err instanceof Error?err.message:'无法读取音频')}}}/></label>{name&&<span role="status">已选择 {name}，点击开始同传后按实时速度发送，不使用麦克风。</span>}{error&&<span role="alert">{error}</span>}</div>}{children}</CommunityAudioContext.Provider>
}
