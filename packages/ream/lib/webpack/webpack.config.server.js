const VueSSRServerPlugin = require('vue-server-renderer/server-plugin')
const nodeExternals = require('webpack-node-externals')
const { ownDir } = require('../utils/dir')
const baseConfig = require('./webpack.config.base')

module.exports = (api, config) => {
  baseConfig(api, config, true)

  config.entry('server').add(ownDir('app/entries/server.js'))

  config.merge({
    output: {
      libraryTarget: 'commonjs2',
      path: api.resolveDist('server')
    },
    target: 'node',
    devtool: api.options.dev ? '#source-map' : false
  })

  // Vue SSR plugin
  config.plugin('ssr').use(VueSSRServerPlugin, [
    {
      filename: 'server-bundle.json'
    }
  ])

  config.externals([
    [
      'vue',
      'vuex',
      'vue-router',
      'vue-meta',
      nodeExternals({
        whitelist: [/\.(?!(?:js|json)$).{1,5}(\?.+)?$/i]
      })
    ]
  ])
}
