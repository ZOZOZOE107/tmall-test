import { defineConfig, type Plugin } from 'vite'
import { resolve } from 'node:path'
import { readFile, writeFile } from 'node:fs/promises'

const MANIFEST = resolve(__dirname, 'public/garments/manifest.json')

/**
 * 调参页保存用的开发期接口。只在 dev server 上挂载，不进生产构建 ——
 * 线上是纯静态站，manifest.json 由这里写好之后一起打包。
 */
function manifestWriter(): Plugin {
  return {
    name: 'aoe-manifest-writer',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__manifest', (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405
          res.end('POST only')
          return
        }
        let body = ''
        req.on('data', (c) => (body += c))
        req.on('end', async () => {
          try {
            const patch = JSON.parse(body) as { themeId: string; lookId: string; slot: string; fit: unknown }
            const m = JSON.parse(await readFile(MANIFEST, 'utf8'))
            const th = m.themes.find((t: { id: string }) => t.id === patch.themeId)
            const lk = th?.looks.find((l: { id: string }) => l.id === patch.lookId)
            if (!lk?.fit?.[patch.slot]) throw new Error(`找不到 ${patch.themeId}/${patch.lookId}/${patch.slot}`)
            lk.fit[patch.slot] = patch.fit
            await writeFile(MANIFEST, JSON.stringify(m, null, 2) + '\n', 'utf8')
            res.setHeader('content-type', 'application/json')
            res.end(JSON.stringify({ ok: true }))
          } catch (err) {
            res.statusCode = 400
            res.end(JSON.stringify({ ok: false, error: String(err) }))
          }
        })
      })
    },
  }
}

export default defineConfig({
  plugins: [manifestWriter()],
  server: {
    host: true,
    port: 5173,
    /*
     * Vite 6 会拒掉 Host 头不在白名单里的请求 —— 手机用流量的时候，
     * 页面是靠隧道转进来的，域名是随机的 xxx.trycloudflare.com，
     * 不放行的话浏览器只会拿到一句 "Blocked request"。
     * 带点前缀是「匹配所有子域」的写法，隧道域名每次重建都会变，必须这么写。
     */
    allowedHosts: ['.trycloudflare.com', '.loca.lt'],
  },
  build: {
    target: 'es2022',
    // 园区版需要整包离线，资源全部本地化，不走 CDN
    assetsInlineLimit: 0,
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        tune: resolve(__dirname, 'tune.html'),
      },
    },
  },
})
