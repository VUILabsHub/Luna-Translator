import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import ShellProviders from '@simultrans/ui-shared/src/shell/ShellProviders'
import { usePublicConfig } from '@simultrans/ui-shared/src/lib/config'
import MultilingualShowcasePage from './pages/MultilingualShowcasePage'
import ConsumerGate from './pages/ConsumerGate'
import ConsumerHistoryPage from './pages/ConsumerHistoryPage'
import ConsumerSettingsPage from './pages/ConsumerSettingsPage'
import { SharedSessionPage } from './pages/SharedSessionPage'
import { CommunityAudioProvider } from './components/CommunityAudioInput'
import { AIConsentHost } from './components/AIConsentHost'
import '@simultrans/ui-shared/src/styles/base.css'
import '@simultrans/ui-shared/src/styles/workspace.css'
import '@simultrans/ui-shared/src/styles/history.css'
import '@simultrans/ui-shared/src/styles/animations.css'
import '@simultrans/ui-shared/src/styles/responsive.css'
import '@simultrans/ui-shared/src/styles/shell.css'
import './styles/root-scale.css'
import './styles/showcase.css'
import './styles/showcase-multilingual.css'
import './styles/consumer-page.css'
import './styles/canary-design.css'
import './styles/viewport-fit.css'
import './styles/canary-typography.css'
import './styles/community.css'
void Promise.all([import('@fontsource/poppins/400.css'),import('@fontsource/poppins/500.css'),import('@fontsource/poppins/600.css'),import('@fontsource-variable/noto-sans-sc/wght.css'),import('@fontsource-variable/noto-serif-sc/wght.css')])
function App(){
 const {config,loadFailed}=usePublicConfig()
 if(!config)return <p role="status">{loadFailed?'后端连接失败，请检查容器健康状态':'正在加载工作区…'}</p>
 const path=window.location.pathname.replace(/\/+$/,'')||'/'
 const share=path.match(/^\/s\/([a-f0-9]+)$/)
 const history=path.match(/^\/history\/([a-f0-9]+)$/)
 const mode=config as typeof config&{demo?:boolean;sourceAsrConfigured?:boolean}
 const page=share?<SharedSessionPage token={share[1]}/>:<ConsumerGate>{path==='/history'||history?<ConsumerHistoryPage id={history?.[1]}/>:path==='/settings'?<ConsumerSettingsPage/>:path==='/'?<MultilingualShowcasePage/>:<main className="community-settings"><h1>此功能不在社区首版范围</h1><a href="/">返回同传</a></main>}</ConsumerGate>
 return <><div className="community-banner">Luna Translator 社区版 · {mode.demo?'模拟体验：固定示例字幕与提示音，不识别或翻译实际语音':'模型由此部署配置的外部服务提供'}{!mode.demo&&!mode.sourceAsrConfigured?' · 未配置独立 ASR 时，Luna 原文字幕不可用':''}</div><div className="global-shell is-showcase"><main className="global-main global-main--without-subnav">{page}</main><AIConsentHost/></div></>
}
createRoot(document.getElementById('root')!).render(<StrictMode><ShellProviders section="showcase"><CommunityAudioProvider><App/></CommunityAudioProvider></ShellProviders></StrictMode>)
