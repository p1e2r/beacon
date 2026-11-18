// WebSocket transport through a Beacon proxy. The proxy answers with one JSON text frame
// ("connected" or "error"), then binary frames carry the raw TCP stream.

export interface ProxyTarget {
  proxy: string // https://… or wss://…
  key: string
  host: string
  port?: number
}

export class ProxyError extends Error {
  constructor(public code: string, message: string) {
    super(message)
  }
}

export function proxyWsBase(proxy: string): string {
  let p = proxy.trim().replace(/\/+$/, '')
  if (!p) p = location.origin
  if (!/^[a-z]+:\/\//i.test(p)) p = 'https://' + p
  return p.replace(/^http(s?):\/\//i, 'ws$1://')
}

function protocols(key: string): string[] {
  const k = key.trim()
  return k ? ['beacon', 'beacon-key.' + k] : ['beacon']
}

export class Transport {
  onData: (b: Uint8Array) => void = () => {}
  onClose: (reason: string) => void = () => {}
  private ws!: WebSocket
  private closed = false
  info: any = null

  static open(t: ProxyTarget, timeoutMs = 15000): Promise<Transport> {
    const tr = new Transport()
    return new Promise((resolve, reject) => {
      const q = new URLSearchParams({ host: t.host })
      if (t.port) q.set('port', String(t.port))
      let ws: WebSocket
      try {
        ws = new WebSocket(`${proxyWsBase(t.proxy)}/connect?${q}`, protocols(t.key))
      } catch (e: any) {
        reject(new ProxyError('bad_proxy', 'That proxy address is not valid.'))
        return
      }
      ws.binaryType = 'arraybuffer'
      tr.ws = ws
      let settled = false
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true
          ws.close()
          reject(new ProxyError('timeout', 'The proxy did not answer in time.'))
        }
      }, timeoutMs)
      ws.onmessage = ev => {
        if (typeof ev.data === 'string') {
          let m: any
          try {
            m = JSON.parse(ev.data)
          } catch {
            return
          }
          if (!settled) {
            settled = true
            clearTimeout(timer)
            if (m.t === 'connected') {
              tr.info = m
              resolve(tr)
            } else reject(new ProxyError(m.code || 'error', m.msg || 'The proxy refused the connection.'))
          } else if (m.t === 'error') {
            tr.finish(m.msg || 'Disconnected by the proxy.')
          }
          return
        }
        if (settled) tr.onData(new Uint8Array(ev.data as ArrayBuffer))
      }
      ws.onerror = () => {}
      ws.onclose = ev => {
        clearTimeout(timer)
        if (!settled) {
          settled = true
          reject(
            new ProxyError(
              'unreachable',
              ev.code === 1006
                ? 'Could not reach the proxy. Check the proxy address (and that it uses https).'
                : `The proxy closed the connection (${ev.code}).`
            )
          )
        } else tr.finish('Connection lost.')
      }
    })
  }

  /** Verifies the key without joining a server. Resolves with the proxy name and key label. */
  static async check(proxy: string, key: string): Promise<{ name: string; key?: string }> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`${proxyWsBase(proxy)}/connect?check=1`, protocols(key))
      const timer = setTimeout(() => {
        ws.close()
        reject(new ProxyError('timeout', 'The proxy did not answer in time.'))
      }, 10000)
      ws.onmessage = ev => {
        clearTimeout(timer)
        const m = JSON.parse(String(ev.data))
        if (m.t === 'ok') resolve({ name: m.name, key: m.key })
        else reject(new ProxyError(m.code, m.msg))
        ws.close()
      }
      ws.onclose = ev => {
        clearTimeout(timer)
        reject(new ProxyError('unreachable', ev.code === 1006 ? 'Could not reach the proxy.' : 'The proxy closed the connection.'))
      }
    })
  }

  send(b: Uint8Array) {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(b as Uint8Array<ArrayBuffer>)
  }

  close() {
    this.closed = true
    try {
      this.ws.close()
    } catch {}
  }

  private finish(reason: string) {
    if (this.closed) return
    this.closed = true
    try {
      this.ws.close()
    } catch {}
    this.onClose(reason)
  }
}
