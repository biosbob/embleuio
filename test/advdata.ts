// test/advdata.ts

import { AdvMode, BleuIO } from '../src/BleuIO'

async function delay(ms: number) {
    await new Promise<void>(resolve => setTimeout(resolve, ms))
}

async function main() {
    const dongle = await BleuIO.open('COM19')

    try {
        await dongle.ate(false)
        await dongle.at_peripheral()

        console.log('stop:', await dongle.at_advstop())

        console.log('set advdata:', await dongle.at_advdata('03:09:42:4A'))
        await delay(1000)

        console.log('get advdata:', await dongle.at_advdata())

        console.log('start:', await dongle.at_advstart({
            mode: AdvMode.CONNECTABLE_UNDIRECTED,
            intervalMs: 100,
            durationSec: 0
        }))

        console.log('advertising... press Ctrl+C to stop')

        process.on('SIGINT', async () => {
            await dongle.at_advstop()
            await dongle.close()
            process.exit(0)
        })

        await new Promise(() => { })
    }
    finally {
        await dongle.close()
    }
}

main().catch(err => {
    console.error(err)
    process.exit(1)
})