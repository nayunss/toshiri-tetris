import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  base: './',
  plugins: [react()],
  // ponytail: webm은 public/이 아니라 icon/에 이미 있다. 그대로 서빙되도록 publicDir 지정.
  publicDir: 'public',
})
