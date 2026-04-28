import { SerialPort } from 'serialport'
import { EventEmitter } from 'node:events'

type DonePredicate = (lines: string[], line: string) => boolean

interface CommandOptions {
    text: string
    done: DonePredicate
    timeoutMs?: number
    onTimeout?: (lines: string[]) => Promise<string[]>
}

export enum AdvMode {
    NON_CONNECTABLE = 0,
    CONNECTABLE_UNDIRECTED = 1,
    CONNECTABLE_DIRECTED = 2,
    CONNECTABLE_DIRECTED_LOW_DUTY = 3
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
    mode?: AdvMode
    intervalMs?: number
    durationSec?: number
    name?: string
    clear?: boolean
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

    static async open(path: string, baudRate = 57600): Promise<BleuIO> {
        const port = new SerialPort({ path, baudRate, autoOpen: false }) as SerialPort & EventEmitter

        await new Promise<void>((resolve, reject) => {
            port.open(err => err ? reject(err) : resolve())
        })

        await new Promise(resolve => setTimeout(resolve, 200))

        return new BleuIO(path, baudRate, port)
    }

    static parseScanHit(line: string): ScanHit | null {
        const m = line.match(/^\[(\d+)\] Device: \[(\d+)\]([0-9A-F:]{17})\s+RSSI:\s+(-?\d+)(?:\s+\((.*)\))?$/i)

        if (!m) {
            return null
        }

        return {
            index: Number(m[1]),
            addrType: Number(m[2]),
            address: m[3].toUpperCase(),
            rssi: Number(m[4]),
            name: m[5]
        }
    }

    async close(): Promise<void> {
        try {
            if (this.port.isOpen) {
                try {
                    await this.stop()
                } catch { }

                await new Promise<void>((resolve, reject) => {
                    this.port.drain(err => err ? reject(err) : resolve())
                })

                await new Promise<void>((resolve, reject) => {
                    this.port.close(err => err ? reject(err) : resolve())
                })
            }
        }
        finally {
            await this.delay(300)
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

        await this.delay(200)

        this.port = port
        this.attach(port)
        this.buffer = ''
        this.lines = []
        this.pending = Promise.resolve()
    }

    async setCentral(): Promise<void> {
        await this.reset()
        await this.clearState()
        await this.ate(false)
        await this.at_central()
    }

    async setPeripheral(opts?: { name?: string }): Promise<void> {
        await this.reset()
        await this.clearState()
        await this.ate(false)
        await this.at_peripheral()

        if (opts?.name) {
            await this.at_devicename(opts.name)
        }
    }

    async startCentral(): Promise<void> {
        await this.setCentral()
    }

    async startPeripheral(name?: string): Promise<void> {
        await this.setPeripheral({ name })
    }

    async startAdvertising(opts: AdvStartOptions = {}): Promise<void> {
        const clear = opts.clear ?? true

        if (clear) {
            await this.at_advstop()
            await this.at_advresp('')
            await this.at_advdata('')
        }

        if (opts.name) {
            await this.at_advresp(this.nameScanResponse(opts.name))
        }

        await this.at_advstart(opts)
    }

    async stopAdvertising(): Promise<void> {
        await this.at_advstop()
    }

    async stop(): Promise<void> {
        if (!this.port.isOpen) {
            return
        }

        try {
            await this.write('\x03', false)
            await this.delay(100)
        } catch { }
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
        return this.cmdOk('AT+CENTRAL')
    }

    async at_peripheral(): Promise<string[]> {
        return this.cmdOk('AT+PERIPHERAL')
    }

    async at_devicename(name?: string): Promise<string[]> {
        return this.cmdAny(name ? `AT+DEVICENAME=${name}` : 'AT+DEVICENAME')
    }

    async at_advdata(data?: string): Promise<string[]> {
        return this.cmdAny(data === undefined ? 'AT+ADVDATA' : `AT+ADVDATA=${data}`)
    }

    async at_advresp(data?: string): Promise<string[]> {
        return this.cmdAny(data === undefined ? 'AT+ADVRESP' : `AT+ADVRESP=${data}`)
    }

    async at_advstart(opts: AdvStartOptions = {}): Promise<string[]> {
        const mode = opts.mode ?? AdvMode.CONNECTABLE_UNDIRECTED
        const intervalMs = opts.intervalMs ?? 20
        const durationSec = opts.durationSec ?? 0
        const units = Math.round(intervalMs / 0.625)

        return this.cmdAny(`AT+ADVSTART=${mode};${units};${units};${durationSec};`)
    }

    async at_advstop(): Promise<string[]> {
        return this.cmdAny('AT+ADVSTOP')
    }

    async at_gapscan(seconds = 1): Promise<string[]> {
        return this.cmd({
            text: `AT+GAPSCAN=${seconds}`,
            done: lines => lines.some(line => line.includes('SCAN COMPLETE')),
            timeoutMs: (seconds + 2) * 1000,
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
                return hit && hit.address === target ? hit : null
            }
        })
    }

    private async clearState(): Promise<void> {
        try {
            await this.stop()
            await this.delay(150)
        } catch { }
    }

    private async cmdOk(text: string): Promise<string[]> {
        return this.cmd({
            text,
            done: lines => lines.includes('OK') || lines.includes('ERROR'),
            timeoutMs: 1000,
            onTimeout: async lines => lines
        })
    }

    private async cmdAny(text: string): Promise<string[]> {
        return this.cmd({
            text,
            done: lines => lines.some(line => line.trim().length > 0),
            timeoutMs: 1000,
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
                }
                else {
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
        if (!this.port.isOpen) {
            return
        }

        await new Promise<void>((resolve, reject) => {
            this.port.write(cr ? `${text}\r` : text, err => {
                if (err) {
                    reject(err)
                }
                else {
                    this.port.drain(err => err ? reject(err) : resolve())
                }
            })
        })
    }

    private attach(port: SerialPort & EventEmitter): void {
        port.on('data', data => {
            this.accept(data.toString('utf8'))
        })
    }

    private accept(text: string): void {
        this.buffer += text

        for (; ;) {
            const ix = this.buffer.indexOf('\r\n')

            if (ix < 0) {
                break
            }

            const line = this.buffer.slice(0, ix)
            this.buffer = this.buffer.slice(ix + 2)

            this.lines.push(line)
            this.port.emit('bleuio-line', line)
        }
    }

    private nameScanResponse(name: string): string {
        const bytes = Buffer.from(name, 'utf8')
        const len = bytes.length + 1
        return `${this.hexByte(len)}09${bytes.toString('hex')}`
    }

    private hexByte(value: number): string {
        return value.toString(16).padStart(2, '0')
    }

    private async delay(ms: number): Promise<void> {
        await new Promise<void>(resolve => setTimeout(resolve, ms))
    }
}