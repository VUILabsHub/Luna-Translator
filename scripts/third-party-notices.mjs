import fs from 'node:fs'
import path from 'node:path'
const lock=JSON.parse(fs.readFileSync('package-lock.json','utf8'))
fs.mkdirSync('licenses',{recursive:true})
for(const f of fs.readdirSync('licenses'))if(f!=='gorilla-websocket.txt')fs.unlinkSync(path.join('licenses',f))
const rows=[]
const seen=new Set()
for(const [location,meta] of Object.entries(lock.packages)){
 if(!location.includes('node_modules/')||meta.dev||meta.link)continue
 const name=location.split('node_modules/').at(-1)
 const key=`${name}@${meta.version}`
 if(seen.has(key))continue
 seen.add(key)
 let installed=location
 if(!fs.existsSync(`${installed}/package.json`))installed=`node_modules/${name}`
 let pkg={}
 try{pkg=JSON.parse(fs.readFileSync(`${installed}/package.json`,'utf8'))}catch{}
 rows.push([name,meta.version,meta.license||pkg.license||'See package distribution'])
 if(pkg.version!==meta.version)continue
 const parts=[]
 for(const file of fs.readdirSync(installed)){
  if(/^(licen[cs]e|copying|notice)([.-]|$)/i.test(file)&&fs.statSync(path.join(installed,file)).isFile())parts.push(`${file}\n\n${fs.readFileSync(path.join(installed,file),'utf8')}`)
 }
 if(parts.length)fs.writeFileSync(`licenses/${key.replaceAll('/','__')}.txt`,parts.join('\n\n---\n\n'))
}
rows.sort((a,b)=>a[0].localeCompare(b[0]))
fs.writeFileSync('THIRD_PARTY_NOTICES.md',`# Third-party notices\n\nLuna Translator application code is Apache-2.0. Dependencies and fonts retain their own licenses. This inventory comes from non-development entries in package-lock.json, including optional platform packages; available LICENSE/NOTICE texts from the generation host are copied to licenses/. Platform binaries are installed from npm for the destination platform and carry their upstream license. Fontsource Noto Sans SC, Noto Serif SC and Poppins, including the Welcome Noto Serif subset, use SIL OFL-1.1.\n\n| Package | Version | License |\n|---|---|---|\n${rows.map(r=>`| ${r.join(' | ')} |`).join('\n')}\n\nGo dependency: github.com/gorilla/websocket v1.5.3, BSD-2-Clause (licenses/gorilla-websocket.txt).\n\nLuna product images and application assets were supplied with the application source. This license grants no endorsement or trademark rights; deployments should identify themselves as independently operated.\n`)
console.log(`Recorded ${rows.length} dependency entries`)
