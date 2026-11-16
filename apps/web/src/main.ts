import '@fontsource/inter/400.css'
import '@fontsource/inter/500.css'
import '@fontsource/space-grotesk/500.css'
import '@fontsource/jetbrains-mono/400.css'
import './styles/main.css'

import { createApp } from 'vue'
import App from './App.vue'
import { makeRouter } from './router.ts'
import { installAuthRedirect } from './session/redirect.ts'
import { createSession, sessionKey } from './session/session.ts'
import { startTheme } from './theme/theme.ts'

startTheme()
const router = makeRouter()
const session = createSession()
installAuthRedirect(router, session)
createApp(App).provide(sessionKey, session).use(router).mount('#app')
