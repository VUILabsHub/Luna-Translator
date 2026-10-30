import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
const backend = process.env.VITE_API_PROXY || 'http://127.0.0.1:8080'
export default defineConfig({plugins:[react()],build:{assetsInlineLimit:(path)=>/\.woff2?$/.test(path)?false:undefined},server:{host:'127.0.0.1',port:5173,proxy:{'/api':backend,'/health':backend,'/ready':backend,'/ws':{target:backend,ws:true}}}})
