const path = require('path')
const url = require('url')
const EventEmitter = require('events')
const express = require('express')
const fs = require('fs-extra')
const globby = require('globby')
const finalhandler = require('finalhandler')
const createConfig = require('./create-config')
const runWebpack = require('./run-webpack')
const Router = require('./router')
const { handleRoute, parseRoutes } = require('./utils')
const { getFilename } = require('./build-utils')
const loadConfig = require('./load-config')

const serveStatic = (path, cache) => express.static(path, {
  maxAge: cache ? '1d' : 0,
  dotfiles: 'allow'
})

module.exports = class Ream extends EventEmitter {
  constructor({
    entry = 'index.js',
    renderer,
    output = {},
    dev,
    cwd = process.cwd(),
    host,
    port,
    extendWebpack,
    build = {},
    plugins = []
  } = {}) {
    super()

    if (!renderer) {
      throw new Error('Requires a renderer to start Ream.')
    }

    this.dev = dev
    this.cwd = cwd
    this.host = host
    this.port = port
    this.buildOptions = {
      entry,
      output: Object.assign({
        path: this.resolveCwd('.ream')
      }, output, {
        filename: getFilename(!this.dev, output.filename)
      }),
      bundleReport: build.bundleReport,
      staticFolder: build.staticFolder || 'static',
      extendWebpack
    }
    this.renderer = renderer
    this.plugins = plugins
    this.predefinedRoutes = []
  }

  addPredefinedRoutes(routes = []) {
    this.predefinedRoutes = this.predefinedRoutes.concat(routes)
    return this
  }

  extendWebpack(fn) {
    if (typeof fn !== 'function') {
      throw new TypeError('Expected the first argument of extendWebpack to be a function')
    }
    fn(this.serverConfig, { type: 'server', dev: this.dev })
    fn(this.clientConfig, { type: 'client', dev: this.dev })
    return this
  }

  ownDir(...args) {
    return path.join(__dirname, '../', ...args)
  }

  resolveCwd(...args) {
    return path.resolve(this.cwd, ...args)
  }

  resolveDist(type, ...args) {
    return this.resolveCwd(this.buildOptions.output.path, `dist-${type}`, ...args)
  }

  async build() {
    await this.init()

    const serverConfig = this.serverConfig.toConfig()
    const clientConfig = this.clientConfig.toConfig()
    return Promise.all([
      fs.remove(serverConfig.output.path).then(() => runWebpack(serverConfig)),
      fs.remove(clientConfig.output.path).then(() => runWebpack(clientConfig))
    ])
  }

  generate({ routes = [], folder = 'generated' } = {}) {
    routes = [...new Set(this.predefinedRoutes.concat(routes))]
    if (routes.length === 0) return Promise.reject(new Error('Expected to provide routes!'))

    this.emit('before-request')

    const folderPath = this.resolveCwd(this.buildOptions.output.path, folder)
    return fs.remove(folderPath).then(() => Promise.all(parseRoutes(routes).map(route => {
      return this.renderer.renderToString(route)
        .then(html => {
          const outputPath = this.resolveCwd(
            folderPath,
            `.${handleRoute(route)}`
          )
          return fs.ensureDir(path.dirname(outputPath))
            .then(() => fs.writeFile(outputPath, html, 'utf8'))
        })
    })).then(() => {
      const distStaticPath = this.resolveDist('client', 'static')
      return Promise.all([
        fs.copy(
          this.resolveDist('client'),
          this.resolveCwd(folderPath, '_ream')
        ),
        fs.pathExists(distStaticPath)
          .then(exists => {
            if (!exists) return
            return fs.copy(distStaticPath, this.resolveCwd(folderPath))
          })
      ])
      .then(() => fs.remove(this.resolveCwd(folderPath, '_ream', 'index.html'))).then(() => folderPath)
    }))
  }

  async init({ webpack = true } = {}) {
    if (this._hasInit) {
      return
    }

    this._hasInit = true

    if (webpack) {
      const { babel, postcss } = await loadConfig(this.cwd)
      this.buildOptions.babel = babel
      this.buildOptions.postcss = postcss

      this.serverConfig = createConfig(this, 'server')
      this.clientConfig = createConfig(this, 'client')
    }

    this.renderer.init(this, { webpack })

    if (webpack && this.buildOptions.extendWebpack) {
      this.extendWebpack(this.buildOptions.extendWebpack)
    }

    await this.loadPlugins()
  }

  async loadPlugins() {
    await Promise.all(this.plugins.map(plugin => plugin(this)))
  }

  async getRequestHandler() {
    await this.init({ webpack: this.dev })

    this.staticFilePaths = await globby(['**'], { cwd: this.resolveCwd('static') })
    if (this.dev) {
      this.webpackMiddleware = require('./setup-dev-server')(this)
    }
    this.emit('before-request')

    const router = new Router()

    const serverInfo = `ream/${require('../package.json').version}`

    const routes = {}

    routes['/_ream/*'] = (req, res) => {
      if (this.dev) {
        return this.webpackMiddleware(req, res)
      }

      req.url = req.url.replace(/^\/_ream/, '')

      serveStatic(this.resolveCwd(this.buildOptions.output.path, 'dist-client'), !this.dev)(req, res, finalhandler(req, res))
    }

    routes['/public/*'] = (req, res) => {
      req.url = req.url.replace(/^\/public/, '')
      serveStatic(this.resolveCwd('public'), !this.dev)(req, res, finalhandler(req, res))
    }

    routes['/:path*'] = (req, res) => {
      const render = () => {
        res.setHeader('Content-Type', 'text/html')
        res.setHeader('Server', serverInfo)
        this.renderer.rendererHandleRequests(req, res)
      }

      const r = req.path.slice(1)
      const inStatic = this.staticFilePaths.some(filepath => {
        return r.startsWith(filepath)
      })
      if (inStatic) {
        return serveStatic(this.resolveCwd('static'), !this.dev)(req, res, () => {
          res.statusCode = 404
          res.end('404')
        })
      }
      render()
    }

    for (const method of ['GET', 'HEAD']) {
      for (const p of Object.keys(routes)) {
        router.add(method, p, routes[p])
      }
    }

    return (req, res) => {
      router.match(req, res, url.parse(req.url, true))
    }
  }
}
