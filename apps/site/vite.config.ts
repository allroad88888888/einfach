import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'

export default defineConfig({
  resolve: {
    alias: {
      '@einfach/core': fileURLToPath(new URL('../../core/core/src/index.ts', import.meta.url)),
      '@einfach/react': fileURLToPath(new URL('../../core/react/src/index.ts', import.meta.url)),
    },
  },
  build: {
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        api: fileURLToPath(new URL('./api/index.html', import.meta.url)),
        apiCore: fileURLToPath(new URL('./api/core/index.html', import.meta.url)),
        apiReact: fileURLToPath(new URL('./api/react/index.html', import.meta.url)),
        apiSolid: fileURLToPath(new URL('./api/solid/index.html', import.meta.url)),
        apiReactForm: fileURLToPath(new URL('./api/react-form/index.html', import.meta.url)),
        apiSolidForm: fileURLToPath(new URL('./api/solid-form/index.html', import.meta.url)),
        apiUtils: fileURLToPath(new URL('./api/utils/index.html', import.meta.url)),
        apiReactUtils: fileURLToPath(new URL('./api/react-utils/index.html', import.meta.url)),
      },
    },
  },
})
