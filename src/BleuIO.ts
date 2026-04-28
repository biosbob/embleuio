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
        port.on('data', data => {
            this.accept(data.toString('utf8'))
        })
    }

    static async open(path: string, baudRate = 57600): Promise<BleuIO> {
        const port = new SerialPort({
            path,
            baudRate,
            autoOpen: false
        }) as SerialPort & EventEmitter

        await new Promise<void>((resolve, reject) => {
            port.open(err => err ? reject(err) : resolve())
        })

        return new BleuIO(path, baudRate, port)
    }

    static parseScanHit(line: string): ScanHit | null {
        const m = line.match(/^\[(\d+)\] Device: \[(\d+)\]([0-9A-Fa-f:]{17})\s+RSSI:\s+(-?\d+)(?:\s+\((.*)\))?$/)

        if (!m) return null

        return {
            index: Number(m[1]),
            addrType: Number(m[2]),
            address: m[3].toUpperCase(),
            rssi: Number(m[4]),
            name: m[5]
        }
    }

    async startCentral(): Promise<void> {
        await this.reset()
        await this.ate(false)
        await this.at_central()
    }

    async startPeripheral(name?: string): Promise<void> {
        await this.reset()
        await this.ate(false)
        await this.at_peripheral()

        if (name) {
            await this.at_devicename(name)
        }
    }

    async reset(): Promise<void> {
        if (this.port.isOpen) {
            await this.close()
        }

        await this.delay(300)

        const port = new SerialPort({
            path: this.path,
            baudRate: this.baudRate,
            autoOpen: false
        }) as SerialPort & EventEmitter

        await new Promise<void>((resolve, reject) => {
            port.open(err => err ? reject(err) : resolve())
        })

        this.port = port
        this.attach(port)

        this.buffer = ''
        this.lines = []
        this.pending = Promise.resolve()
    }

    async close(): Promise<void> {
        if (!this.port.isOpen) return

        await new Promise<void>((resolve, reject) => {
            this.port.close(err => err ? reject(err) : resolve())
        })
    }

    async stop(): Promise<void> {
        await this.write('\x03', false)
        await this.delay(100)
    }

    async ate(enabled: boolean): Promise<string[]> {
        const expect = enabled ? 'ECHO ON' : 'ECHO OFF'

        return this.cmd({
            text: `ATE${enabled ? 1 : 0}`,
            done: lines => lines.includes(expect) || lines.includes('OK'),
            timeoutMs: 500,
            onTimeout: async lines => lines
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
            onTimeout: async lines => {
                await this.stop()
                return lines
            }
        })
    }

    async scanUntilAddress(address: string, opts: ScanUntilOptions = {}): Promise<ScanHit> {
        const target = address.toUpperCase()
        const scanSeconds = opts.scanSeconds ?? 3
        const timeoutMs = opts.timeoutMs ?? ((scanSeconds + 2) * 1000)

        return this.cmdScanUntil({
            text: `AT+GAPSCAN=${scanSeconds}`,
            timeoutMs,
            match: line => {
                const hit = BleuIO.parseScanHit(line)
                return hit && hit.address.toUpperCase() === target ? hit : null
            }
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

    private async cmdAny(text: string, timeoutMs = 1000): Promise<string[]> {
        return this.cmd({
            text,
            done: lines => lines.length > 0,
            timeoutMs,
            onTimeout: async lines => lines
        })
    }

    private async cmd(opts: CommandOptions): Promise<string[]> {
        const run = async () => this.runCommand(opts)

        const result = this.pending.then(run, run)
        this.pending = result.then(() => { }, () => { })

        return result
    }

    private async runCommand(opts: CommandOptions): Promise<string[]> {
        this.lines = []

        return new Promise<string[]>((resolve, reject) => {
            const timeout = setTimeout(() => {
                cleanup()

                if (opts.onTimeout) {
                    opts.onTimeout([...this.lines]).then(resolve, reject)
                } else {
                    reject(new Error(`Timeout waiting for response to ${opts.text}`))
                }
            }, opts.timeoutMs ?? 2000)

            const onLine = (line: string) => {
                if (opts.done(this.lines, line)) {
                    cleanup()
                    resolve([...this.lines])
                }
            }

            const cleanup = () => {
                clearTimeout(timeout)
                this.port.off('bleuio-line', onLine)
            }

            this.port.on('bleuio-line', onLine)

            this.write(opts.text, true).catch(err => {
                cleanup()
                reject(err)
            })
        })
    }

    private async cmdScanUntil(opts: {
        text: string
        timeoutMs: number
        match: (line: string) => ScanHit | null
    }): Promise<ScanHit> {
        const run = async () => this.runScanUntil(opts)

        const result = this.pending.then(run, run)
        this.pending = result.then(() => { }, () => { })

        return result
    }

    private async runScanUntil(opts: {
        text: string
        timeoutMs: number
        match: (line: string) => ScanHit | null
    }): Promise<ScanHit> {
        this.lines = []

        return new Promise<ScanHit>((resolve, reject) => {
            const timeout = setTimeout(() => {
                cleanup()
                reject(new Error(`Timeout waiting for scan hit from ${opts.text}`))
            }, opts.timeoutMs)

            const cleanup = () => {
                clearTimeout(timeout)
                this.port.off('bleuio-line', onLine)
            }

            const onLine = (line: string) => {
                const hit = opts.match(line)

                if (hit) {
                    cleanup()

                    this.stop()
                        .then(() => resolve(hit))
                        .catch(reject)
                }
            }

            this.port.on('bleuio-line', onLine)

            this.write(opts.text, true).catch(err => {
                cleanup()
                reject(err)
            })
        })
    }

    private async write(text: string, cr = true): Promise<void> {
        await new Promise<void>((resolve, reject) => {
            this.port.write(cr ? `${text}\r` : text, err => {
                if (err) {
                    reject(err)
                } else {
                    this.port.drain(err => err ? reject(err) : resolve())
                }
            })
        })
    }

    private accept(text: string): void {
        this.buffer += text

        for (; ;) {
            const ix = this.buffer.indexOf('\r\n')
            if (ix < 0) break

            const line = this.buffer.slice(0, ix)
            this.buffer = this.buffer.slice(ix + 2)

            this.lines.push(line)
            this.port.emit('bleuio-line', line)
        }
    }

    private async delay(ms: number): Promise<void> {
        await new Promise<void>(resolve => setTimeout(resolve, ms))
    }
}