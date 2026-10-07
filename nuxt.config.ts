// https://nuxt.com/docs/api/configuration/nuxt-config
import tailwindcss from '@tailwindcss/vite'

export default defineNuxtConfig({
  compatibilityDate: '2025-07-15',
  devtools: { enabled: true },
  css: ['~/assets/css/main.css'],
  vite: { plugins: [tailwindcss()] },
  // Bundle Nuxt's internal renderer so Nitro resolves generated render data.
  nitro: { externals: { inline: ['nuxt'] } },
  runtimeConfig: {
    paypalClientSecret: '',
    paypalEnv: 'sandbox',
    public: { paypalClientId: '' }
  }
})
