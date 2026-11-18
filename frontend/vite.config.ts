import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// GitHub Pages 주소가 https://bamdo01.github.io/GaemiRanger/ 이라서 base 를 맞춘다.
// 서버(FastAPI)가 화면을 같이 내보낼 때는 `npm run build:server` (base 가 / ).
// 개발 중에는 /api 를 이 PC 의 서버(8000)로 넘긴다.
export default defineConfig({
  plugins: [react()],
  base: '/GaemiRanger/',
  server: {
    proxy: { '/api': 'http://127.0.0.1:8000' },
  },
});
