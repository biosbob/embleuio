import { SerialPort } from 'serialport'
import { EventEmitter } from 'node:events'

type DonePredicate = (lines: string[], line: string) => boolean

interface CommandOptions {
    text: string
    done: DonePredicate
    timeoutMs?: number
    onTimeout?: (lines: string[]) => Promise<string[]>
}

export interface ScanHit {
    index: number
    addrType: number
    address: string
    rssi: number
    name?: string
}

export interface ScanUntilOptions {
    scanSeconds?: number
    timeoutMs?: number
}

export interface AdvStartOptions {
    mode?: number
    intervalMs?: number
    durationSec?: number
}

export class BleuIO {
    private port: SerialPort & EventEmitter
    private readonly path: string
    private readonly baudRate: number
    private buffer = ''
    private lines: string[] = []
    private pending: Promise<void> = Promise.resolve()

    private constructor(path: string, baudRate: number, port: SerialPort & EventEmitter) {
        this.path = path
        this.baudRate = baudRate
        this.port = port
        this.attach(port)
    }

    private attach(port: SerialPort & EventEmitter) {
        port.on('data', d => this.accept(d.toString('utf8')))
    }

    static async open(path: string, baudRate = 57600): Promise<BleuIO> {
        const port = new SerialPort({ path, baudRate, autoOpen: false }) as SerialPort & EventEmitter

        await new Promise<void>((res, rej) => {
            port.open(err => err ? rej(err) : res())
        })

        await new Promise(r => setTimeout(r, 200))
        return new BleuIO(path, baudRate, port)
    }

    async reset(): Promise<void> {
        if (this.port.isOpen) await this.close()

        await this.delay(300)

        const port = new SerialPort({
            path: this.path,
            baudRate: this.baudRate,
            autoOpen: false
        }) as SerialPort & EventEmitter

        await new Promise<void>((res, rej) => {
            port.open(err => err ? rej(err) : res())
        })

        await this.delay(200)

        this.port = port
        this.attach(port)
        this.buffer = ''
        this.lines = []
        this.pending = Promise.resolve()
    }

    async close(): Promise<void> {
        try {
            if (this.port.isOpen) {
                try {
                    await this.write('\x03', false)
                    await this.delay(100)
                } catch { }

                await new Promise<void>((res, rej) => {
                    this.port.drain(err => err ? rej(err) : res())
                })

                await new Promise<void>((res, rej) => {
                    this.port.close(err => err ? rej(err) : res())
                })
            }
        } finally {
            await this.delay(300)
        }
    }

    async startCentral(): Promise<void> {
        await this.reset()
        try {
            await this.write('\x03', false)
            await this.delay(150)
        } catch { }
        await this.ate(false)
        await this.at_central()
    }

    async startPeripheral(name?: string): Promise<void> {
        await this.reset()
        await this.ate(false)
        await this.at_peripheral()
        if (name) await this.at_devicename(name)
    }

    async stop(): Promise<void> {
        if (!this.port.isOpen) return

        try {
            await this.write('\x03', false)
            await this.delay(100)
        } catch { }
    }

    async ate(enabled: boolean): Promise<string[]> {
        const expect = enabled ? 'ECHO ON' : 'ECHO OFF'
        return this.cmd({
            text: `ATE${enabled ? 1 : 0}`,
            done: l => l.includes(expect) || l.includes('OK'),
            timeoutMs: 500,
            onTimeout: async l => l
        })
    }

    async at_central(): Promise<string[]> {
        return this.cmdAny('AT+CENTRAL')
    }

    async at_peripheral(): Promise<string[]> {
        return this.cmdAny('AT+PERIPHERAL')
    }

    async at_devicename(name?: string): Promise<string[]> {
        return this.cmdAny(name ? `AT+DEVICENAME=${name}` : 'AT+DEVICENAME')
    }

    async at_gapscan(seconds = 1): Promise<string[]> {
        return this.cmd({
            text: `AT+GAPSCAN=${seconds}`,
            done: () => false,
            timeoutMs: (seconds + 1) * 1000,
            onTimeout: async l => {
                await this.stop()
                return l
            }
        })
    }

    async scanUntilAddress(address: string, opts: ScanUntilOptions = {}): Promise<ScanHit> {
        const target = address.toUpperCase()
        const scanSeconds = opts.scanSeconds ?? 3
        const timeoutMs = opts.timeoutMs ?? (scanSeconds + 2) * 1000

        return new Promise<ScanHit>((resolve, reject) => {
            const timer = setTimeout(() => {
                cleanup()
                reject(new Error('scanUntil timeout'))
            }, timeoutMs)

            const onLine = (line: string) => {
                const hit = BleuIO.parseScanHit(line)
                if (hit && hit.address === target) {
                    cleanup()
                    this.stop().then(() => resolve(hit)).catch(reject)
                }
            }

            const cleanup = () => {
                clearTimeout(timer)
                this.port.off('bleuio-line', onLine)
            }

            this.port.on('bleuio-line', onLine)
            this.write(`AT+GAPSCAN=${scanSeconds}`, true).catch(reject)
        })
    }

    async at_advstart(opts: AdvStartOptions = {}): Promise<string[]> {
        const mode = opts.mode ?? 1
        const intervalMs = opts.intervalMs ?? 20
        const durationSec = opts.durationSec ?? 0
        const units = Math.round(intervalMs / 0.625)

        return this.cmdAny(`AT+ADVSTART=${mode};${units};${units};${durationSec};`)
    }

    async at_advstop(): Promise<string[]> {
        return this.cmdAny('AT+ADVSTOP')
    }

    static parseScanHit(line: string): ScanHit | null {
        const m = line.match(/^\[(\d+)\] Device: \[(\d+)\]([0-9A-F:]{17})\s+RSSI:\s+(-?\d+)(?:\s+\((.*)\))?$/i)
        if (!m) return null

        return {
            index: +m[1],
            addrType: +m[2],
            address: m[3].toUpperCase(),
            rssi: +m[4],
            name: m[5]
        }
    }

    private async cmdAny(text: string): Promise<string[]> {
        return this.cmd({
            text,
            done: l => l.length > 0,
            timeoutMs: 1000,
            onTimeout: async l => l
        })
    }

    private async cmd(opts: CommandOptions): Promise<string[]> {
        const run = async () => {
            this.lines = []

            return new Promise<string[]>((resolve, reject) => {
                const t = setTimeout(() => {
                    cleanup()
                    opts.onTimeout ? opts.onTimeout([...this.lines]).then(resolve, reject)
                        : reject(new Error(`Timeout ${opts.text}`))
                }, opts.timeoutMs ?? 2000)

                const onLine = (line: string) => {
                    if (opts.done(this.lines, line)) {
                        cleanup()
                        resolve([...this.lines])
                    }
                }

                const cleanup = () => {
                    clearTimeout(t)
                    this.port.off('bleuio-line', onLine)
                }

                this.port.on('bleuio-line', onLine)
                this.write(opts.text, true).catch(reject)
            })
        }

        const r = this.pending.then(run, run)
        this.pending = r.then(() => { }, () => { })
        return r
    }

    private async write(text: string, cr = true): Promise<void> {
        if (!this.port.isOpen) return

        await new Promise<void>((res, rej) => {
            this.port.write(cr ? `${text}\r` : text, err => {
                if (err) return rej(err)
                this.port.drain(err => err ? rej(err) : res())
            })
        })
    }

    private accept(text: string) {
        this.buffer += text

        for (; ;) {
            const i = this.buffer.indexOf('\r\n')
            if (i < 0) break

            const line = this.buffer.slice(0, i)
            this.buffer = this.buffer.slice(i + 2)

            this.lines.push(line)
            this.port.emit('bleuio-line', line)
        }
    }

    private async delay(ms: number) {
        return new Promise<void>(r => setTimeout(r, ms))
    }
}