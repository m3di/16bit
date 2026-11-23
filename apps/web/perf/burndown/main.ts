import './perf.css'
import { createApp, h, ref } from 'vue'
import BurndownChart from '../../src/ui/BurndownChart.vue'

// Four burndowns as on a busy page, the heaviest a year of calendar days (the 366-day cap). The
// measuring script drives it through the functions on `window` (issue 259).
const done = ref<Record<string, number>>({ '2026-11-09': 3, '2026-11-10': 2, '2026-11-12': 5 })
const show = ref(false)
const width = ref(960)

const charts = () => [
  h(BurndownChart, {
    start: '2026-11-09',
    end: '2026-11-20',
    total: 34,
    doneByDay: done.value,
    today: '2026-11-16',
  }),
  h(BurndownChart, {
    start: '2026-11-02',
    end: '2026-11-29',
    days: 'calendar',
    total: 120,
    doneByDay: done.value,
    today: '2026-11-23',
  }),
  h(BurndownChart, {
    start: '2026-01-01',
    end: '2026-12-31',
    days: 'calendar',
    total: 2000,
    doneByDay: done.value,
    today: '2026-11-23',
  }),
  h(BurndownChart, {
    start: '2026-01-01',
    end: '2026-12-31',
    total: 2000,
    doneByDay: done.value,
    today: '2026-11-23',
  }),
]

createApp({
  setup: () => () =>
    h(
      'div',
      { class: 'bg-bg text-ink', style: { width: `${String(width.value)}px`, padding: '24px' } },
      show.value ? charts() : [],
    ),
}).mount('#app')

let n = 0
Object.assign(window, {
  mountCharts() {
    show.value = true
  },
  updateCharts() {
    n++
    const month = String(1 + (n % 11)).padStart(2, '0')
    const day = `2026-${month}-${String(1 + (n % 27)).padStart(2, '0')}`
    done.value = { ...done.value, [day]: (done.value[day] ?? 0) + 1 }
  },
  toggleTheme() {
    const root = document.documentElement
    root.className = root.className === 'theme-light' ? 'theme-dark' : 'theme-light'
  },
  resizeCharts(px: number) {
    width.value = px
  },
})
