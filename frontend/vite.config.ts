import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// GitHub Pages 주소가 https://bamdo01.github.io/GaemiRanger/ 이라서 base 를 맞춘다.
export default defineConfig({
  plugins: [react()],
  base: '/GaemiRanger/',
});
