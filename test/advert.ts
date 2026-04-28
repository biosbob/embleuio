// test/advert.ts

import { BleuIO } from '../src/BleuIO'

async function main() {
    const dongle = await BleuIO.open('COM19')

    try {
        await dongle.ate(false)
        await dongle.at_peripheral()

        await dongle.at_devicename('BJ')

        await dongle.at_advstart({
            mode: 3,
            intervalMs: 20,
            durationSec: 0
        })

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