import { defineConfig } from 'vite'

export default defineConfig({
  server: {
    port: 3002,
    host: '0.0.0.0',
    proxy: {
      '/system-login-api': {
        target: 'https://v3-test-account.deepfos.com',
        changeOrigin: true,
        cookieDomainRewrite: '',
        secure: false,
      },
    },
  },
})
