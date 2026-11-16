import '@fontsource/inter/400.css'
import '@fontsource/inter/500.css'
import '@fontsource/space-grotesk/500.css'
import '@fontsource/jetbrains-mono/400.css'
import './styles/main.css'

import { createApp } from 'vue'
import App from './App.vue'
import { makeRouter } from './router.ts'
import { startTheme } from './theme/theme.ts'

startTheme()
createApp(App).use(makeRouter()).mount('#app')
