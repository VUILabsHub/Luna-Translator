import { useState, useEffect, type ReactNode } from 'react'
import { communitySignIn, isLoggedIn, subscribeConsumerSession } from '@simultrans/ui-shared/src/lib/consumerSession'
export default function ConsumerGate({children}:{children:ReactNode}) {
 const [signedIn,setSignedIn]=useState(isLoggedIn)
 const [password,setPassword]=useState('')
 const [error,setError]=useState('')
 const [busy,setBusy]=useState(false)
 useEffect(()=>subscribeConsumerSession(()=>setSignedIn(isLoggedIn())),[])
 if(signedIn)return <>{children}</>
 return <main className="community-login"><form onSubmit={async event=>{event.preventDefault();if(busy)return;setBusy(true);try{if(await communitySignIn(password)){setSignedIn(true);setPassword('')}else setError('部署密码不正确')}catch{setError('无法连接后端，请稍后重试')}finally{setBusy(false)}}}>
 <h1>Luna Translator</h1><p>登录您自己部署的社区版工作区</p><label htmlFor="deployment-password">部署密码</label><input id="deployment-password" type="password" autoComplete="current-password" required value={password} onChange={e=>setPassword(e.target.value)} />
 <button disabled={busy}>{busy?'正在登录…':'进入工作区'}</button>{error&&<p role="alert">{error}</p>}<p>首次启动后运行 <code>docker compose exec backend cat /data/admin-password</code> 查看自动生成的密码。</p><a href="/welcome/">产品介绍</a></form></main>
}
