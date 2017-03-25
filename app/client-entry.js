import 'es6-promise/auto'
import createApp from './create-app'
import entry from '@alias/entry'

const { store, router, handlers } = entry

if (handlers) {
  const handlerContext = {
    store,
    router,
    isDev: process.env.NODE_ENV === 'development',
    isClient: true
  }
  for (const handler of handlers) {
    handler(handlerContext)
  }
}

const app = createApp(entry)

// prime the store with server-initialized state.
// the state is determined during SSR and inlined in the page markup.
if (window.__REAM__.state && store) {
  store.replaceState(window.__REAM__.state)
  window.__REAM__.state = null // mark it as used
}

// wait until router has resolved all async before hooks
// and async components...
router.onReady(() => {
  // actually mount to DOM
  app.$mount('#app')
})

