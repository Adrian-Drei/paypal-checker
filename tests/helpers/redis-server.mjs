import { spawn } from 'node:child_process'
import { createConnection } from 'node:net'
import { mkdir } from 'node:fs/promises'
import { randomInt, randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'

// Test-only RESP transport: real Redis/Lua/AOF, no production credentials or PayPal calls.
function parse(buffer, offset = 0) {
  const end = buffer.indexOf('\r\n', offset)
  if (end < 0) return null
  const type = String.fromCharCode(buffer[offset]), value = buffer.toString('utf8', offset + 1, end)
  let next = end + 2
  if (type === '+') return [value, next]
  if (type === '-') throw new Error(value)
  if (type === ':') return [Number(value), next]
  if (type === '$') {
    const length = Number(value)
    if (length < 0) return [null, next]
    if (buffer.length < next + length + 2) return null
    return [buffer.toString('utf8', next, next + length), next + length + 2]
  }
  if (type === '*') {
    if (Number(value) < 0) return [null, next]
    const items = []
    for (let i = 0; i < Number(value); i++) {
      const result = parse(buffer, next)
      if (!result) return null
      items.push(result[0]); next = result[1]
    }
    return [items, next]
  }
  throw new Error('Unexpected Redis response')
}

export async function startRedis(executable) {
  const port = randomInt(40000, 55000)
  const directory = resolve('.cache', 'paypal-redis-tests', randomUUID())
  await mkdir(directory, { recursive: true })
  let child
  const command = args => new Promise((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port })
    let buffer = Buffer.alloc(0)
    socket.setTimeout(5000, () => socket.destroy(new Error('Redis test timeout')))
    socket.on('error', reject)
    socket.on('connect', () => {
      const values = args.map(value => Buffer.from(String(value)))
      socket.write(Buffer.concat([Buffer.from(`*${values.length}\r\n`), ...values.flatMap(value => [Buffer.from(`$${value.length}\r\n`), value, Buffer.from('\r\n')])]))
    })
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk])
      try {
        const result = parse(buffer)
        if (result) { socket.end(); resolve(result[0]) }
      } catch (error) { socket.destroy(); reject(error) }
    })
  })
  async function start() {
    child = spawn(executable, ['--bind', '127.0.0.1', '--port', String(port), '--dir', directory, '--appendonly', 'yes', '--appendfsync', 'always', '--save', ''], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let error
    child.on('error', cause => { error = cause })
    child.stdout.resume(); child.stderr.resume()
    for (let attempt = 0; attempt < 50; attempt++) {
      if (error) throw error
      if (child.exitCode !== null) throw new Error('Redis test server exited before startup')
      try { if (await command(['PING']) === 'PONG') return } catch { await delay(100) }
    }
    throw new Error('Redis test server did not start')
  }
  async function stop() {
    if (!child || child.exitCode !== null) return
    const closed = once(child, 'close')
    child.kill()
    await closed
  }
  try { await start() } catch (error) { await stop(); throw error }
  return { command, stop, restart: async () => { await stop(); await start() } }
}
